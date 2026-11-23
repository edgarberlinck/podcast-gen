import hashlib
import io
import json
from urllib.parse import urlsplit
from wsgiref.util import setup_testing_defaults

import pytest

from app import ApiError, Studio, create_app


@pytest.fixture
def client(tmp_path):
    return create_test_client(create_app(tmp_path))


def create_test_client(app):
    def request(method, path, body=None, content_type="application/json"):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else b""
        environ = {}
        setup_testing_defaults(environ)
        parsed = urlsplit(path)
        environ.update({"REQUEST_METHOD": method, "PATH_INFO": parsed.path, "QUERY_STRING": parsed.query,
                        "CONTENT_LENGTH": str(len(raw)), "CONTENT_TYPE": content_type, "wsgi.input": io.BytesIO(raw)})
        captured = {}

        def start_response(status, headers):
            captured["status"] = int(status.split()[0])
            captured["headers"] = dict(headers)

        response = b"".join(app(environ, start_response))
        if captured["headers"].get("Content-Type", "").startswith("application/json"):
            response = json.loads(response)
        return captured["status"], captured["headers"], response

    return request


def create_episode(client, **values):
    status, _, episode = client("POST", "/api/episodes", {
        "title": "First episode", "language": "pt", "original_article": "Original text", **values
    })
    assert status == 201
    return episode


@pytest.fixture
def generation_client(client):
    episode = create_episode(client, original_article="Source text")
    voice_status, _, voice = client("POST", "/api/voices", {
        "display_name": "Narrator", "fish_audio_id": "voice-001", "language": "pt",
        "availability": "available",
    })
    assert voice_status == 201
    client("PATCH", f"/api/episodes/{episode['id']}", {"selected_voice_id": voice["id"]})
    script = "[measured]An explicitly approved script."
    client("PUT", f"/api/episodes/{episode['id']}/scripts/fish-audio", {"content": script})
    status, _, approved = client("POST", f"/api/episodes/{episode['id']}/scripts/fish-audio-approval",
                                 {"content": script, "confirm_approval": True})
    assert status == 200 and approved["fish_audio_approved_sha256"] == hashlib.sha256(script.encode()).hexdigest()
    return approved, voice, script


def test_handoff_requires_exact_approved_script_and_available_selected_voice(client, generation_client):
    episode, voice, script = generation_client
    path = f"/api/episodes/{episode['id']}/generation-handoffs"
    assert client("POST", path, {})[2]["error"]["code"] == "confirmation_required"
    assert client("POST", path, {"confirm_handoff": True, "model": "other"})[2]["error"]["code"] == "unknown_fields"

    # Editing the script clears approval, so no handoff may be prepared.
    script_path = f"/api/episodes/{episode['id']}/scripts/fish-audio"
    client("PUT", script_path, {"content": script + " changed"})
    assert client("POST", path, {"confirm_handoff": True})[2]["error"]["code"] == "script_not_approved"
    client("PUT", script_path, {"content": script})
    client("POST", f"/api/episodes/{episode['id']}/scripts/fish-audio-approval",
           {"content": script, "confirm_approval": True})
    client("PATCH", f"/api/episodes/{episode['id']}", {"selected_voice_id": None})
    assert client("POST", path, {"confirm_handoff": True})[2]["error"]["code"] == "voice_not_selected"
    client("PATCH", f"/api/episodes/{episode['id']}", {"selected_voice_id": voice["id"]})

    status, _, result = client("POST", path, {"confirm_handoff": True})
    handoff = result["handoff"]
    assert status == 201
    assert handoff["script"] == script
    assert handoff["script_sha256"] == hashlib.sha256(script.encode()).hexdigest()
    assert handoff["fish_audio_id"] == "voice-001"
    assert handoff["voice_id"] == voice["id"]
    assert handoff["model"] == "drama-3"
    assert handoff["status"] == "prepared"
    assert "Codex" in handoff["instructions"]
    assert client("GET", path)[2]["handoffs"][0]["id"] == handoff["id"]


