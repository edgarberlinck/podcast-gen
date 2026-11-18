import io
import json
import urllib.error
from urllib.parse import urlsplit
from wsgiref.util import setup_testing_defaults

import pytest

from app import create_app
from transistor import TransistorClient, TransistorError


class FakeTransistor:
    def __init__(self):
        self.calls = []
        self.fail_upload = False
        self.fail_create = False
        self.remote_status = "draft"
        self.publish_result_status = None

    def list_shows(self):
        self.calls.append(("list_shows",))
        return [{"id": "show-1", "title": "Code & Scars", "time_zone": "America/Sao_Paulo"}]

    def get_show(self, show_id):
        self.calls.append(("get_show", show_id))
        return {"id": show_id, "title": "Code & Scars", "time_zone": "America/Sao_Paulo"}

    def authorize_upload(self, filename):
        self.calls.append(("authorize_upload", filename))
        return {"upload_url": "https://bucket.r2.cloudflarestorage.com/signed?secret=hidden",
                "audio_url": "https://uploads.transistor.fm/audio.mp3", "content_type": "audio/mpeg"}

    def upload_audio(self, upload_url, content_type, path):
        self.calls.append(("upload_audio", upload_url, content_type, path.read_bytes()))
        if self.fail_upload:
            raise TransistorError("upload_failed", "Upload failed safely.")

    def create_draft(self, show_id, episode, audio_url):
        self.calls.append(("create_draft", show_id, episode, audio_url))
        if self.fail_create:
            raise TransistorError("network_error", "Could not reach Transistor.")
        return {"id": "remote-42", "status": "draft", "published_at": None}

    def get_episode(self, episode_id):
        self.calls.append(("get_episode", episode_id))
        return {"id": episode_id, "status": self.remote_status, "published_at": "2026-11-20T12:00:00Z" if self.remote_status == "scheduled" else None}

    def publish(self, episode_id, status, published_at):
        self.calls.append(("publish", episode_id, status, published_at))
        if self.publish_result_status:
            self.remote_status = self.publish_result_status
        else:
            self.remote_status = status
        return {"id": episode_id, "status": self.remote_status, "published_at": published_at}


def _make_studio(data_dir):
    client = FakeTransistor()
    app = create_app(data_dir, transistor_client=client)

    def request(method, path, body=None, raw=None, content_type="application/json"):
        data = raw if raw is not None else json.dumps(body).encode() if body is not None else b""
        env = {}
        setup_testing_defaults(env)
        parsed = urlsplit(path)
        env.update({"REQUEST_METHOD": method, "PATH_INFO": parsed.path, "QUERY_STRING": parsed.query,
                    "CONTENT_LENGTH": str(len(data)), "CONTENT_TYPE": content_type, "wsgi.input": io.BytesIO(data)})
        result = {}

        def start_response(status, headers):
            result["status"] = int(status.split()[0])
            result["headers"] = dict(headers)

        payload = b"".join(app(env, start_response))
        if result["headers"].get("Content-Type", "").startswith("application/json"):
            payload = json.loads(payload)
        return result["status"], result["headers"], payload

    episode = request("POST", "/api/episodes", {"title": "An episode", "description": "A short description"})[2]
    audio = request("POST", f"/api/episodes/{episode['id']}/files?filename=episode.mp3", raw=b"local audio",
                    content_type="audio/mpeg")[2]
    return data_dir, client, request, episode, audio


@pytest.fixture
def setup_studio(tmp_path):
    return _make_studio(tmp_path)


def approve_audio(request, episode, audio):
    assert request("POST", f"/api/files/{audio['id']}/review", {"status": "approved", "confirm_review": True})[0] == 200


def create_draft(request, episode, audio, **extra):
    return request("POST", f"/api/episodes/{episode['id']}/transistor/draft",
                   {"file_id": audio["id"], "show_id": "show-1", "confirm_upload": True, **extra})


def test_unauthorized_upload_is_rejected_and_no_vendor_call(setup_studio):
    _, client, request, episode, audio = setup_studio
    status, _, error = create_draft(request, episode, audio)
    assert status == 409 and error["error"]["code"] == "audio_not_approved"
    assert client.calls == []
    approve_audio(request, episode, audio)
    status, _, error = request("POST", f"/api/episodes/{episode['id']}/transistor/draft",
                              {"file_id": audio["id"], "show_id": "show-1"})
    assert status == 400 and error["error"]["code"] == "confirmation_required"
    assert client.calls == []


def test_draft_upload_creates_one_remote_draft_and_never_returns_signed_url(setup_studio):
    _, client, request, episode, audio = setup_studio
    approve_audio(request, episode, audio)
    status, _, response = create_draft(request, episode, audio, summary="Short summary", keywords="code,podcast")
    assert status == 201
    publication = response["publication"]
    assert publication["status"] == "draft"
    assert publication["remote_episode_id"] == "remote-42"
    assert publication["show_time_zone"] == "America/Sao_Paulo"
    assert "signed" not in json.dumps(response)
    assert [call[0] for call in client.calls] == ["get_show", "authorize_upload", "upload_audio", "create_draft"]
    assert client.calls[-1][2] == {"title": "An episode", "description": "A short description",
                                    "summary": "Short summary", "keywords": "code,podcast"}
    status, _, duplicate = create_draft(request, episode, audio)
    assert status == 409 and duplicate["error"]["code"] == "transistor_already_started"
    assert sum(call[0] == "create_draft" for call in client.calls) == 1


