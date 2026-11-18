import io
import json
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
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
        return {"id": episode_id, "status": self.remote_status,
                "published_at": "2026-11-20T12:00:00Z" if self.remote_status == "scheduled" else None}

    def publish(self, episode_id, status, published_at):
        self.calls.append(("publish", episode_id, status, published_at))
        self.remote_status = status
        return {"id": episode_id, "status": status, "published_at": published_at}


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
    return request("POST", f"/api/files/{audio['id']}/review", {"status": "approved", "confirm_review": True})


def create_draft(request, episode, audio, **extra):
    return request("POST", f"/api/episodes/{episode['id']}/transistor/draft",
                   {"file_id": audio["id"], "show_id": "show-1", "confirm_upload": True, **extra})


def test_approved_audio_and_explicit_upload_confirmation_are_required(setup_studio):
    _, client, request, episode, audio = setup_studio
    status, _, error = create_draft(request, episode, audio)
    assert status == 409 and error["error"]["code"] == "audio_not_approved"
    assert client.calls == []
    approve_audio(request, episode, audio)
    status, _, error = request("POST", f"/api/episodes/{episode['id']}/transistor/draft",
                              {"file_id": audio["id"], "show_id": "show-1"})
    assert status == 400 and error["error"]["code"] == "confirmation_required"
    assert client.calls == []


def test_draft_upload_is_explicit_persisted_unique_and_signed_url_is_not_returned(setup_studio):
    _, client, request, episode, audio = setup_studio
    approve_audio(request, episode, audio)
    status, _, response = create_draft(request, episode, audio, summary="Short summary", keywords="code,podcast")
    assert status == 201
    publication = response["publication"]
    assert publication["status"] == "draft" and publication["remote_episode_id"] == "remote-42"
    assert publication["show_time_zone"] == "America/Sao_Paulo"
    assert "signed" not in json.dumps(response)
    assert [call[0] for call in client.calls] == ["get_show", "authorize_upload", "upload_audio", "create_draft"]
    assert client.calls[-1][2] == {"title": "An episode", "description": "A short description",
                                    "summary": "Short summary", "keywords": "code,podcast"}
    status, _, deletion = request("DELETE", f"/api/episodes/{episode['id']}")
    assert status == 409 and deletion["error"]["code"] == "transistor_episode_linked"
    assert request("GET", f"/api/episodes/{episode['id']}")[0] == 200
    status, _, duplicate = create_draft(request, episode, audio)
    assert status == 409 and duplicate["error"]["code"] == "transistor_already_started"
    assert sum(call[0] == "create_draft" for call in client.calls) == 1


def test_upload_failure_can_retry_but_uncertain_draft_create_cannot(setup_studio):
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
    assert create_draft(request2, episode2, audio2)[0] == 409
    status, _, refresh = request2("POST", f"/api/episodes/{episode2['id']}/transistor/refresh", {})
    assert status == 409 and refresh["error"]["code"] == "transistor_manual_reconciliation"
    assert sum(call[0] == "create_draft" for call in client2.calls) == 1


def test_publish_requires_a_separate_confirmation_and_approved_file(setup_studio):
    _, client, request, episode, audio = setup_studio
    approve_audio(request, episode, audio)
    assert create_draft(request, episode, audio)[0] == 201
    path = f"/api/episodes/{episode['id']}/transistor/publish"
    status, _, error = request("POST", path, {"status": "published"})
    assert status == 400 and error["error"]["code"] == "confirmation_required"
    assert not any(call[0] == "publish" for call in client.calls)
    request("POST", f"/api/files/{audio['id']}/review", {"status": "rejected", "confirm_review": True})
    status, _, error = request("POST", path, {"status": "published", "confirm_publish": True})
    assert status == 409 and error["error"]["code"] == "audio_not_approved"
    assert not any(call[0] == "publish" for call in client.calls)