def test_codex_generation_quotes_before_charging_then_imports_result(tmp_path):
    class FakeCodexAudio:
        def __init__(self):
            self.quoted = []
            self.generated = []

        def quote(self, handoff):
            self.quoted.append(handoff)
            return {"estimated_credits": 36, "quote_summary": "36 credits for this script and voice."}

        def generate(self, handoff):
            self.generated.append(handoff)
            return b"ID3 generated audio", "audio/mpeg"

    provider = FakeCodexAudio()
    client = create_test_client(create_app(tmp_path, codex_audio_provider=provider))
    episode, voice, script = generation_client_from(client)
    handoff_path = f"/api/episodes/{episode['id']}/generation-handoffs"
    handoff = client("POST", handoff_path, {"confirm_handoff": True})[2]["handoff"]
    quote_path = f"{handoff_path}/{handoff['id']}/quote"
    assert client("POST", quote_path, {})[2]["error"]["code"] == "confirmation_required"
    assert client("POST", quote_path, {"confirm_quote": True})[0] == 202
    quoted = wait_for_generation(client, handoff_path, "quoted")
    assert quoted["estimated_credits"] == 36
    assert provider.quoted[0]["script"] == script
    assert provider.quoted[0]["fish_audio_id"] == voice["fish_audio_id"]
    assert client("POST", f"{handoff_path}/{handoff['id']}/generate", {})[2]["error"]["code"] == "confirmation_required"
    assert provider.generated == []
    assert client("POST", f"{handoff_path}/{handoff['id']}/generate",
                  {"confirm_generation": True})[0] == 202
    imported = wait_for_generation(client, handoff_path, "imported")
    assert imported["file_id"]
    assert provider.generated[0]["script"] == script
    files = client("GET", f"/api/episodes/{episode['id']}/files")[2]["files"]
    assert files[0]["id"] == imported["file_id"]
    assert files[0]["filename"] == "fish-audio-generation.mp3"
    assert files[0]["approval_status"] == "pending"
    assert client("GET", f"/api/files/{files[0]['id']}")[2] == b"ID3 generated audio"
    assert client("POST", quote_path, {"confirm_quote": True})[2]["error"]["code"] == "handoff_not_pending"


def generation_client_from(client):
    episode, voice, script = create_episode_for_client(client)
    return episode, voice, script


def create_episode_for_client(client):
    episode = create_episode(client, original_article="Source text")
    _, _, voice = client("POST", "/api/voices", {
        "display_name": "Narrator", "fish_audio_id": "voice-001", "language": "pt",
        "availability": "available",
    })
    client("PATCH", f"/api/episodes/{episode['id']}", {"selected_voice_id": voice["id"]})
    script = "[measured]An explicitly approved script."
    client("PUT", f"/api/episodes/{episode['id']}/scripts/fish-audio", {"content": script})
    client("POST", f"/api/episodes/{episode['id']}/scripts/fish-audio-approval",
           {"content": script, "confirm_approval": True})
    return episode, voice, script


def wait_for_generation(client, handoff_path, expected_status):
    import time

    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        run = client("GET", handoff_path)[2]["handoffs"][0]["generation_run"]
        if run and run["status"] in {expected_status, "failed"}:
            assert run["status"] == expected_status, run
            return run
        time.sleep(0.01)
    raise AssertionError(f"Generation did not reach {expected_status}")


def test_import_is_new_versioned_and_preserves_approved_audio_and_provenance(client, tmp_path, generation_client):
    episode, _, _ = generation_client
    episode_id = episode["id"]
    # Existing audio is retained byte-for-byte, including when marked approved.
    _, _, old_audio = client("POST", f"/api/episodes/{episode_id}/files?filename=old.mp3", b"old recording", "audio/mpeg")
    client("POST", f"/api/files/{old_audio['id']}/review", {"status": "approved", "confirm_review": True})
    _, _, prepared = client("POST", f"/api/episodes/{episode_id}/generation-handoffs", {"confirm_handoff": True})
    handoff = prepared["handoff"]
    import_path = f"/api/episodes/{episode_id}/generation-handoffs/{handoff['id']}/import?filename=take.mp3"
    status, _, imported = client("POST", import_path, b"new recording", "audio/mpeg")
    assert status == 201
    assert imported["generation_id"] != old_audio["generation_id"]
    assert imported["handoff_id"] == handoff["id"]
    assert imported["voice_id"] == handoff["voice_id"]
    assert imported["fish_audio_id"] == "voice-001"
    assert imported["model"] == "drama-3"
    assert imported["script_sha256"] == handoff["script_sha256"]
    assert imported["approval_status"] == "pending"
    assert (tmp_path / "episodes" / episode_id / "generations" / imported["generation_id"] / "result.json").exists()
    assert client("GET", f"/api/files/{old_audio['id']}")[2] == b"old recording"
    assert client("GET", f"/api/files/{imported['id']}")[2] == b"new recording"
    handoffs = client("GET", f"/api/episodes/{episode_id}/generation-handoffs")[2]["handoffs"]
    assert handoffs[0]["status"] == "imported"
    assert client("POST", import_path, b"duplicate", "audio/mpeg")[2]["error"]["code"] == "handoff_not_pending"
    assert len(client("GET", f"/api/episodes/{episode_id}/files")[2]["files"]) == 2


def test_failed_import_is_retryable_and_validation_does_not_change_handoff_status(client, generation_client):
    episode, _, _ = generation_client
    episode_id = episode["id"]
    handoff_id = client("POST", f"/api/episodes/{episode_id}/generation-handoffs",
                        {"confirm_handoff": True})[2]["handoff"]["id"]
    base = f"/api/episodes/{episode_id}/generation-handoffs/{handoff_id}/import?filename="
    assert client("POST", base + "bad.txt", b"x", "text/plain")[0] == 415
    assert client("POST", base + "empty.mp3", b"", "audio/mpeg")[2]["error"]["code"] == "empty_file"
    assert client("GET", f"/api/episodes/{episode_id}/generation-handoffs")[2]["handoffs"][0]["status"] == "prepared"
    status, _, record = client("POST", base + "retry.mp3", b"audio", "audio/mpeg")
    assert status == 201
    assert record["approval_status"] == "pending"


