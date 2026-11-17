import io
import json
from urllib.parse import urlsplit
from wsgiref.util import setup_testing_defaults

import pytest

from app import ApiError, Studio, create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path)

    def request(method, path, body=None, content_type="application/json"):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else b""
        environ = {}
        setup_testing_defaults(environ)
        parsed = urlsplit(path)
        environ.update({"REQUEST_METHOD": method, "PATH_INFO": parsed.path, "QUERY_STRING": parsed.query,
                        "CONTENT_LENGTH": str(len(raw)), "CONTENT_TYPE": content_type,
                        "wsgi.input": io.BytesIO(raw)})
        captured = {}

        def start_response(status, headers):
            captured["status"] = int(status.split()[0])
            captured["headers"] = dict(headers)

        data = b"".join(app(environ, start_response))
        if captured["headers"].get("Content-Type", "").startswith("application/json"):
            data = json.loads(data)
        return captured["status"], captured["headers"], data

    return request


def create_episode(client, **values):
    status, _, episode = client("POST", "/api/episodes", {
        "title": "First episode", "language": "pt", "original_article": "Original text", **values
    })
    assert status == 201
    return episode


def test_create_episode_and_restart_persist_independent_content(client, tmp_path):
    episode = create_episode(client, description="A description")
    episode_id = episode["id"]
    assert episode["status"] == "Draft"
    assert episode["original_article"] == "Original text"
    assert (tmp_path / "episodes" / episode_id / "original.md").read_text() == "Original text"
    assert client("PUT", f"/api/episodes/{episode_id}/scripts/narration", {"content": "  Narrated\n"})[0] == 200
    assert client("PUT", f"/api/episodes/{episode_id}/scripts/fish-audio", {"content": "Tagged"})[0] == 200
    restarted = create_app(tmp_path)
    status, _, restored = request_app(restarted, "GET", f"/api/episodes/{episode_id}")
    assert status == 200
    assert restored["original_article"] == "Original text"
    assert restored["narration_script"] == "  Narrated\n"
    assert restored["fish_audio_script"] == "Tagged"


def request_app(app, method, path, body=None, content_type="application/json"):
    raw = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else b""
    environ = {}
    setup_testing_defaults(environ)
    environ.update({"REQUEST_METHOD": method, "PATH_INFO": path, "CONTENT_LENGTH": str(len(raw)),
                    "CONTENT_TYPE": content_type, "wsgi.input": io.BytesIO(raw)})
    result = {}

    def start_response(status, headers):
        result["status"] = int(status.split()[0])
        result["headers"] = dict(headers)

    response = b"".join(app(environ, start_response))
    if result["headers"].get("Content-Type", "").startswith("application/json"):
        response = json.loads(response)
    return result["status"], result["headers"], response


def test_original_requires_explicit_confirmation_and_preserves_revision(client):
    episode = create_episode(client)
    path = f"/api/episodes/{episode['id']}/original"
    assert client("PUT", path, {"content": "changed"})[2]["error"]["code"] == "confirmation_required"
    exact_text = "  Explicit new text\n\n"
    status, _, updated = client("PUT", path, {"content": exact_text, "confirm_edit": True})
    assert status == 200
    assert updated["original_article"] == exact_text
    assert client("GET", f"/api/episodes/{episode['id']}/original")[2]["content"] == exact_text
    assert client("PUT", path, {"content": "ignored", "confirm_edit": True, "narration": "no"})[2]["error"]["code"] == "unknown_fields"
    assert client("GET", f"/api/episodes/{episode['id']}/revisions")[2]["revisions"][0]["content"] == "Original text"


def test_scripts_cannot_write_original_field(client):
    episode = create_episode(client)
    status, _, error = client("PUT", f"/api/episodes/{episode['id']}/scripts/narration",
                              {"content": "new narration", "original_article": "malicious overwrite"})
    assert status == 400
    assert error["error"]["code"] == "unknown_fields"
    assert client("GET", f"/api/episodes/{episode['id']}")[2]["original_article"] == "Original text"
    assert client("PATCH", f"/api/episodes/{episode['id']}", {"original_article": "overwrite"})[2]["error"]["code"] == "unknown_fields"


def test_create_and_update_validation_errors(client):
    assert client("POST", "/api/episodes", {"title": "", "language": "pt"})[0] == 400
    assert client("POST", "/api/episodes", {"title": "Title", "language": "fr"})[2]["error"]["code"] == "invalid_language"
    episode = create_episode(client)
    assert client("PATCH", f"/api/episodes/{episode['id']}", {"status": "Not real"})[2]["error"]["code"] == "invalid_status"
    assert client("PATCH", f"/api/episodes/{episode['id']}", {"unexpected": 1})[2]["error"]["code"] == "unknown_fields"
    assert client("GET", "/api/episodes/not-a-uuid")[0] == 404
    assert client("GET", "/missing")[0] == 404