def test_upload_failure_can_retry_but_draft_failure_is_uncertain_and_never_retried(setup_studio):
    _, client, request, episode, audio = setup_studio
    approve_audio(request, episode, audio)
    client.fail_upload = True
    status, _, error = create_draft(request, episode, audio)
    assert status == 502 and error["error"]["code"] == "transistor_upload_failed"
    assert "signed" not in json.dumps(error)
    client.fail_upload = False
    assert create_draft(request, episode, audio)[0] == 201

    _, client2, request2, episode2, audio2 = _make_studio(setup_studio[0] / "create-failure")
    approve_audio(request2, episode2, audio2)
    client2.fail_create = True
    status, _, error = create_draft(request2, episode2, audio2)
    assert status == 502 and error["error"]["code"] == "transistor_creation_uncertain"
    assert request2("POST", f"/api/episodes/{episode2['id']}/transistor/draft",
                    {"file_id": audio2["id"], "show_id": "show-1", "confirm_upload": True})[0] == 409
    assert sum(call[0] == "create_draft" for call in client2.calls) == 1
    assert request2("POST", f"/api/episodes/{episode2['id']}/transistor/refresh", {})[2]["error"]["code"] == "transistor_manual_reconciliation"


def test_publish_requires_a_separate_confirmation_and_a_current_approved_file(setup_studio):
    _, client, request, episode, audio = setup_studio
    approve_audio(request, episode, audio)
    assert create_draft(request, episode, audio)[0] == 201
    path = f"/api/episodes/{episode['id']}/transistor/publish"
    status, _, error = request("POST", path, {"status": "published"})
    assert status == 400 and error["error"]["code"] == "confirmation_required"
    assert not any(call[0] == "publish" for call in client.calls)
    assert request("POST", f"/api/files/{audio['id']}/review", {"status": "rejected", "confirm_review": True})[0] == 200
    status, _, error = request("POST", path, {"status": "published", "confirm_publish": True})
    assert status == 409 and error["error"]["code"] == "audio_not_approved"
    assert not any(call[0] == "publish" for call in client.calls)


def test_explicit_publish_and_schedule_are_reconciled_with_show_timezone(setup_studio):
    _, client, request, episode, audio = setup_studio
    approve_audio(request, episode, audio)
    assert create_draft(request, episode, audio)[0] == 201
    path = f"/api/episodes/{episode['id']}/transistor/publish"
    status, _, published = request("POST", path, {"status": "published", "confirm_publish": True})
    assert status == 200 and published["publication"]["status"] == "published"
    assert client.calls[-1] == ("publish", "remote-42", "published", None)
    status, _, error = request("POST", path, {"status": "published", "confirm_publish": True})
    assert status == 409 and error["error"]["code"] == "transistor_draft_required"
    assert sum(call[0] == "publish" for call in client.calls) == 1

    _, client2, request2, episode2, audio2 = _make_studio(setup_studio[0] / "schedule")
    approve_audio(request2, episode2, audio2)
    assert create_draft(request2, episode2, audio2)[0] == 201
    path2 = f"/api/episodes/{episode2['id']}/transistor/publish"
    # Use the second independent studio for scheduling, with a far-future show-local time.
    status, _, scheduled = request2("POST", path2, {"status": "scheduled", "published_at": "2026-11-20T12:00",
                                                        "confirm_publish": True})
    assert status == 200 and scheduled["publication"]["status"] == "scheduled"
    assert client2.calls[-1][0:3] == ("publish", "remote-42", "scheduled")
    assert client2.calls[-1][3].endswith("-03:00")


def test_schedule_rejects_bad_past_ambiguous_and_unknown_zone(setup_studio):
    _, client, request, episode, audio = setup_studio
    approve_audio(request, episode, audio)
    create_draft(request, episode, audio)
    path = f"/api/episodes/{episode['id']}/transistor/publish"
    for value in ("2020-01-01T10:00", "not-a-date", "2026-11-01T01:30"):
        status, _, error = request("POST", path, {"status": "scheduled", "published_at": value, "confirm_publish": True})
        assert status == 400 and error["error"]["code"] == "invalid_schedule"
    publication = request("GET", f"/api/episodes/{episode['id']}/transistor")[2]["publication"]
    assert publication["status"] == "draft"
    assert not any(call[0] == "publish" for call in client.calls)


def test_refresh_tracks_remote_status_and_prevents_repeated_publication(setup_studio):
    _, client, request, episode, audio = setup_studio
    approve_audio(request, episode, audio)
    create_draft(request, episode, audio)
    client.remote_status = "published"
    status, _, response = request("POST", f"/api/episodes/{episode['id']}/transistor/refresh", {})
    assert status == 200 and response["publication"]["status"] == "published"
    status, _, error = request("POST", f"/api/episodes/{episode['id']}/transistor/publish",
                               {"status": "published", "confirm_publish": True})
    assert status == 409 and error["error"]["code"] == "transistor_draft_required"
    assert not any(call[0] == "publish" for call in client.calls)


