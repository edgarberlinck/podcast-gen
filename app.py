"""Local-first persistence and JSON API for the Código & Cicatriz studio."""

from __future__ import annotations

import hashlib
import json
import logging
import mimetypes
import os
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from pathlib import Path
from urllib.parse import parse_qs, unquote
from wsgiref.simple_server import make_server
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from codex_audio import MAX_VOICE_SAMPLE_BYTES, CodexAudioError, CodexFishAudio
from narration import SuggestionError, provider_from_environment, source_digest
from transistor import TransistorClient, TransistorError

LOG = logging.getLogger("codigo_cicatriz")
LANGUAGES = {"pt", "en"}
STATUSES = {
    "Draft", "Preparing Script", "Script Review", "Ready for Generation",
    "Generating Audio", "Audio Review", "Approved", "Publishing", "Published", "Failed",
}
VOICE_STATUSES = {"available", "unavailable", "unknown"}
VOICE_TYPES = {"external", "own", "other"}
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_FILE_BYTES = 500 * 1024 * 1024
ALLOWED_AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac"}
VOICE_SAMPLE_EXTENSIONS = {".mp3", ".wav", ".m4a", ".opus"}
FISH_AUDIO_MODEL = "drama-3"
FISH_AUDIO_MODEL_LABEL = "Fish Audio Drama 3"
HANDOFF_FAILURE_CODES = {"mcp_error", "cancelled", "output_unavailable", "other"}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def schedule_timezone_available(value: str) -> bool:
    if not value:
        return False
    try:
        ZoneInfo(value)
        return True
    except (KeyError, ValueError, ZoneInfoNotFoundError):
        return False


def validate_text(value, field: str, *, required=False, maximum=100_000) -> str:
    if not isinstance(value, str):
        raise ApiError(400, "invalid_field", f"{field} must be a string.")
    value = value.strip()
    if required and not value:
        raise ApiError(400, "invalid_field", f"{field} is required.")
    if len(value) > maximum:
        raise ApiError(400, "invalid_field", f"{field} must be at most {maximum} characters.")
    return value


def validate_content(value, field: str, *, maximum=100_000) -> str:
    """Validate manuscript text without normalizing meaningful whitespace."""
    if not isinstance(value, str):
        raise ApiError(400, "invalid_field", f"{field} must be a string.")
    if len(value) > maximum:
        raise ApiError(400, "invalid_field", f"{field} must be at most {maximum} characters.")
    return value


def safe_filename(filename: str) -> str:
    """Return a basename safe for local storage; reject paths and control chars."""
    if not isinstance(filename, str) or not filename or len(filename) > 180:
        raise ApiError(400, "invalid_filename", "A filename of 1–180 characters is required.")
    if filename != Path(filename).name or "/" in filename or "\\" in filename:
        raise ApiError(400, "invalid_filename", "Filename must not contain a directory path.")
    if any(ord(char) < 32 or ord(char) == 127 for char in filename) or filename in {".", ".."}:
        raise ApiError(400, "invalid_filename", "Filename contains unsupported characters.")
    return filename