def test_publish_and_schedule_are_explicit_and_refreshed(setup_studio):
    _, client, request, episode, audio = setup_studio
    approve_audio(request, episode, audio)
    assert create_draft(request, episode, audio)[0] == 201
    path = f"/api/episodes/{episode['id']}/transistor/publish"
    status, _, published = request("POST", path, {"status": "published", "confirm_publish": True})
    assert status == 200 and published["publication"]["status"] == "published"
    assert client.calls[-1] == ("publish", "remote-42", "published", None)
    assert request("POST", path, {"status": "published", "confirm_publish": True})[0] == 409
    assert sum(call[0] == "publish" for call in client.calls) == 1

    _, scheduled_client, scheduled_request, episode2, audio2 = _make_studio(setup_studio[0] / "schedule")
    approve_audio(scheduled_request, episode2, audio2)
    assert create_draft(scheduled_request, episode2, audio2)[0] == 201
    path2 = f"/api/episodes/{episode2['id']}/transistor/publish"
    status, _, response = scheduled_request("POST", path2, {"status": "scheduled", "published_at": "2026-11-20T12:00", "confirm_publish": True})
    assert status == 200 and response["publication"]["status"] == "scheduled"
    assert scheduled_client.calls[-1] == ("publish", "remote-42", "scheduled", "2026-11-20T12:00:00-03:00")
    scheduled_client.remote_status = "published"
    status, _, refreshed = scheduled_request("POST", f"/api/episodes/{episode2['id']}/transistor/refresh", {})
    assert status == 200 and refreshed["publication"]["status"] == "published"


def test_schedule_rejects_past_invalid_and_dst_gap_or_ambiguous_values(setup_studio):
    _, client, request, episode, audio = setup_studio
    client.get_show = lambda show_id: {"id": show_id, "title": "Code & Scars", "time_zone": "America/New_York"}
    approve_audio(request, episode, audio)
    create_draft(request, episode, audio)
    path = f"/api/episodes/{episode['id']}/transistor/publish"
    for value in ("2020-01-01T10:00", "not-a-date", "2027-03-14T02:30", "2027-11-07T01:30"):
        status, _, error = request("POST", path, {"status": "scheduled", "published_at": value, "confirm_publish": True})
        assert status == 400 and error["error"]["code"] == "invalid_schedule"
    assert not any(call[0] == "publish" for call in client.calls)


def test_uncertain_publish_is_not_retried_until_explicit_status_refresh(setup_studio):
    _, client, request, episode, audio = setup_studio
    approve_audio(request, episode, audio)
    create_draft(request, episode, audio)
    original_publish = client.publish

    def lose_response(*_args):
        client.calls.append(("publish_response_lost",))
        raise TransistorError("network_error", "The private response must not be shown.")

    client.publish = lose_response
    path = f"/api/episodes/{episode['id']}/transistor/publish"
    status, _, error = request("POST", path, {"status": "published", "confirm_publish": True})
    assert status == 502 and error["error"]["code"] == "transistor_publish_uncertain"
    assert "private" not in json.dumps(error)
    assert request("GET", f"/api/episodes/{episode['id']}/transistor")[2]["publication"]["status"] == "publish_uncertain"
    assert not any(call[0] == "publish" for call in client.calls)
    status, _, refreshed = request("POST", f"/api/episodes/{episode['id']}/transistor/refresh", {})
    assert status == 200 and refreshed["publication"]["status"] == "draft"
    assert not any(call[0] == "publish" for call in client.calls)
    client.publish = original_publish
    assert request("POST", path, {"status": "published", "confirm_publish": True})[0] == 200
    assert sum(call[0] == "publish" for call in client.calls) == 1


def test_external_status_change_blocks_a_second_publish(setup_studio):
    _, client, request, episode, audio = setup_studio
    approve_audio(request, episode, audio)
    create_draft(request, episode, audio)
    client.remote_status = "published"
    status, _, error = request("POST", f"/api/episodes/{episode['id']}/transistor/publish",
                               {"status": "published", "confirm_publish": True})
    assert status == 409 and error["error"]["code"] == "transistor_not_draft"
    assert not any(call[0] == "publish" for call in client.calls)
    assert request("GET", f"/api/episodes/{episode['id']}/transistor")[2]["publication"]["status"] == "published"