def test_interrupted_codex_job_is_not_retried_automatically(tmp_path):
    episode, _, _ = create_episode_for_client(create_test_client(create_app(tmp_path)))
    studio = Studio(tmp_path)
    handoff = studio.create_generation_handoff(episode["id"], {"confirm_handoff": True})
    studio.start_generation_quote(episode["id"], handoff["id"], {"confirm_quote": True})

    restarted = Studio(tmp_path)
    run = restarted.get_generation_run(handoff["id"])
    assert run["status"] == "failed"
    assert run["failure_code"] == "interrupted"
    with pytest.raises(ApiError, match="already has a quote"):
        restarted.start_generation_quote(episode["id"], handoff["id"], {"confirm_quote": True})


def test_failure_and_audio_review_are_explicit_and_never_delete_audio(client, generation_client):
    episode, _, _ = generation_client
    episode_id = episode["id"]
    handoff_id = client("POST", f"/api/episodes/{episode_id}/generation-handoffs",
                        {"confirm_handoff": True})[2]["handoff"]["id"]
    failure_path = f"/api/episodes/{episode_id}/generation-handoffs/{handoff_id}/failure"
    assert client("POST", failure_path, {"failure_code": "mcp_error"})[2]["error"]["code"] == "confirmation_required"
    assert client("POST", failure_path, {"confirm_failure": True, "failure_code": "raw-secret"})[0] == 400
    assert client("POST", failure_path, {"confirm_failure": True, "failure_code": []})[0] == 400
    status, _, failure = client("POST", failure_path, {"confirm_failure": True, "failure_code": "mcp_error"})
    assert status == 200 and failure["status"] == "failed" and failure["failure_code"] == "mcp_error"
    assert client("POST", failure_path, {"confirm_failure": True, "failure_code": "other"})[2]["error"]["code"] == "handoff_not_pending"

    another = client("POST", f"/api/episodes/{episode_id}/generation-handoffs",
                     {"confirm_handoff": True})[2]["handoff"]["id"]
    _, _, audio = client("POST", f"/api/episodes/{episode_id}/generation-handoffs/{another}/import?filename=review.mp3",
                         b"keep me", "audio/mpeg")
    review_path = f"/api/files/{audio['id']}/review"
    assert client("POST", review_path, {"status": "approved"})[2]["error"]["code"] == "confirmation_required"
    assert client("POST", review_path, {"status": "maybe", "confirm_review": True})[0] == 400
    assert client("POST", review_path, {"status": [], "confirm_review": True})[0] == 400
    assert client("POST", review_path, {"status": "approved", "confirm_review": True})[2]["approval_status"] == "approved"
    assert client("POST", review_path, {"status": "rejected", "confirm_review": True})[2]["approval_status"] == "rejected"
    assert client("GET", f"/api/files/{audio['id']}")[2] == b"keep me"


def test_existing_audio_library_receives_additive_handoff_metadata_migration(tmp_path):
    import sqlite3

    database = tmp_path / "studio.sqlite3"
    with sqlite3.connect(database) as db:
        db.execute("CREATE TABLE episodes (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL)")
        db.execute("""CREATE TABLE files (
            id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id),
            generation_id TEXT NOT NULL, filename TEXT NOT NULL, media_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL)""")
    Studio(tmp_path)
    with sqlite3.connect(database) as db:
        columns = {row[1] for row in db.execute("PRAGMA table_info(files)")}
    assert {"handoff_id", "voice_id", "fish_audio_id", "model", "script_sha256", "approval_status"} <= columns


def test_handoff_scope_and_voice_constraints(tmp_path):
    studio = Studio(tmp_path)
    first = studio.create_episode({"title": "First", "language": "pt"})
    second = studio.create_episode({"title": "Second", "language": "pt"})
    voice = studio.register_voice({"display_name": "Unavailable", "fish_audio_id": "v-unavailable",
                                   "language": "pt", "availability": "unavailable"})
    studio.update_episode(first["id"], {"selected_voice_id": voice["id"]})
    script = "Approved script"
    studio.update_script(first["id"], "fish-audio", {"content": script})
    studio.approve_fish_script(first["id"], {"content": script, "confirm_approval": True})
    with pytest.raises(ApiError, match="not marked available"):
        studio.create_generation_handoff(first["id"], {"confirm_handoff": True})
    with pytest.raises(ApiError, match="not found"):
        studio.fail_generation_handoff(second["id"], "not-a-uuid", {"confirm_failure": True, "failure_code": "other"})
