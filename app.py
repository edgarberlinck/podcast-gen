"""Local-first persistence and JSON API for the Código & Cicatriz studio."""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from pathlib import Path
from urllib.parse import parse_qs, unquote
from wsgiref.simple_server import make_server

from narration import SuggestionError, provider_from_environment, source_digest

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


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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
                    selected_voice_id TEXT REFERENCES voices(id) ON DELETE SET NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS voices (
                    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, fish_audio_id TEXT NOT NULL UNIQUE,
                    language TEXT NOT NULL CHECK(language IN ('pt','en')), description TEXT NOT NULL DEFAULT '',
                    voice_type TEXT NOT NULL, availability TEXT NOT NULL, registered_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS article_revisions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
                    content TEXT NOT NULL, saved_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS files (
                    id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
                    generation_id TEXT NOT NULL, filename TEXT NOT NULL, media_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS narration_suggestions (
                    id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
                    scope TEXT NOT NULL CHECK(scope IN ('article','paragraph')),
                    paragraph_index INTEGER, source_text TEXT NOT NULL, source_sha256 TEXT NOT NULL,
                    suggested_text TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
                    approval_status TEXT NOT NULL DEFAULT 'pending' CHECK(approval_status='pending'),
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_episodes_updated ON episodes(updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_suggestions_episode ON narration_suggestions(episode_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_files_episode ON files(episode_id, created_at DESC);
            """)

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
            db.execute(f"UPDATE episodes SET {column}=?,updated_at=? WHERE id=?", (content, stamp, episode["id"]))
        LOG.info("Updated %s script for episode %s", kind, episode["id"])
        return self.get_episode(episode["id"])

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
            paragraphs = re.split(r"\n[ \t]*\n", original)
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
            LOG.exception("Narration suggestion provider failed")
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
        description = validate_text(body.get("description", ""), "description", maximum=5000)
        if not isinstance(language, str) or language not in LANGUAGES:
            raise ApiError(400, "invalid_language", "language must be 'pt' or 'en'.")
        if not isinstance(voice_type, str) or voice_type not in VOICE_TYPES:
            raise ApiError(400, "invalid_voice_type", "voice_type must be external, own, or other.")
        if not isinstance(availability, str) or availability not in VOICE_STATUSES:
            raise ApiError(400, "invalid_availability", "availability must be available, unavailable, or unknown.")
        voice_id, stamp = str(uuid.uuid4()), now()
        try:
            with self.connect() as db:
                db.execute("""INSERT INTO voices
                    (id,display_name,fish_audio_id,language,description,voice_type,availability,registered_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?)""",
                    (voice_id,name,fish_id,language,description,voice_type,availability,stamp,stamp))
        except sqlite3.IntegrityError as exc:
            raise ApiError(409, "duplicate_voice_id", "That Fish Audio voice identifier is already registered.") from exc
        LOG.info("Registered voice %s", voice_id)
        return self.get_voice(voice_id)

    def list_voices(self):
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM voices ORDER BY display_name COLLATE NOCASE").fetchall()]

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

    def store_file(self, episode_id, filename, media_type, data: bytes):
        episode = self.get_episode(episode_id)
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
            with self.connect() as db:
                db.execute("INSERT INTO files VALUES(?,?,?,?,?,?,?)",
                           (file_id, episode["id"], generation_id, filename, media_type, len(data), stamp))
                db.execute("UPDATE episodes SET updated_at=? WHERE id=?", (stamp, episode["id"]))
        except Exception:
            import shutil
            shutil.rmtree(target_dir, ignore_errors=True)
            raise
        return {"id": file_id, "episode_id": episode["id"], "generation_id": generation_id,
                "filename": filename, "media_type": media_type, "size_bytes": len(data), "created_at": stamp}

    def list_files(self, episode_id):
        episode = self.get_episode(episode_id)
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM files WHERE episode_id=? ORDER BY created_at DESC",
                                                    (episode["id"],)).fetchall()]

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


def create_app(data_dir: str | Path | None = None, suggestion_provider=None):
    """Return the WSGI app; optionally inject a provider for deterministic tests."""
    studio = Studio(data_dir or os.environ.get("STUDIO_DATA_DIR", "data"))

    def json_response(start_response, status, value, headers=()):
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        response_headers = [("Content-Type", "application/json; charset=utf-8"), ("Content-Length", str(len(payload))), *headers]
        start_response(f"{status} {HTTPStatus(status).phrase}", response_headers)
        return [payload]

    def static_response(start_response, asset):
        content_types = {"index.html": "text/html; charset=utf-8", "styles.css": "text/css; charset=utf-8",
                         "api.js": "text/javascript; charset=utf-8", "app.js": "text/javascript; charset=utf-8"}
        payload = (Path(__file__).parent / "static" / asset).read_bytes()
        headers = [("Content-Type", content_types[asset]), ("Content-Length", str(len(payload))),
                   ("Cache-Control", "no-cache"), ("X-Content-Type-Options", "nosniff")]
        start_response(f"200 {HTTPStatus.OK.phrase}", headers)
        return [payload]

    def app(environ, start_response):
        method = environ.get("REQUEST_METHOD", "GET").upper()
        path = unquote(environ.get("PATH_INFO", "/")).rstrip("/") or "/"
        try:
            if path == "/" and method == "GET":
                return static_response(start_response, "index.html")
            if path.startswith("/static/") and method == "GET":
                asset = path.removeprefix("/static/")
                if asset not in {"styles.css", "api.js", "app.js"}:
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
                if len(parts) == 5 and parts[3] == "scripts" and method == "PUT":
                    return json_response(start_response, 200, studio.update_script(episode_id, parts[4], read_json(environ)))
                if len(parts) == 4 and parts[3] == "files" and method == "GET":
                    return json_response(start_response, 200, {"files": studio.list_files(episode_id)})
                if len(parts) == 4 and parts[3] == "files" and method == "POST":
                    query = parse_qs(environ.get("QUERY_STRING", ""))
                    filename = query.get("filename", [None])[0]
                    body = read_body(environ, MAX_FILE_BYTES, "file_too_large",
                                     "Audio file exceeds the 500 MiB limit.")
                    file = studio.store_file(episode_id, filename, environ.get("CONTENT_TYPE", ""), body)
                    return json_response(start_response, 201, file)
            if len(parts) == 3 and parts[:2] == ["api", "voices"] and method == "GET":
                return json_response(start_response, 200, studio.get_voice(parts[2]))
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