def test_concurrent_publish_requests_issue_only_one_remote_write(setup_studio):
    _, client, request, episode, audio = setup_studio
    approve_audio(request, episode, audio)
    create_draft(request, episode, audio)
    barrier = Barrier(2)
    original_get = client.get_episode

    def synchronized_get(episode_id):
        value = original_get(episode_id)
        barrier.wait(timeout=3)
        return value

    client.get_episode = synchronized_get
    path = f"/api/episodes/{episode['id']}/transistor/publish"
    payload = {"status": "published", "confirm_publish": True}
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _index: request("POST", path, payload), range(2)))
    assert sorted(result[0] for result in results) == [200, 409]
    assert sum(call[0] == "publish" for call in client.calls) == 1


def test_show_without_timezone_can_create_draft_and_publish_now_but_not_schedule(setup_studio):
    _, client, request, episode, audio = setup_studio
    client.get_show = lambda show_id: {"id": show_id, "title": "Code & Scars", "time_zone": None}
    approve_audio(request, episode, audio)
    status, _, created = create_draft(request, episode, audio)
    assert status == 201 and created["publication"]["show_time_zone"] == ""
    path = f"/api/episodes/{episode['id']}/transistor/publish"
    status, _, error = request("POST", path, {"status": "scheduled", "published_at": "2026-11-20T12:00", "confirm_publish": True})
    assert status == 400 and error["error"]["code"] == "invalid_schedule"
    assert not any(call[0] == "publish" for call in client.calls)
    status, _, result = request("POST", path, {"status": "published", "confirm_publish": True})
    assert status == 200 and result["publication"]["status"] == "published"


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
    def __init__(self, value):
        self.value = value

    def read(self):
        return self.value

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_api_client_auth_form_headers_and_upload_omits_api_key(tmp_path):
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
    upload = calls[-1][0]
    assert upload.get_method() == "PUT" and upload.get_header("X-api-key") is None
    assert upload.data == b"mock audio"


def test_api_client_rejects_unsafe_upload_destination_invalid_json_and_large_file(tmp_path):
    unsafe = TransistorClient("x", lambda *_args, **_kwargs: Response(json.dumps({"data": {"id": "1", "type": "audio_upload", "attributes": {"upload_url": "http://localhost/x", "audio_url": "https://uploads.transistor.fm/a", "content_type": "audio/mpeg"}}}).encode()))
    with pytest.raises(TransistorError, match="unsupported upload"):
        unsafe.authorize_upload("take.mp3")
    invalid = TransistorClient("x", lambda *_args, **_kwargs: Response(b"not json"))
    with pytest.raises(TransistorError, match="unreadable"):
        invalid.list_shows()
    huge = tmp_path / "huge.mp3"
    with huge.open("wb") as stream:
        stream.truncate(5 * 1024 * 1024 * 1024 + 1)
    with pytest.raises(TransistorError, match="5 GB"):
        TransistorClient("x").upload_audio("https://bucket.r2.cloudflarestorage.com/file", "audio/mpeg", huge)


def test_client_errors_are_sanitized_and_rate_limit_is_distinguished(tmp_path):
    def fail(code):
        def opener(*_args, **_kwargs):
            raise urllib.error.HTTPError("https://private/?signed=secret", code, "private details", {}, io.BytesIO(b"api-key-secret"))
        return opener

    with pytest.raises(TransistorError) as error:
        TransistorClient("never-echo", fail(400)).list_shows()
    assert "never-echo" not in str(error.value) and "api-key-secret" not in str(error.value)
    with pytest.raises(TransistorError, match="rate limit"):
        TransistorClient("x", fail(429)).list_shows()


def test_missing_api_key_is_reported_without_network(tmp_path):
    app = create_app(tmp_path, transistor_client=TransistorClient(api_key=""))
    status, _, result = call_wsgi(app, "GET", "/api/transistor/shows")
    assert status == 503 and result["error"]["code"] == "transistor_not_configured"