def test_previously_published_remote_episode_is_refreshed_without_publish_call(setup_studio):
    _, client, request, episode, audio = setup_studio
    approve_audio(request, episode, audio)
    create_draft(request, episode, audio)
    client.remote_status = "published"
    status, _, error = request("POST", f"/api/episodes/{episode['id']}/transistor/publish",
                               {"status": "published", "confirm_publish": True})
    assert status == 409 and error["error"]["code"] == "transistor_not_draft"
    assert not any(call[0] == "publish" for call in client.calls)
    assert request("GET", f"/api/episodes/{episode['id']}/transistor")[2]["publication"]["status"] == "published"


def test_transistor_api_key_missing_and_api_failures_are_safe(tmp_path):
    app = create_app(tmp_path, transistor_client=TransistorClient(api_key=""))
    status, _, result = call_wsgi(app, "GET", "/api/transistor/shows")
    assert status == 503 and result["error"]["code"] == "transistor_not_configured"
    assert "secret" not in json.dumps(result)


def call_wsgi(app, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else b""
    env = {}
    setup_testing_defaults(env)
    parsed = urlsplit(path)
    env.update({"REQUEST_METHOD": method, "PATH_INFO": parsed.path, "QUERY_STRING": parsed.query,
                "CONTENT_LENGTH": str(len(data)), "CONTENT_TYPE": "application/json", "wsgi.input": io.BytesIO(data)})
    result = {}

    def start_response(status, headers):
        result["status"] = int(status.split()[0])
        result["headers"] = dict(headers)

    payload = b"".join(app(env, start_response))
    return result["status"], result["headers"], json.loads(payload)


class Response:
    def __init__(self, value, status=200):
        self.value = value
        self.status = status

    def read(self):
        return self.value

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_client_auth_json_and_form_encoded_calls_do_not_leak_api_key_to_upload(tmp_path):
    calls = []

    def opener(request, timeout):
        calls.append((request, timeout))
        if request.full_url.endswith("/shows?pagination%5Bper%5D=100"):
            return Response(json.dumps({"data": [{"id": 7, "type": "show", "attributes": {"title": "Show", "time_zone": "UTC"}}]}).encode())
        return Response(json.dumps({"data": {"id": "9", "type": "episode", "attributes": {"status": "draft"}}}).encode())

    client = TransistorClient("key-not-to-emit", opener)
    assert client.list_shows() == [{"id": "7", "title": "Show", "time_zone": "UTC"}]
    client.create_draft("show", {"title": "T", "description": "D", "summary": "S", "keywords": "K"}, "https://uploads.transistor.fm/a.mp3")
    api_request = calls[1][0]
    assert api_request.get_header("X-api-key") == "key-not-to-emit"
    assert "episode%5Btitle%5D=T" in api_request.data.decode()
    assert calls[1][1] == 30

    audio = tmp_path / "sample.mp3"
    audio.write_bytes(b"mock audio")
    client.upload_audio("https://bucket.r2.cloudflarestorage.com/upload?signature=hidden", "audio/mpeg", audio)
    upload_request = calls[-1][0]
    assert upload_request.get_method() == "PUT"
    assert upload_request.get_header("X-api-key") is None
    assert upload_request.data == b"mock audio"


def test_client_rejects_unsafe_upload_hosts_oversize_and_invalid_json(tmp_path):
    bad = TransistorClient("x", lambda *_args, **_kwargs: Response(b'{"data":{"id":"1","type":"audio_upload","attributes":{"upload_url":"http://localhost/x","audio_url":"https://uploads.transistor.fm/a","content_type":"audio/mpeg"}}}'))
    with pytest.raises(TransistorError, match="unsupported upload"):
        bad.authorize_upload("take.mp3")
    client = TransistorClient("x", lambda *_args, **_kwargs: Response(b"not json"))
    with pytest.raises(TransistorError, match="unreadable"):
        client.list_shows()
    path = tmp_path / "huge.mp3"
    with path.open("wb") as file:
        file.truncate(5 * 1024 * 1024 * 1024 + 1)
    with pytest.raises(TransistorError, match="5 GB"):
        TransistorClient("x").upload_audio("https://bucket.r2.cloudflarestorage.com/upload", "audio/mpeg", path)


def test_client_sanitizes_remote_error_and_rate_limit(tmp_path):
    def fail(code):
        def opener(*_args, **_kwargs):
            raise urllib.error.HTTPError("https://private/?signed=secret", code, "contains API key", {}, io.BytesIO(b"api-key-secret"))
        return opener

    client = TransistorClient("never-echo", fail(400))
    with pytest.raises(TransistorError) as error:
        client.list_shows()
    assert "never-echo" not in str(error.value) and "api-key-secret" not in str(error.value)
    rate_limited = TransistorClient("x", fail(429))
    with pytest.raises(TransistorError, match="rate limit"):
        rate_limited.list_shows()