class Studio:
    def __init__(self, data_dir: str | Path):
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.episodes_dir = self.data_dir / "episodes"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.episodes_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.data_dir / "studio.sqlite3"
        self._initialize()

    def connect(self):
        db = sqlite3.connect(self.db_path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        return db

    def _initialize(self):
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS episodes (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
                    language TEXT NOT NULL CHECK(language IN ('pt','en')),
                    status TEXT NOT NULL, original_article TEXT NOT NULL DEFAULT '',
                    narration_script TEXT NOT NULL DEFAULT '', fish_audio_script TEXT NOT NULL DEFAULT '',
                    fish_audio_approved_sha256 TEXT, fish_audio_approved_at TEXT,
                    selected_voice_id TEXT REFERENCES voices(id) ON DELETE SET NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS voices (
                    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, fish_audio_id TEXT NOT NULL UNIQUE,
                    language TEXT NOT NULL CHECK(language IN ('pt','en')), description TEXT NOT NULL DEFAULT '',
                    voice_type TEXT NOT NULL, availability TEXT NOT NULL,
                    fish_audio_visibility TEXT NOT NULL DEFAULT '', registered_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS article_revisions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
                    content TEXT NOT NULL, saved_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS files (
                    id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
                    generation_id TEXT NOT NULL, filename TEXT NOT NULL, media_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL,
                    handoff_id TEXT, voice_id TEXT, fish_audio_id TEXT, model TEXT,
                    script_sha256 TEXT, approval_status TEXT NOT NULL DEFAULT 'pending'
                );
                CREATE TABLE IF NOT EXISTS generation_handoffs (
                    id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
                    script TEXT NOT NULL, script_sha256 TEXT NOT NULL,
                    voice_id TEXT NOT NULL, fish_audio_id TEXT NOT NULL, voice_name TEXT NOT NULL,
                    model TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('prepared','imported','failed')),
                    failure_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS generation_runs (
                    id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL UNIQUE REFERENCES generation_handoffs(id) ON DELETE CASCADE,
                    status TEXT NOT NULL CHECK(status IN ('quoting','quoted','generating','imported','failed')),
                    estimated_credits REAL, quote_summary TEXT, file_id TEXT,
                    failure_code TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS voice_clone_jobs (
                    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, language TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '', transcript TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
                    fish_audio_id TEXT, voice_id TEXT, provider_state TEXT, visibility TEXT,
                    requested_visibility TEXT NOT NULL DEFAULT 'private',
                    error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS narration_suggestions (
                    id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
                    scope TEXT NOT NULL CHECK(scope IN ('article','paragraph')),
                    paragraph_index INTEGER, source_text TEXT NOT NULL, source_sha256 TEXT NOT NULL,
                    suggested_text TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
                    approval_status TEXT NOT NULL DEFAULT 'pending' CHECK(approval_status='pending'),
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS transistor_publications (
                    episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
                    file_id TEXT NOT NULL REFERENCES files(id), show_id TEXT NOT NULL,
                    remote_episode_id TEXT, status TEXT NOT NULL, published_at TEXT,
                    metadata_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_episodes_updated ON episodes(updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_suggestions_episode ON narration_suggestions(episode_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_files_episode ON files(episode_id, created_at DESC);
            """)
            file_columns = {row[1] for row in db.execute("PRAGMA table_info(files)")}
            voice_columns = {row[1] for row in db.execute("PRAGMA table_info(voices)")}
            if "fish_audio_visibility" not in voice_columns:
                db.execute("ALTER TABLE voices ADD COLUMN fish_audio_visibility TEXT NOT NULL DEFAULT ''")
            clone_job_columns = {row[1] for row in db.execute("PRAGMA table_info(voice_clone_jobs)")}
            if "requested_visibility" not in clone_job_columns:
                db.execute("ALTER TABLE voice_clone_jobs ADD COLUMN requested_visibility TEXT NOT NULL DEFAULT 'private'")
            for name, declaration in (
                ("handoff_id", "TEXT"), ("voice_id", "TEXT"), ("fish_audio_id", "TEXT"),
                ("model", "TEXT"), ("script_sha256", "TEXT"),
                ("approval_status", "TEXT NOT NULL DEFAULT 'pending'"),
            ):
                if name not in file_columns:
                    db.execute(f"ALTER TABLE files ADD COLUMN {name} {declaration}")
            db.execute("CREATE INDEX IF NOT EXISTS idx_handoffs_episode ON generation_handoffs(episode_id, created_at DESC)")
            db.execute("""UPDATE generation_runs SET status='failed',failure_code='interrupted',
                error_message='The server restarted during the Codex/Fish Audio request. Check Fish Audio history before retrying.',
                updated_at=? WHERE status IN ('quoting','generating')""", (now(),))
            db.execute("""UPDATE voice_clone_jobs SET status='failed',
                error_message='The server restarted during voice cloning. Check Fish Audio before retrying.',
                description='',transcript='',updated_at=? WHERE status IN ('queued','running')""", (now(),))
            columns = {row[1] for row in db.execute("PRAGMA table_info(episodes)")}
            if "fish_audio_approved_sha256" not in columns:
                db.execute("ALTER TABLE episodes ADD COLUMN fish_audio_approved_sha256 TEXT")
            if "fish_audio_approved_at" not in columns:
                db.execute("ALTER TABLE episodes ADD COLUMN fish_audio_approved_at TEXT")

    def _episode_dir(self, episode_id: str) -> Path:
        # IDs originate from the DB and are UUIDs; never use caller paths.
        try:
            canonical = str(uuid.UUID(episode_id))
        except (ValueError, AttributeError):
            raise ApiError(404, "not_found", "Episode not found.") from None
        path = self.episodes_dir / canonical
        if not path.is_dir():
            with self.connect() as db:
                exists = db.execute("SELECT 1 FROM episodes WHERE id=?", (canonical,)).fetchone()
            if not exists:
                raise ApiError(404, "not_found", "Episode not found.")
            path.mkdir(parents=True, exist_ok=True)
        return path

    @staticmethod
    def _episode_dict(row):
        return dict(row)

    def list_episodes(self):
        with self.connect() as db:
            rows = db.execute("SELECT * FROM episodes ORDER BY updated_at DESC").fetchall()
        return [self._episode_dict(row) for row in rows]

    def get_episode(self, episode_id):
        try:
            episode_id = str(uuid.UUID(episode_id))
        except (ValueError, AttributeError):
            raise ApiError(404, "not_found", "Episode not found.") from None
        with self.connect() as db:
            row = db.execute("SELECT * FROM episodes WHERE id=?", (episode_id,)).fetchone()
        if not row:
            raise ApiError(404, "not_found", "Episode not found.")
        return self._episode_dict(row)

    def create_episode(self, body):
        title = validate_text(body.get("title"), "title", required=True, maximum=300)
        description = validate_text(body.get("description", ""), "description", maximum=10_000)
        language = body.get("language", "pt")
        status = body.get("status", "Draft")
        original = validate_content(body.get("original_article", ""), "original_article")
        if not isinstance(language, str) or language not in LANGUAGES:
            raise ApiError(400, "invalid_language", "language must be 'pt' or 'en'.")
        if not isinstance(status, str) or status not in STATUSES:
            raise ApiError(400, "invalid_status", "Unsupported episode status.")
        episode_id, stamp = str(uuid.uuid4()), now()
        path = self.episodes_dir / episode_id
        path.mkdir()
        try:
            self._atomic_text(path / "original.md", original)
            self._atomic_text(path / "narration.md", "")
            self._atomic_text(path / "fish-audio-script.txt", "")
            with self.connect() as db:
                db.execute("""INSERT INTO episodes
                    (id,title,description,language,status,original_article,created_at,updated_at)
                    VALUES (?,?,?,?,?,?,?,?)""",
                    (episode_id,title,description,language,status,original,stamp,stamp))
        except Exception:
            import shutil
            shutil.rmtree(path, ignore_errors=True)
            raise
        LOG.info("Created episode %s", episode_id)
        return self.get_episode(episode_id)

    @staticmethod
    def _atomic_text(path: Path, content: str):
        temp = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
        temp.write_text(content, encoding="utf-8")
        os.replace(temp, path)

    def update_episode(self, episode_id, body):
        allowed = {"title", "description", "language", "status", "selected_voice_id"}
        unknown = set(body) - allowed
        if unknown:
            raise ApiError(400, "unknown_fields", "Unsupported episode fields: " + ", ".join(sorted(unknown)))
        episode = self.get_episode(episode_id)
        values = {}
        if "title" in body:
            values["title"] = validate_text(body["title"], "title", required=True, maximum=300)
        if "description" in body:
            values["description"] = validate_text(body["description"], "description", maximum=10_000)
        if "language" in body:
            if not isinstance(body["language"], str) or body["language"] not in LANGUAGES:
                raise ApiError(400, "invalid_language", "language must be 'pt' or 'en'.")
            values["language"] = body["language"]
        if "status" in body:
            if not isinstance(body["status"], str) or body["status"] not in STATUSES:
                raise ApiError(400, "invalid_status", "Unsupported episode status.")
            values["status"] = body["status"]
        if "selected_voice_id" in body:
            voice_id = body["selected_voice_id"]
            if voice_id is not None:
                self.get_voice(voice_id)
            values["selected_voice_id"] = voice_id
        if not values:
            return episode
        values["updated_at"] = now()
        assignments = ",".join(f"{key}=?" for key in values)
        with self.connect() as db:
            db.execute(f"UPDATE episodes SET {assignments} WHERE id=?", (*values.values(), episode["id"]))
        LOG.info("Updated episode %s fields=%s", episode["id"], ",".join(values))
        return self.get_episode(episode["id"])

    def update_original(self, episode_id, body):
        unknown = set(body) - {"content", "confirm_edit"}
        if unknown:
            raise ApiError(400, "unknown_fields", "Unsupported original-article fields: " + ", ".join(sorted(unknown)))
        if body.get("confirm_edit") is not True:
            raise ApiError(400, "confirmation_required", "Set confirm_edit=true to explicitly edit the original article.")
        content = validate_content(body.get("content"), "content")
        episode = self.get_episode(episode_id)
        stamp = now()
        with self.connect() as db:
            db.execute("INSERT INTO article_revisions(episode_id,content,saved_at) VALUES(?,?,?)",
                       (episode["id"], episode["original_article"], stamp))
            db.execute("UPDATE episodes SET original_article=?,updated_at=? WHERE id=?",
                       (content, stamp, episode["id"]))
        self._atomic_text(self._episode_dir(episode["id"]) / "original.md", content)
        LOG.info("Explicitly edited original article for episode %s", episode["id"])
        return self.get_episode(episode["id"])

    def update_script(self, episode_id, kind, body):
        unknown = set(body) - {"content"}
        if unknown:
            raise ApiError(400, "unknown_fields", "Unsupported script fields: " + ", ".join(sorted(unknown)))
        mapping = {"narration": ("narration_script", "narration.md"),
                   "fish-audio": ("fish_audio_script", "fish-audio-script.txt")}
        if kind not in mapping:
            raise ApiError(404, "not_found", "Script type not found.")
        content = validate_content(body.get("content"), "content")
        episode = self.get_episode(episode_id)
        column, filename = mapping[kind]
        stamp = now()
        self._atomic_text(self._episode_dir(episode["id"]) / filename, content)
        with self.connect() as db:
            if kind == "fish-audio":
                db.execute("""UPDATE episodes SET fish_audio_script=?, updated_at=?,
                    fish_audio_approved_sha256=CASE WHEN fish_audio_script != ? THEN NULL ELSE fish_audio_approved_sha256 END,
                    fish_audio_approved_at=CASE WHEN fish_audio_script != ? THEN NULL ELSE fish_audio_approved_at END
                    WHERE id=?""", (content, stamp, content, content, episode["id"]))
            else:
                db.execute(f"UPDATE episodes SET {column}=?,updated_at=? WHERE id=?", (content, stamp, episode["id"]))
        LOG.info("Updated %s script for episode %s", kind, episode["id"])
        return self.get_episode(episode["id"])

    def approve_fish_script(self, episode_id, body):
        unknown = set(body) - {"content", "confirm_approval"}
        if unknown:
            raise ApiError(400, "unknown_fields", "Unsupported script-approval fields: " + ", ".join(sorted(unknown)))
        if body.get("confirm_approval") is not True:
            raise ApiError(400, "confirmation_required", "Explicit confirmation is required to approve this Fish Audio script.")
        content = validate_content(body.get("content"), "content")
        if not content.strip():
            raise ApiError(400, "empty_script", "A saved Fish Audio script is required for approval.")
        episode = self.get_episode(episode_id)
        stamp = now()
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT fish_audio_script FROM episodes WHERE id=?", (episode["id"],)).fetchone()
            if row is None:
                raise ApiError(404, "not_found", "Episode not found.")
            if row["fish_audio_script"] != content:
                raise ApiError(409, "script_not_saved", "Save this exact Fish Audio script before approving it.")
            db.execute("UPDATE episodes SET fish_audio_approved_sha256=?,fish_audio_approved_at=?,updated_at=? WHERE id=?",
                       (digest, stamp, stamp, episode["id"]))
        LOG.info("Explicitly approved Fish Audio script version for episode %s", episode["id"])
        return self.get_episode(episode["id"])

    def create_generation_handoff(self, episode_id, body):
        if set(body) != {"confirm_handoff"} or body.get("confirm_handoff") is not True:
            if set(body) - {"confirm_handoff"}:
                raise ApiError(400, "unknown_fields", "Only confirm_handoff is accepted.")
            raise ApiError(400, "confirmation_required", "Set confirm_handoff=true to explicitly prepare a local Codex handoff.")
        episode = self.get_episode(episode_id)
        script = episode["fish_audio_script"]
        digest = hashlib.sha256(script.encode("utf-8")).hexdigest()
        if not script.strip() or episode["fish_audio_approved_sha256"] != digest:
            raise ApiError(409, "script_not_approved", "Approve the exact saved Fish Audio script before preparing a handoff.")
        voice_id = episode["selected_voice_id"]
        if not voice_id:
            raise ApiError(409, "voice_not_selected", "Select a registered voice before preparing a handoff.")
        voice = self.get_voice(voice_id)
        if voice["availability"] != "available":
            raise ApiError(409, "voice_unavailable", "The selected voice is not marked available in the local library.")
        if voice["language"] != episode["language"]:
            raise ApiError(409, "voice_language_mismatch", "The selected voice language does not match the episode language.")
        handoff_id, stamp = str(uuid.uuid4()), now()
        with self.connect() as db:
            db.execute("""INSERT INTO generation_handoffs
                (id,episode_id,script,script_sha256,voice_id,fish_audio_id,voice_name,model,status,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)""", (handoff_id, episode["id"], script, digest,
                    voice["id"], voice["fish_audio_id"], voice["display_name"], FISH_AUDIO_MODEL,
                    "prepared", stamp, stamp))
        LOG.info("Prepared local Fish Audio handoff %s for episode %s", handoff_id, episode["id"])
        return self.get_generation_handoff(handoff_id)

    def get_generation_handoff(self, handoff_id):
        try:
            handoff_id = str(uuid.UUID(handoff_id))
        except (ValueError, AttributeError):
            raise ApiError(404, "not_found", "Generation handoff not found.") from None
        with self.connect() as db:
            row = db.execute("SELECT * FROM generation_handoffs WHERE id=?", (handoff_id,)).fetchone()
        if row is None:
            raise ApiError(404, "not_found", "Generation handoff not found.")
        handoff = dict(row)
        handoff["generation_run"] = self.get_generation_run(handoff_id)
        return handoff

    def get_generation_run(self, handoff_id):
        with self.connect() as db:
            row = db.execute("SELECT * FROM generation_runs WHERE handoff_id=?", (handoff_id,)).fetchone()
        return dict(row) if row else None

    def start_generation_quote(self, episode_id, handoff_id, body):
        if set(body) != {"confirm_quote"} or body.get("confirm_quote") is not True:
            raise ApiError(400, "confirmation_required", "Confirm the Fish Audio quote request.")
        episode = self.get_episode(episode_id)
        handoff = self.get_generation_handoff(handoff_id)
        if handoff["episode_id"] != episode["id"] or handoff["status"] != "prepared":
            raise ApiError(409, "handoff_not_pending", "Only a prepared handoff can be quoted.")
        if handoff["generation_run"]:
            raise ApiError(409, "generation_already_started", "This handoff already has a quote or generation attempt.")
        stamp = now()
        with self.connect() as db:
            try:
                db.execute("INSERT INTO generation_runs (id,handoff_id,status,created_at,updated_at) VALUES(?,?,'quoting',?,?)",
                           (str(uuid.uuid4()), handoff_id, stamp, stamp))
            except sqlite3.IntegrityError:
                raise ApiError(409, "generation_already_started", "This handoff already has a quote or generation attempt.") from None
        return self.get_generation_run(handoff_id)

    def finish_generation_quote(self, handoff_id, quote):
        stamp = now()
        with self.connect() as db:
            updated = db.execute("""UPDATE generation_runs SET status='quoted',estimated_credits=?,quote_summary=?,updated_at=?
                WHERE handoff_id=? AND status='quoting'""",
                (quote["estimated_credits"], quote["quote_summary"], stamp, handoff_id))
        if updated.rowcount != 1:
            raise ApiError(409, "generation_not_pending", "The quote request is no longer pending.")
        return self.get_generation_run(handoff_id)

    def start_audio_generation(self, episode_id, handoff_id, body):
        if set(body) != {"confirm_generation"} or body.get("confirm_generation") is not True:
            raise ApiError(400, "confirmation_required", "Explicit confirmation is required to generate paid audio.")
        episode = self.get_episode(episode_id)
        handoff = self.get_generation_handoff(handoff_id)
        if handoff["episode_id"] != episode["id"] or handoff["status"] != "prepared":
            raise ApiError(409, "handoff_not_pending", "Only a prepared handoff can be generated.")
        if not handoff["generation_run"] or handoff["generation_run"]["status"] != "quoted":
            raise ApiError(409, "quote_required", "Obtain and review a Fish Audio quote before generating.")
        stamp = now()
        with self.connect() as db:
            updated = db.execute("UPDATE generation_runs SET status='generating',updated_at=? WHERE handoff_id=? AND status='quoted'",
                                 (stamp, handoff_id))
        if updated.rowcount != 1:
            raise ApiError(409, "generation_not_pending", "This quote has already been used.")
        return self.get_generation_run(handoff_id)

    def fail_audio_generation(self, handoff_id, failure_code, message):
        stamp = now()
        with self.connect() as db:
            db.execute("""UPDATE generation_runs SET status='failed',failure_code=?,error_message=?,updated_at=?
                WHERE handoff_id=? AND status IN ('quoting','generating')""",
                (failure_code, message[:500], stamp, handoff_id))
        return self.get_generation_run(handoff_id)

    def list_generation_handoffs(self, episode_id):
        episode = self.get_episode(episode_id)
        with self.connect() as db:
            handoffs = [dict(row) for row in db.execute(
                "SELECT * FROM generation_handoffs WHERE episode_id=? ORDER BY created_at DESC,id DESC",
                (episode["id"],)).fetchall()]
        for handoff in handoffs:
            handoff["generation_run"] = self.get_generation_run(handoff["id"])
        return handoffs

    def fail_generation_handoff(self, episode_id, handoff_id, body):
        allowed = {"confirm_failure", "failure_code"}
        if set(body) - allowed:
            raise ApiError(400, "unknown_fields", "Unsupported generation-failure fields.")
        if body.get("confirm_failure") is not True:
            raise ApiError(400, "confirmation_required", "Explicit confirmation is required to record a failed handoff.")
        code = body.get("failure_code")
        if not isinstance(code, str) or code not in HANDOFF_FAILURE_CODES:
            raise ApiError(400, "invalid_failure_code", "Choose a supported failure category.")
        episode = self.get_episode(episode_id)
        handoff = self.get_generation_handoff(handoff_id)
        if handoff["episode_id"] != episode["id"]:
            raise ApiError(404, "not_found", "Generation handoff not found.")
        if handoff["status"] != "prepared":
            raise ApiError(409, "handoff_not_pending", "Only a prepared handoff can be marked failed.")
        if handoff["generation_run"]:
            raise ApiError(409, "generation_already_started", "This handoff already has a quote or generation attempt.")
        stamp = now()
        with self.connect() as db:
            db.execute("UPDATE generation_handoffs SET status='failed',failure_code=?,updated_at=? WHERE id=? AND status='prepared'",
                       (code, stamp, handoff["id"]))
        return self.get_generation_handoff(handoff["id"])

    def create_narration_suggestion(self, episode_id, body, provider):
        allowed = {"scope", "paragraph_index"}
        unknown = set(body) - allowed
        if unknown:
            raise ApiError(400, "unknown_fields", "Unsupported narration-suggestion fields: " + ", ".join(sorted(unknown)))
        scope = body.get("scope")
        if not isinstance(scope, str) or scope not in {"article", "paragraph"}:
            raise ApiError(400, "invalid_scope", "scope must be 'article' or 'paragraph'.")
        if scope == "article" and "paragraph_index" in body:
            raise ApiError(400, "invalid_field", "paragraph_index is only valid for paragraph suggestions.")
        if scope == "paragraph":
            index = body.get("paragraph_index")
            if isinstance(index, bool) or not isinstance(index, int) or index < 0:
                raise ApiError(400, "invalid_field", "paragraph_index must be a non-negative zero-based integer.")
        else:
            index = None

        episode = self.get_episode(episode_id)
        original = episode["original_article"]
        if scope == "article":
            source = original
        else:
            paragraphs = re.split(r"\r?\n[ \t]*\r?\n", original)
            if index >= len(paragraphs) or not paragraphs[index].strip():
                raise ApiError(400, "invalid_field", "paragraph_index does not identify a non-empty paragraph.")
            source = paragraphs[index]
        if not source.strip():
            raise ApiError(400, "empty_source", "The original article has no text to prepare.")

        try:
            suggestion = provider.suggest(source, language=episode["language"], scope=scope)
            suggestion = validate_content(suggestion, "suggested_text")
            if not suggestion.strip():
                raise SuggestionError("LLM provider returned an empty suggestion.")
            provider_name = validate_text(provider.name, "provider", required=True, maximum=100)
            model = validate_text(provider.model, "model", required=True, maximum=200)
        except SuggestionError as exc:
            raise ApiError(502, "suggestion_provider_error", str(exc)) from None
        except ApiError:
            raise
        except Exception:
            # Provider exceptions may contain credentials or source text. Keep
            # the local log and public response free of exception details.
            LOG.error("Narration suggestion provider failed for episode %s", episode["id"])
            raise ApiError(502, "suggestion_provider_error", "Narration suggestion provider failed.") from None

        suggestion_id, stamp = str(uuid.uuid4()), now()
        record = {"id": suggestion_id, "episode_id": episode["id"], "scope": scope,
                  "paragraph_index": index, "source_text": source, "source_sha256": source_digest(source),
                  "suggested_text": suggestion, "provider": provider_name, "model": model,
                  "approval_status": "pending", "created_at": stamp}
        with self.connect() as db:
            db.execute("""INSERT INTO narration_suggestions
                (id,episode_id,scope,paragraph_index,source_text,source_sha256,suggested_text,provider,model,approval_status,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)""", tuple(record.values()))
        return record

    def list_narration_suggestions(self, episode_id):
        episode = self.get_episode(episode_id)
        with self.connect() as db:
            rows = db.execute("SELECT * FROM narration_suggestions WHERE episode_id=? ORDER BY created_at DESC,id DESC",
                              (episode["id"],)).fetchall()
        return [dict(row) for row in rows]

    def list_revisions(self, episode_id):
        episode = self.get_episode(episode_id)
        with self.connect() as db:
            return [dict(row) for row in db.execute(
                "SELECT id,content,saved_at FROM article_revisions WHERE episode_id=? ORDER BY id DESC",
                (episode["id"],)).fetchall()]

    def register_voice(self, body):
        name = validate_text(body.get("display_name"), "display_name", required=True, maximum=200)
        fish_id = validate_text(body.get("fish_audio_id"), "fish_audio_id", required=True, maximum=300)
        language = body.get("language")
        voice_type = body.get("voice_type", "external")
        availability = body.get("availability", "unknown")
        fish_visibility = body.get("fish_audio_visibility", "")
        description = validate_text(body.get("description", ""), "description", maximum=5000)
        if not isinstance(language, str) or language not in LANGUAGES:
            raise ApiError(400, "invalid_language", "language must be 'pt' or 'en'.")
        if not isinstance(voice_type, str) or voice_type not in VOICE_TYPES:
            raise ApiError(400, "invalid_voice_type", "voice_type must be external, own, or other.")
        if not isinstance(availability, str) or availability not in VOICE_STATUSES:
            raise ApiError(400, "invalid_availability", "availability must be available, unavailable, or unknown.")
        if not isinstance(fish_visibility, str) or fish_visibility not in {"", "private", "unlist", "public", "unknown"}:
            raise ApiError(400, "invalid_visibility", "fish_audio_visibility must be private, unlist, public, or unknown.")
        voice_id, stamp = str(uuid.uuid4()), now()
        try:
            with self.connect() as db:
                db.execute("""INSERT INTO voices
                    (id,display_name,fish_audio_id,language,description,voice_type,availability,fish_audio_visibility,registered_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?)""",
                    (voice_id,name,fish_id,language,description,voice_type,availability,fish_visibility,stamp,stamp))
        except sqlite3.IntegrityError as exc:
            raise ApiError(409, "duplicate_voice_id", "That Fish Audio voice identifier is already registered.") from exc
        LOG.info("Registered voice %s", voice_id)
        return self.get_voice(voice_id)

    def list_voices(self):
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM voices ORDER BY display_name COLLATE NOCASE").fetchall()]

    def create_voice_clone_job(self, body):
        display_name = validate_text(body.get("display_name"), "display_name", required=True, maximum=200)
        language = body.get("language")
        if not isinstance(language, str) or language not in LANGUAGES:
            raise ApiError(400, "invalid_language", "language must be 'pt' or 'en'.")
        visibility = body.get("visibility", "private")
        if not isinstance(visibility, str) or visibility not in {"private", "unlist", "public"}:
            raise ApiError(400, "invalid_visibility", "visibility must be private, unlist, or public.")
        description = validate_text(body.get("description", ""), "description", maximum=5000)
        job_id, stamp = str(uuid.uuid4()), now()
        with self.connect() as db:
            db.execute("""INSERT INTO voice_clone_jobs
                (id,display_name,language,description,status,requested_visibility,created_at,updated_at)
                VALUES(?,?,?,?,'queued',?,?,?)""",
                (job_id, display_name, language, description, visibility, stamp, stamp))
        return self.get_voice_clone_job(job_id)

    def get_voice_clone_job(self, job_id, *, include_private=False):
        try:
            job_id = str(uuid.UUID(job_id))
        except (ValueError, AttributeError):
            raise ApiError(404, "not_found", "Voice clone job not found.") from None
        with self.connect() as db:
            row = db.execute("SELECT * FROM voice_clone_jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise ApiError(404, "not_found", "Voice clone job not found.")
        record = dict(row)
        if not include_private:
            record.pop("description", None)
            record.pop("transcript", None)
        return record

    def start_voice_clone_job(self, job_id):
        self.get_voice_clone_job(job_id)
        with self.connect() as db:
            db.execute("UPDATE voice_clone_jobs SET status='running',updated_at=? WHERE id=? AND status='queued'",
                       (now(), job_id))

    def complete_voice_clone_job(self, job_id, clone):
        job = self.get_voice_clone_job(job_id, include_private=True)
        voice = self.register_voice({
            "display_name": job["display_name"],
            "fish_audio_id": clone["fish_audio_id"],
            "language": job["language"],
            "description": job["description"] or "Criada pelo estúdio usando Fish Audio MCP.",
            "voice_type": "own",
            "availability": "available",
            "fish_audio_visibility": clone["visibility"],
        })
        with self.connect() as db:
            db.execute("""UPDATE voice_clone_jobs SET status='completed',fish_audio_id=?,voice_id=?,
                provider_state=?,visibility=?,error_message=NULL,description='',transcript='',updated_at=? WHERE id=?""",
                (clone["fish_audio_id"], voice["id"], clone["state"], clone["visibility"], now(), job_id))
        return self.get_voice_clone_job(job_id)

    def fail_voice_clone_job(self, job_id, message):
        with self.connect() as db:
            db.execute("""UPDATE voice_clone_jobs SET status='failed',error_message=?,description='',transcript='',updated_at=?
                WHERE id=? AND status IN ('queued','running')""", (message[:1000], now(), job_id))

    def get_voice(self, voice_id):
        try:
            voice_id = str(uuid.UUID(voice_id))
        except (ValueError, AttributeError):
            raise ApiError(404, "not_found", "Voice not found.") from None
        with self.connect() as db:
            row = db.execute("SELECT * FROM voices WHERE id=?", (voice_id,)).fetchone()
        if row is None:
            raise ApiError(404, "not_found", "Voice not found.")
        return dict(row)

    def store_file(self, episode_id, filename, media_type, data: bytes, handoff_id=None, codex_generated=False):
        episode = self.get_episode(episode_id)
        handoff = None
        if handoff_id is not None:
            handoff = self.get_generation_handoff(handoff_id)
            if handoff["episode_id"] != episode["id"]:
                raise ApiError(404, "not_found", "Generation handoff not found for this episode.")
            if handoff["status"] != "prepared":
                raise ApiError(409, "handoff_not_pending", "This handoff is not awaiting an audio import.")
            if codex_generated and (
                not handoff["generation_run"] or handoff["generation_run"]["status"] != "generating"
            ):
                raise ApiError(409, "generation_not_pending", "This Codex generation is no longer pending.")
            if not codex_generated and handoff["generation_run"]:
                raise ApiError(409, "generation_already_started", "This handoff already has a quote or generation attempt.")
        filename = safe_filename(filename)
        ext = Path(filename).suffix.lower()
        media_type = media_type.split(";", 1)[0].strip().lower() or mimetypes.guess_type(filename)[0] or "application/octet-stream"
        if ext not in ALLOWED_AUDIO_EXTENSIONS or not re.fullmatch(r"audio/[a-z0-9.+-]+", media_type):
            raise ApiError(415, "unsupported_media", "Only audio files with a supported audio extension are accepted.")
        if not data:
            raise ApiError(400, "empty_file", "Audio file must not be empty.")
        if len(data) > MAX_FILE_BYTES:
            raise ApiError(413, "file_too_large", "Audio file exceeds the 500 MiB limit.")
        generation_id, file_id, stamp = str(uuid.uuid4()), str(uuid.uuid4()), now()
        target_dir = self._episode_dir(episode["id"]) / "generations" / generation_id
        target_dir.mkdir(parents=True)
        stored_name = "audio" + ext
        target = target_dir / stored_name
        temp = target.with_suffix(target.suffix + ".tmp")
        try:
            with temp.open("xb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temp, target)
            if handoff:
                handoff_metadata = {
                    "handoff_id": handoff["id"], "script_sha256": handoff["script_sha256"],
                    "voice_id": handoff["voice_id"], "fish_audio_id": handoff["fish_audio_id"],
                    "model": handoff["model"], "imported_at": stamp,
                }
                self._atomic_text(target_dir / "result.json", json.dumps(handoff_metadata, ensure_ascii=False, indent=2))
            with self.connect() as db:
                db.execute("""INSERT INTO files
                    (id,episode_id,generation_id,filename,media_type,size_bytes,created_at,handoff_id,
                     voice_id,fish_audio_id,model,script_sha256,approval_status)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (file_id, episode["id"], generation_id, filename, media_type, len(data), stamp,
                     handoff["id"] if handoff else None, handoff["voice_id"] if handoff else None,
                     handoff["fish_audio_id"] if handoff else None, handoff["model"] if handoff else None,
                     handoff["script_sha256"] if handoff else None, "pending"))
                if handoff:
                    updated = db.execute("UPDATE generation_handoffs SET status='imported',updated_at=? WHERE id=? AND status='prepared'",
                                         (stamp, handoff["id"]))
                    if updated.rowcount != 1:
                        raise ApiError(409, "handoff_not_pending", "This handoff is not awaiting an audio import.")
                    if codex_generated:
                        updated = db.execute("""UPDATE generation_runs SET status='imported',file_id=?,updated_at=?
                            WHERE handoff_id=? AND status='generating'""",
                            (file_id, stamp, handoff["id"]))
                        if updated.rowcount != 1:
                            raise ApiError(409, "generation_not_pending", "This Codex generation is no longer pending.")
                db.execute("UPDATE episodes SET updated_at=? WHERE id=?", (stamp, episode["id"]))
        except Exception:
            import shutil
            shutil.rmtree(target_dir, ignore_errors=True)
            raise
        return {"id": file_id, "episode_id": episode["id"], "generation_id": generation_id,
                "filename": filename, "media_type": media_type, "size_bytes": len(data), "created_at": stamp,
                "handoff_id": handoff["id"] if handoff else None,
                "voice_id": handoff["voice_id"] if handoff else None,
                "fish_audio_id": handoff["fish_audio_id"] if handoff else None,
                "model": handoff["model"] if handoff else None,
                "script_sha256": handoff["script_sha256"] if handoff else None,
                "approval_status": "pending"}

    def list_files(self, episode_id):
        episode = self.get_episode(episode_id)
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM files WHERE episode_id=? ORDER BY created_at DESC,id DESC",
                                                    (episode["id"],)).fetchall()]

    def get_transistor_publication(self, episode_id):
        episode = self.get_episode(episode_id)
        with self.connect() as db:
            row = db.execute("SELECT * FROM transistor_publications WHERE episode_id=?", (episode["id"],)).fetchone()
        if row is None:
            return None
        record = dict(row)
        metadata = json.loads(record.pop("metadata_json"))
        return {**record, **metadata}

    def _set_transistor_state(self, episode_id, status, *, remote_episode_id=None, published_at=None):
        with self.connect() as db:
            db.execute("""UPDATE transistor_publications SET status=?,
                remote_episode_id=COALESCE(?,remote_episode_id), published_at=?,updated_at=? WHERE episode_id=?""",
                (status, remote_episode_id, published_at, now(), episode_id))

    def create_transistor_draft(self, episode_id, body, client):
        allowed = {"file_id", "show_id", "summary", "keywords", "confirm_upload"}
        if set(body) - allowed:
            raise ApiError(400, "unknown_fields", "Unsupported Transistor draft fields.")
        if body.get("confirm_upload") is not True:
            raise ApiError(400, "confirmation_required", "Explicit confirmation is required to upload audio and create a Transistor draft.")
        file_id = body.get("file_id")
        show_id = validate_text(body.get("show_id"), "show_id", required=True, maximum=200)
        if not isinstance(file_id, str):
            raise ApiError(400, "invalid_field", "file_id must identify an approved local audio file.")
        episode = self.get_episode(episode_id)
        with self.connect() as db:
            file_row = db.execute("SELECT * FROM files WHERE id=? AND episode_id=?", (file_id, episode["id"])).fetchone()
        if file_row is None:
            raise ApiError(404, "not_found", "Audio file not found for this episode.")
        file_row = dict(file_row)
        if file_row["approval_status"] != "approved":
            raise ApiError(409, "audio_not_approved", "Only audio with explicit local approval can be uploaded to Transistor.")
        summary = validate_text(body.get("summary", episode["description"]), "summary", maximum=10_000)
        keywords = validate_text(body.get("keywords", ""), "keywords", maximum=2_000)
        try:
            show = client.get_show(show_id)
        except TransistorError as exc:
            status = 503 if exc.code == "not_configured" else 502
            raise ApiError(status, "transistor_" + exc.code, exc.message) from None
        if str(show.get("id")) != show_id:
            raise ApiError(502, "transistor_show_invalid", "Transistor returned a different show than the one selected.")
        show_time_zone = show.get("time_zone") if isinstance(show.get("time_zone"), str) else ""

        stamp = now()
        metadata = {"show_title": str(show.get("title", "")), "show_time_zone": show_time_zone,
                    "show_time_zone_supported": schedule_timezone_available(show_time_zone),
                    "title": episode["title"], "summary": summary, "description": episode["description"], "keywords": keywords}
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current = db.execute("SELECT * FROM transistor_publications WHERE episode_id=?", (episode["id"],)).fetchone()
            if current:
                if current["file_id"] != file_id or current["show_id"] != show_id or current["status"] != "upload_failed":
                    raise ApiError(409, "transistor_already_started", "A Transistor draft attempt already exists for this episode. Refresh its status; do not retry an uncertain create operation.")
                db.execute("UPDATE transistor_publications SET status='uploading',metadata_json=?,updated_at=? WHERE episode_id=?",
                           (json.dumps(metadata, ensure_ascii=False), stamp, episode["id"]))
            else:
                db.execute("""INSERT INTO transistor_publications
                    (episode_id,file_id,show_id,status,metadata_json,created_at,updated_at)
                    VALUES(?,?,?,'uploading',?,?,?)""", (episode["id"], file_id, show_id,
                    json.dumps(metadata, ensure_ascii=False), stamp, stamp))

        path = self._episode_dir(episode["id"]) / "generations" / file_row["generation_id"] / ("audio" + Path(file_row["filename"]).suffix.lower())
        try:
            authorization = client.authorize_upload(file_row["filename"])
            client.upload_audio(authorization["upload_url"], authorization["content_type"], path)
        except TransistorError as exc:
            self._set_transistor_state(episode["id"], "upload_failed")
            status = 503 if exc.code == "not_configured" else 502
            raise ApiError(status, "transistor_" + exc.code, exc.message) from None
        except OSError:
            self._set_transistor_state(episode["id"], "upload_failed")
            raise ApiError(500, "audio_unavailable", "The approved local audio file could not be read; it was not attached to a draft.") from None

        try:
            remote = client.create_draft(show_id, {"title": episode["title"], "description": episode["description"],
                                                   "summary": summary, "keywords": keywords}, authorization["audio_url"])
            remote_id = str(remote["id"])
            remote_status = remote.get("status") or "draft"
            if remote_status != "draft":
                raise TransistorError("unexpected_create_status", "Transistor returned an unexpected draft status.")
        except TransistorError:
            self._set_transistor_state(episode["id"], "creation_uncertain")
            raise ApiError(502, "transistor_creation_uncertain", "Transistor may have received the draft request. Refresh or inspect the account before any retry; this studio will not create a duplicate.") from None
        self._set_transistor_state(episode["id"], "draft", remote_episode_id=remote_id)
        return self.get_transistor_publication(episode["id"])

    def refresh_transistor_publication(self, episode_id, client):
        publication = self.get_transistor_publication(episode_id)
        if publication is None:
            raise ApiError(404, "transistor_not_started", "No Transistor draft is recorded for this episode.")
        if not publication.get("remote_episode_id"):
            raise ApiError(409, "transistor_manual_reconciliation", "No remote episode ID was confirmed. Inspect Transistor manually; automatic retry is disabled to prevent duplicates.")
        try:
            remote = client.get_episode(publication["remote_episode_id"])
        except TransistorError as exc:
            status = 503 if exc.code == "not_configured" else 502
            raise ApiError(status, "transistor_" + exc.code, exc.message) from None
        remote_status = remote.get("status")
        if remote_status not in {"draft", "scheduled", "published"}:
            raise ApiError(502, "transistor_status_invalid", "Transistor returned an unsupported episode status.")
        self._set_transistor_state(episode_id, remote_status, published_at=remote.get("published_at"))
        return self.get_transistor_publication(episode_id)

    def publish_transistor_episode(self, episode_id, body, client):
        allowed = {"status", "published_at", "confirm_publish"}
        if set(body) - allowed:
            raise ApiError(400, "unknown_fields", "Unsupported Transistor publication fields.")
        if body.get("confirm_publish") is not True:
            raise ApiError(400, "confirmation_required", "A separate explicit confirmation is required before publishing or scheduling.")
        status = body.get("status")
        if not isinstance(status, str) or status not in {"published", "scheduled"}:
            raise ApiError(400, "invalid_publication_status", "Choose published or scheduled.")
        publication = self.get_transistor_publication(episode_id)
        if publication is None or publication["status"] != "draft" or not publication.get("remote_episode_id"):
            raise ApiError(409, "transistor_draft_required", "Refresh a confirmed Transistor draft before publishing or scheduling it.")
        with self.connect() as db:
            approved = db.execute("SELECT approval_status FROM files WHERE id=? AND episode_id=?",
                                  (publication["file_id"], publication["episode_id"])).fetchone()
        if approved is None or approved["approval_status"] != "approved":
            raise ApiError(409, "audio_not_approved", "The selected local audio must remain explicitly approved before publication.")
        published_at = None
        if status == "scheduled":
            value = body.get("published_at")
            zone_name = publication.get("show_time_zone")
            if not isinstance(value, str) or not zone_name:
                raise ApiError(400, "invalid_schedule", "Choose a local publication date and time in the selected show's time zone.")
            try:
                from datetime import timedelta
                naive = datetime.strptime(value, "%Y-%m-%dT%H:%M")
                zone = ZoneInfo(zone_name)
                first, second = naive.replace(tzinfo=zone, fold=0), naive.replace(tzinfo=zone, fold=1)
                if first.utcoffset() != second.utcoffset():
                    raise ValueError("ambiguous local time")
                round_trip = first.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None)
                if round_trip != naive or first <= datetime.now(zone) + timedelta(seconds=30):
                    raise ValueError("invalid or past local time")
                published_at = first.isoformat()
            except (ValueError, KeyError, ZoneInfoNotFoundError):
                raise ApiError(400, "invalid_schedule", "The scheduled time must be a future, unambiguous local time in the selected show's time zone.") from None
        elif "published_at" in body and body["published_at"] not in (None, ""):
            raise ApiError(400, "invalid_schedule", "A publication date is only accepted for scheduled episodes.")

        # Read before the write to reconcile a previous request whose response may have been lost.
        try:
            remote = client.get_episode(publication["remote_episode_id"])
        except TransistorError as exc:
            status_code = 503 if exc.code == "not_configured" else 502
            raise ApiError(status_code, "transistor_" + exc.code, exc.message) from None
        if remote.get("status") != "draft":
            remote_status = remote.get("status")
            if remote_status in {"scheduled", "published"}:
                self._set_transistor_state(episode_id, remote_status, published_at=remote.get("published_at"))
            raise ApiError(409, "transistor_not_draft", "The Transistor episode is no longer a draft. Its current status was refreshed; no publication request was sent.")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current_file = db.execute("SELECT approval_status FROM files WHERE id=? AND episode_id=?",
                                      (publication["file_id"], publication["episode_id"])).fetchone()
            if current_file is None or current_file["approval_status"] != "approved":
                raise ApiError(409, "audio_not_approved", "The selected local audio must remain explicitly approved before publication.")
            claimed = db.execute("UPDATE transistor_publications SET status='publishing',updated_at=? WHERE episode_id=? AND status='draft'",
                                 (now(), publication["episode_id"]))
            if claimed.rowcount != 1:
                raise ApiError(409, "transistor_publish_in_progress", "A publication request is already in progress or awaiting status reconciliation.")
        try:
            result = client.publish(publication["remote_episode_id"], status, published_at)
        except TransistorError:
            self._set_transistor_state(episode_id, "publish_uncertain")
            raise ApiError(502, "transistor_publish_uncertain", "Transistor may have accepted the publication request. Refresh status before considering another action; this studio will not automatically retry.") from None
        resulting_status = result.get("status")
        if resulting_status not in {"published", "scheduled", "draft"}:
            self._set_transistor_state(episode_id, "publish_uncertain")
            raise ApiError(502, "transistor_publish_uncertain", "Transistor returned an unexpected status. Refresh before taking further action.")
        self._set_transistor_state(episode_id, resulting_status, published_at=result.get("published_at", published_at))
        return self.get_transistor_publication(episode_id)

    def review_file(self, file_id, body):
        if set(body) - {"status", "confirm_review"}:
            raise ApiError(400, "unknown_fields", "Unsupported audio-review fields.")
        status = body.get("status")
        if not isinstance(status, str) or status not in {"approved", "rejected"}:
            raise ApiError(400, "invalid_review_status", "Audio status must be approved or rejected.")
        if body.get("confirm_review") is not True:
            raise ApiError(400, "confirmation_required", "Explicit confirmation is required to review an audio version.")
        try:
            file_id = str(uuid.UUID(file_id))
        except (ValueError, AttributeError):
            raise ApiError(404, "not_found", "File not found.") from None
        with self.connect() as db:
            row = db.execute("SELECT id FROM files WHERE id=?", (file_id,)).fetchone()
            if row is None:
                raise ApiError(404, "not_found", "File not found.")
            db.execute("UPDATE files SET approval_status=? WHERE id=?", (status, file_id))
            return dict(db.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone())

    def read_file(self, file_id):
        try:
            file_id = str(uuid.UUID(file_id))
        except (ValueError, AttributeError):
            raise ApiError(404, "not_found", "File not found.") from None
        with self.connect() as db:
            row = db.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
        if not row:
            raise ApiError(404, "not_found", "File not found.")
        path = self._episode_dir(row["episode_id"]) / "generations" / row["generation_id"] / ("audio" + Path(row["filename"]).suffix.lower())
        try:
            data = path.read_bytes()
        except OSError as exc:
            LOG.exception("Stored file is missing: %s", file_id)
            raise ApiError(500, "file_unavailable", "The stored audio file is unavailable on disk.") from exc
        return dict(row), data

    def delete_episode(self, episode_id):
        episode = self.get_episode(episode_id)
        with self.connect() as db:
            if db.execute("SELECT 1 FROM transistor_publications WHERE episode_id=?", (episode["id"],)).fetchone():
                raise ApiError(409, "transistor_episode_linked", "This episode has a Transistor record. Resolve the remote draft/publication before deleting its local tracking data.")
            db.execute("DELETE FROM episodes WHERE id=?", (episode["id"],))
        import shutil
        shutil.rmtree(self._episode_dir(episode["id"]), ignore_errors=True)

    def dashboard(self):
        with self.connect() as db:
            total = db.execute("SELECT COUNT(*) FROM episodes").fetchone()[0]
            by_status = {row[0]: row[1] for row in db.execute("SELECT status,COUNT(*) FROM episodes GROUP BY status")}
            recent = [dict(row) for row in db.execute("SELECT id,title,status,language,updated_at FROM episodes ORDER BY updated_at DESC LIMIT 10")]
        return {"total_episodes": total, "draft_episodes": by_status.get("Draft", 0),
                "awaiting_review": by_status.get("Script Review", 0) + by_status.get("Audio Review", 0),
                "published_episodes": by_status.get("Published", 0), "by_status": by_status, "recent_episodes": recent}


def create_app(data_dir: str | Path | None = None, suggestion_provider=None, transistor_client=None,
               codex_audio_provider=None):
    """Return the WSGI app; integrations can be injected for deterministic tests."""
    studio = Studio(data_dir or os.environ.get("STUDIO_DATA_DIR", "data"))
    transistor = transistor_client if transistor_client is not None else TransistorClient()
    codex_audio = codex_audio_provider if codex_audio_provider is not None else CodexFishAudio()
    codex_job_lock = threading.Lock()

    def json_response(start_response, status, value, headers=()):
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        response_headers = [("Content-Type", "application/json; charset=utf-8"), ("Content-Length", str(len(payload))), *headers]
        start_response(f"{status} {HTTPStatus(status).phrase}", response_headers)
        return [payload]

    def static_response(start_response, asset):
        content_types = {"index.html": "text/html; charset=utf-8", "styles.css": "text/css; charset=utf-8",
                         "refresh.css": "text/css; charset=utf-8", "api.js": "text/javascript; charset=utf-8",
                         "app.js": "text/javascript; charset=utf-8"}
        payload = (Path(__file__).parent / "static" / asset).read_bytes()
        headers = [("Content-Type", content_types[asset]), ("Content-Length", str(len(payload))),
                   ("Cache-Control", "no-cache"), ("X-Content-Type-Options", "nosniff")]
        start_response(f"200 {HTTPStatus.OK.phrase}", headers)
        return [payload]

    def start_quote_worker(handoff_id):
        def work():
            try:
                quote = codex_audio.quote(studio.get_generation_handoff(handoff_id))
                studio.finish_generation_quote(handoff_id, quote)
            except CodexAudioError as exc:
                studio.fail_audio_generation(handoff_id, "codex_error", str(exc))
            except Exception:
                LOG.exception("Unexpected Fish Audio quote failure for handoff %s", handoff_id)
                studio.fail_audio_generation(handoff_id, "codex_error",
                                             "The Fish Audio quote failed unexpectedly. Check the Codex MCP connection.")
            finally:
                codex_job_lock.release()

        threading.Thread(target=work, name=f"fish-audio-quote-{handoff_id[:8]}", daemon=True).start()

    def start_generation_worker(episode_id, handoff_id):
        def work():
            try:
                handoff = studio.get_generation_handoff(handoff_id)
                audio, media_type = codex_audio.generate(handoff)
                studio.store_file(episode_id, "fish-audio-generation.mp3", media_type, audio,
                                  handoff_id=handoff_id, codex_generated=True)
            except CodexAudioError as exc:
                studio.fail_audio_generation(handoff_id, "codex_error", str(exc))
            except ApiError as exc:
                studio.fail_audio_generation(
                    handoff_id, "audio_import_error",
                    f"{exc.message} Check Fish Audio history before retrying; generation may have completed.",
                )
            except Exception:
                LOG.exception("Unexpected Fish Audio generation failure for handoff %s", handoff_id)
                studio.fail_audio_generation(handoff_id, "codex_error",
                                             "Audio generation failed unexpectedly. Check Fish Audio history before retrying.")
            finally:
                codex_job_lock.release()

        threading.Thread(target=work, name=f"fish-audio-generate-{handoff_id[:8]}", daemon=True).start()

    def start_voice_clone_worker(job_id, filename, sample):
        def work():
            try:
                studio.start_voice_clone_job(job_id)
                job = studio.get_voice_clone_job(job_id, include_private=True)
                clone = codex_audio.clone_voice(
                    sample, filename, display_name=job["display_name"],
                    visibility=job["requested_visibility"],
                )
                studio.complete_voice_clone_job(job_id, clone)
            except CodexAudioError as exc:
                studio.fail_voice_clone_job(job_id, str(exc))
            except ApiError as exc:
                studio.fail_voice_clone_job(job_id, exc.message)
            except Exception:
                LOG.exception("Unexpected Fish Audio voice clone failure for job %s", job_id)
                studio.fail_voice_clone_job(
                    job_id, "Voice cloning failed unexpectedly. Check the Codex MCP connection and Fish Audio history."
                )
            finally:
                codex_job_lock.release()

        threading.Thread(target=work, name=f"fish-audio-voice-clone-{job_id[:8]}", daemon=True).start()

    def app(environ, start_response):
        method = environ.get("REQUEST_METHOD", "GET").upper()
        path = unquote(environ.get("PATH_INFO", "/")).rstrip("/") or "/"
        try:
            if path == "/" and method == "GET":
                return static_response(start_response, "index.html")
            if path.startswith("/static/") and method == "GET":
                asset = path.removeprefix("/static/")
                if asset not in {"styles.css", "refresh.css", "api.js", "app.js"}:
                    return json_response(start_response, 404, {"error": {"code": "not_found", "message": "Asset not found."}})
                return static_response(start_response, asset)
            if path == "/health" and method == "GET":
                return json_response(start_response, 200, {"status": "ok"})
            if path == "/api/dashboard" and method == "GET":
                return json_response(start_response, 200, studio.dashboard())
            if path == "/api/episodes" and method == "GET":
                return json_response(start_response, 200, {"episodes": studio.list_episodes()})
            if path == "/api/episodes" and method == "POST":
                return json_response(start_response, 201, studio.create_episode(read_json(environ)))
            if path == "/api/voices" and method == "GET":
                return json_response(start_response, 200, {"voices": studio.list_voices()})
            if path == "/api/voices" and method == "POST":
                return json_response(start_response, 201, studio.register_voice(read_json(environ)))
            if path == "/api/voices/clone" and method == "POST":
                query = parse_qs(environ.get("QUERY_STRING", ""))
                if query.get("consent", [""])[0] != "true":
                    raise ApiError(400, "consent_required", "Confirm that you own this voice or have permission to clone it.")
                filename = safe_filename(query.get("filename", [""])[0])
                if Path(filename).suffix.lower() not in VOICE_SAMPLE_EXTENSIONS:
                    raise ApiError(415, "unsupported_media", "Voice samples must be WAV, MP3, M4A, or OPUS.")
                clone_details = {
                    "display_name": query.get("display_name", [""])[0],
                    "language": query.get("language", [""])[0],
                    "visibility": query.get("visibility", ["private"])[0],
                    "description": query.get("description", [""])[0],
                }
                if not codex_job_lock.acquire(blocking=False):
                    raise ApiError(409, "fish_audio_busy", "Another Fish Audio operation is already running.")
                try:
                    sample = read_body(
                        environ, MAX_VOICE_SAMPLE_BYTES, "file_too_large",
                        "Voice sample exceeds the 50 MiB limit.",
                    )
                    if not sample:
                        raise ApiError(400, "empty_file", "Voice sample must not be empty.")
                    job = studio.create_voice_clone_job(clone_details)
                    start_voice_clone_worker(job["id"], filename, sample)
                except Exception:
                    codex_job_lock.release()
                    raise
                return json_response(start_response, 202, {"job": job})
            if path.startswith("/api/voice-clone-jobs/") and method == "GET":
                job_id = path.removeprefix("/api/voice-clone-jobs/")
                return json_response(start_response, 200, {"job": studio.get_voice_clone_job(job_id)})
            if path == "/api/transistor/shows" and method == "GET":
                try:
                    return json_response(start_response, 200, {"shows": transistor.list_shows()})
                except TransistorError as exc:
                    status = 503 if exc.code == "not_configured" else 502
                    raise ApiError(status, "transistor_" + exc.code, exc.message) from None

            parts = [part for part in path.split("/") if part]
            if len(parts) >= 3 and parts[:2] == ["api", "episodes"]:
                episode_id = parts[2]
                if len(parts) == 3 and method == "GET":
                    return json_response(start_response, 200, studio.get_episode(episode_id))
                if len(parts) == 3 and method in {"PATCH", "PUT"}:
                    return json_response(start_response, 200, studio.update_episode(episode_id, read_json(environ)))
                if len(parts) == 3 and method == "DELETE":
                    studio.delete_episode(episode_id)
                    return json_response(start_response, 200, {"deleted": True})
                if len(parts) == 4 and parts[3] == "original" and method == "PUT":
                    return json_response(start_response, 200, studio.update_original(episode_id, read_json(environ)))
                if len(parts) == 4 and parts[3] == "original" and method == "GET":
                    return json_response(start_response, 200, {"content": studio.get_episode(episode_id)["original_article"]})
                if len(parts) == 4 and parts[3] == "revisions" and method == "GET":
                    return json_response(start_response, 200, {"revisions": studio.list_revisions(episode_id)})
                if len(parts) == 4 and parts[3] == "narration-suggestions" and method == "GET":
                    return json_response(start_response, 200,
                                         {"suggestions": studio.list_narration_suggestions(episode_id)})
                if len(parts) == 4 and parts[3] == "narration-suggestions" and method == "POST":
                    try:
                        provider = suggestion_provider if suggestion_provider is not None else provider_from_environment()
                    except SuggestionError as exc:
                        raise ApiError(503, "suggestion_provider_unavailable", str(exc)) from None
                    if provider is None:
                        raise ApiError(503, "suggestion_provider_unavailable",
                                       "Configure LLM_API_KEY on the local server to enable narration suggestions.")
                    record = studio.create_narration_suggestion(episode_id, read_json(environ), provider)
                    return json_response(start_response, 201, {"suggestion": record})
                if len(parts) == 5 and parts[3] == "scripts" and parts[4] == "fish-audio-approval" and method == "POST":
                    return json_response(start_response, 200, studio.approve_fish_script(episode_id, read_json(environ)))
                if len(parts) == 5 and parts[3] == "scripts" and method == "PUT":
                    return json_response(start_response, 200, studio.update_script(episode_id, parts[4], read_json(environ)))
                if len(parts) == 4 and parts[3] == "generation-handoffs" and method == "GET":
                    return json_response(start_response, 200, {"handoffs": studio.list_generation_handoffs(episode_id)})
                if len(parts) == 4 and parts[3] == "generation-handoffs" and method == "POST":
                    handoff = studio.create_generation_handoff(episode_id, read_json(environ))
                    handoff["model_preference"] = {"label": FISH_AUDIO_MODEL_LABEL, "identifier": FISH_AUDIO_MODEL}
                    handoff["instructions"] = (
                        "A Codex agent will request a Fish Audio quote, then generate only after your explicit confirmation."
                    )
                    return json_response(start_response, 201, {"handoff": handoff})
                if (len(parts) == 6 and parts[3] == "generation-handoffs"
                        and parts[5] == "quote" and method == "POST"):
                    if not codex_job_lock.acquire(blocking=False):
                        raise ApiError(409, "codex_busy", "Another Codex/Fish Audio task is already running.")
                    started = False
                    try:
                        run = studio.start_generation_quote(episode_id, parts[4], read_json(environ))
                        start_quote_worker(parts[4])
                        started = True
                    finally:
                        if not started:
                            codex_job_lock.release()
                    return json_response(start_response, 202, {"generation_run": run})
                if (len(parts) == 6 and parts[3] == "generation-handoffs"
                        and parts[5] == "generate" and method == "POST"):
                    if not codex_job_lock.acquire(blocking=False):
                        raise ApiError(409, "codex_busy", "Another Codex/Fish Audio task is already running.")
                    started = False
                    try:
                        run = studio.start_audio_generation(episode_id, parts[4], read_json(environ))
                        start_generation_worker(episode_id, parts[4])
                        started = True
                    finally:
                        if not started:
                            codex_job_lock.release()
                    return json_response(start_response, 202, {"generation_run": run})
                if len(parts) == 6 and parts[3] == "generation-handoffs" and parts[5] == "import" and method == "POST":
                    query = parse_qs(environ.get("QUERY_STRING", ""))
                    filename = query.get("filename", [None])[0]
                    body = read_body(environ, MAX_FILE_BYTES, "file_too_large",
                                     "Audio file exceeds the 500 MiB limit.")
                    record = studio.store_file(episode_id, filename, environ.get("CONTENT_TYPE", ""), body,
                                               handoff_id=parts[4])
                    return json_response(start_response, 201, record)
                if len(parts) == 6 and parts[3] == "generation-handoffs" and parts[5] == "failure" and method == "POST":
                    return json_response(start_response, 200,
                                         studio.fail_generation_handoff(episode_id, parts[4], read_json(environ)))
                if len(parts) == 4 and parts[3] == "files" and method == "GET":
                    return json_response(start_response, 200, {"files": studio.list_files(episode_id)})
                if len(parts) == 4 and parts[3] == "files" and method == "POST":
                    query = parse_qs(environ.get("QUERY_STRING", ""))
                    filename = query.get("filename", [None])[0]
                    body = read_body(environ, MAX_FILE_BYTES, "file_too_large",
                                     "Audio file exceeds the 500 MiB limit.")
                    file = studio.store_file(episode_id, filename, environ.get("CONTENT_TYPE", ""), body)
                    return json_response(start_response, 201, file)
                if len(parts) == 4 and parts[3] == "transistor" and method == "GET":
                    return json_response(start_response, 200, {"publication": studio.get_transistor_publication(episode_id)})
                if len(parts) == 5 and parts[3] == "transistor" and parts[4] == "draft" and method == "POST":
                    return json_response(start_response, 201, {"publication": studio.create_transistor_draft(
                        episode_id, read_json(environ), transistor)})
                if len(parts) == 5 and parts[3] == "transistor" and parts[4] == "refresh" and method == "POST":
                    return json_response(start_response, 200, {"publication": studio.refresh_transistor_publication(
                        episode_id, transistor)})
                if len(parts) == 5 and parts[3] == "transistor" and parts[4] == "publish" and method == "POST":
                    return json_response(start_response, 200, {"publication": studio.publish_transistor_episode(
                        episode_id, read_json(environ), transistor)})
            if len(parts) == 3 and parts[:2] == ["api", "voices"] and method == "GET":
                return json_response(start_response, 200, studio.get_voice(parts[2]))
            if len(parts) == 4 and parts[:2] == ["api", "files"] and parts[3] == "review" and method == "POST":
                return json_response(start_response, 200, studio.review_file(parts[2], read_json(environ)))
            if len(parts) == 3 and parts[:2] == ["api", "files"] and method == "GET":
                record, data = studio.read_file(parts[2])
                filename = record["filename"].replace('"', "")
                start_response("200 OK", [("Content-Type", record["media_type"]), ("Content-Length", str(len(data))),
                                           ("Content-Disposition", f'attachment; filename="{filename}"'),
                                           ("X-Content-Type-Options", "nosniff")])
                return [data]
            return json_response(start_response, 404, {"error": {"code": "not_found", "message": "Route not found."}})
        except ApiError as exc:
            return json_response(start_response, exc.status, {"error": {"code": exc.code, "message": exc.message}})
        except (json.JSONDecodeError, UnicodeDecodeError):
            return json_response(start_response, 400, {"error": {"code": "invalid_json", "message": "Request body must be valid UTF-8 JSON."}})
        except Exception:
            LOG.exception("Unhandled request error method=%s path=%s", method, path)
            return json_response(start_response, 500, {"error": {"code": "internal_error", "message": "An unexpected local server error occurred."}})

    return app


def read_body(environ, maximum: int, too_large_code: str, too_large_message: str) -> bytes:
    """Read only the declared WSGI body, never an unbounded or negative size."""
    length = environ.get("CONTENT_LENGTH")
    # WSGI permits an absent/empty length, meaning no readable request body.
    if length is None or length == "":
        length = "0"
    if not isinstance(length, str) or re.fullmatch(r"[0-9]+", length) is None:
        raise ApiError(400, "invalid_length", "Content-Length must be a non-negative decimal integer.")
    try:
        size = int(length)
    except ValueError:
        raise ApiError(400, "invalid_length", "Invalid Content-Length.") from None
    if size > maximum:
        raise ApiError(413, too_large_code, too_large_message)
    chunks = []
    remaining = size
    while remaining:
        chunk = environ["wsgi.input"].read(min(remaining, 64 * 1024))
        if not chunk:
            raise ApiError(400, "invalid_length", "Request body is shorter than Content-Length.")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_json(environ):
    raw = read_body(environ, MAX_JSON_BYTES, "request_too_large", "JSON request exceeds the 2 MiB limit.")
    if not raw:
        return {}
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise ApiError(400, "invalid_json", "JSON request body must be an object.")
    return value


def main():
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    host = os.environ.get("STUDIO_HOST", "127.0.0.1")
    port = int(os.environ.get("STUDIO_PORT", "8000"))
    app = create_app()
    LOG.info("Studio API listening on http://%s:%s", host, port)
    with make_server(host, port, app) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