def test_episode_status_language_voice_selection_and_dashboard(client):
    voice_status, _, voice = client("POST", "/api/voices", {
        "display_name": "Lia", "fish_audio_id": "fish-123", "language": "pt",
        "description": "Warm", "voice_type": "external", "availability": "available"
    })
    assert voice_status == 201
    episode = create_episode(client, language="en")
    status, _, updated = client("PATCH", f"/api/episodes/{episode['id']}",
                                {"status": "Script Review", "selected_voice_id": voice["id"]})
    assert status == 200
    assert updated["language"] == "en"
    assert updated["selected_voice_id"] == voice["id"]
    dashboard = client("GET", "/api/dashboard")[2]
    assert dashboard["total_episodes"] == 1
    assert dashboard["awaiting_review"] == 1
    assert client("GET", "/api/voices")[2]["voices"][0]["fish_audio_id"] == "fish-123"
    assert client("GET", f"/api/voices/{voice['id']}")[0] == 200


def test_voice_validation_duplicate_and_unknown_reference(client):
    voice_body = {"display_name": "Voice", "fish_audio_id": "duplicate", "language": "en"}
    assert client("POST", "/api/voices", {**voice_body, "language": "fr"})[0] == 400
    assert client("POST", "/api/voices", voice_body)[0] == 201
    status, _, error = client("POST", "/api/voices", voice_body)
    assert status == 409
    assert error["error"]["code"] == "duplicate_voice_id"
    episode = create_episode(client)
    assert client("PATCH", f"/api/episodes/{episode['id']}", {"selected_voice_id": "missing"})[0] == 404
    assert client("POST", "/api/voices", {**voice_body, "fish_audio_id": "other", "voice_type": "invalid"})[0] == 400


def test_audio_file_is_versioned_episode_scoped_and_survives_restart(client, tmp_path):
    episode = create_episode(client)
    upload_url = f"/api/episodes/{episode['id']}/files?filename=take.mp3"
    status, _, record = client("POST", upload_url, b"audio bytes", "audio/mpeg")
    assert status == 201
    status, headers, data = client("GET", f"/api/files/{record['id']}")
    assert status == 200 and headers["Content-Type"] == "audio/mpeg" and data == b"audio bytes"
    assert client("GET", f"/api/episodes/{episode['id']}/files")[2]["files"][0]["id"] == record["id"]
    assert len(list((tmp_path / "episodes" / episode["id"] / "generations").iterdir())) == 1
    restarted = create_app(tmp_path)
    assert request_app(restarted, "GET", f"/api/files/{record['id']}")[2] == b"audio bytes"
    status, _, second = client("POST", upload_url, b"second audio", "audio/mpeg")
    assert status == 201 and second["generation_id"] != record["generation_id"]


def test_audio_upload_rejects_paths_empty_and_non_audio(client):
    episode = create_episode(client)
    base = f"/api/episodes/{episode['id']}/files?filename="
    assert client("POST", base + "%2e%2e%2Fsecret.mp3", b"bytes", "audio/mpeg")[0] in {400, 404}
    assert client("POST", base + "empty.mp3", b"", "audio/mpeg")[2]["error"]["code"] == "empty_file"
    assert client("POST", base + "script.txt", b"text", "text/plain")[0] == 415
    assert client("POST", base + "attack.mp3", b"text", "audio/mpeg\r\nX-Injected: yes")[0] == 415
    assert client("GET", "/api/files/not-a-uuid")[0] == 404


def test_invalid_json_and_payload_shape(client):
    status, _, data = client("POST", "/api/episodes", b"{bad")
    assert status == 400 and data["error"]["code"] == "invalid_json"
    assert client("POST", "/api/episodes", ["not", "object"])[2]["error"]["code"] == "invalid_json"
    assert client("GET", "/health")[2] == {"status": "ok"}


def test_store_api_validation_and_deletion(tmp_path):
    studio = Studio(tmp_path)
    episode = studio.create_episode({"title": "Delete me"})
    with pytest.raises(ApiError, match="Filename"):
        studio.store_file(episode["id"], "../bad.mp3", "audio/mpeg", b"x")
    episode_path = tmp_path / "episodes" / episode["id"]
    assert episode_path.exists()
    studio.delete_episode(episode["id"])
    assert not episode_path.exists()
    with pytest.raises(ApiError, match="Episode not found"):
        studio.get_episode(episode["id"])


def test_database_and_files_are_created_with_local_structure(tmp_path):
    studio = Studio(tmp_path)
    assert studio.db_path.exists()
    assert studio.episodes_dir.is_dir()
    assert studio.dashboard() == {"total_episodes": 0, "draft_episodes": 0, "awaiting_review": 0,
                                  "published_episodes": 0, "by_status": {}, "recent_episodes": []}
