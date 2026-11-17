import io
import json

import pytest

from app import Studio, create_app


def request(app, path, body=None, method="POST", **overrides):
    raw = json.dumps(body).encode() if body is not None else b""
    environ = {"REQUEST_METHOD": method, "PATH_INFO": path,
               "CONTENT_LENGTH": str(len(raw)), "wsgi.input": io.BytesIO(raw),
               "CONTENT_TYPE": "audio/mpeg", "QUERY_STRING": "filename=take.mp3"}
    environ.update(overrides)
    result = {}

    def start_response(status, headers):
        result["status"] = int(status.split()[0])

    data = json.loads(b"".join(app(environ, start_response)))
    return result["status"], data


@pytest.mark.parametrize("value", [[], {}, None, True, 1, 1.5, "unsupported"])
@pytest.mark.parametrize("field", ["language", "status"])
@pytest.mark.parametrize("method", ["POST", "PATCH"])
def test_episode_enum_errors_do_not_mutate(tmp_path, field, value, method):
    app = create_app(tmp_path)
    studio = Studio(tmp_path)
    episode = studio.create_episode({"title": "Before"})
    path = "/api/episodes" if method == "POST" else f"/api/episodes/{episode['id']}"
    status, error = request(app, path, {"title": "After", field: value}, method)
    assert status == 400
    assert error["error"]["code"] == f"invalid_{field}"
    assert studio.list_episodes() == [episode]


@pytest.mark.parametrize("value", [[], {}, None, True, 1, 1.5, "unsupported"])
@pytest.mark.parametrize("field", ["language", "voice_type", "availability"])
def test_voice_enum_errors_do_not_register(tmp_path, field, value):
    body = {"display_name": "Voice", "fish_audio_id": "external-id", "language": "pt", field: value}
    status, error = request(create_app(tmp_path), "/api/voices", body)
    assert status == 400
    assert error["error"]["code"] == f"invalid_{field}"
    assert Studio(tmp_path).list_voices() == []


class BoundedInput(io.BytesIO):
    """Fail if the application attempts an unbounded or excessive stream read."""

    def __init__(self, data, partial=False):
        super().__init__(data)
        self.sizes = []
        self.partial = partial

    def read(self, size=-1):
        assert 0 < size <= 64 * 1024
        self.sizes.append(size)
        return super().read(min(size, 3) if self.partial else size)


@pytest.mark.parametrize("kind", ["json", "audio"])
@pytest.mark.parametrize("length,expected", [
    ("-1", 400), ("-2097153", 400), ("invalid", 400), ("1.5", 400),
    ("+1", 400), (" 1", 400), ("1_000", 400), ("١", 400),
    (123, 400), ("9" * 5000, 400), (str(501 * 1024 * 1024), 413),
])
def test_invalid_lengths_do_not_read(tmp_path, kind, length, expected):
    path = "/api/episodes" if kind == "json" else "/api/episodes/unused/files"
    stream = BoundedInput(b"payload")
    status, error = request(create_app(tmp_path), path, CONTENT_LENGTH=length, **{"wsgi.input": stream})
    assert status == expected
    expected_code = "request_too_large" if kind == "json" else "file_too_large"
    assert error["error"]["code"] == ("invalid_length" if expected == 400 else expected_code)
    assert stream.sizes == []
    assert Studio(tmp_path).list_episodes() == []


@pytest.mark.parametrize("kind", ["json", "audio"])
@pytest.mark.parametrize("partial", [False, True])
def test_bounded_reads_support_partial_streams(tmp_path, kind, partial):
    app = create_app(tmp_path)
    studio = Studio(tmp_path)
    episode = studio.create_episode({"title": "Before"})
    path = f"/api/episodes/{episode['id']}"
    body = json.dumps({"title": "After"}).encode() if kind == "json" else b"audio bytes"
    stream = BoundedInput(body + b"unread trailing bytes", partial=partial)
    status, result = request(app, path + ("/files" if kind == "audio" else ""),
                             method="POST" if kind == "audio" else "PATCH",
                             CONTENT_LENGTH=str(len(body)), **{"wsgi.input": stream})
    assert status == (200 if kind == "json" else 201)
    assert stream.tell() == len(body)
    assert stream.sizes
    if kind == "audio":
        assert studio.read_file(result["id"])[1] == body
    else:
        assert result["title"] == "After"


@pytest.mark.parametrize("kind", ["json", "audio"])
def test_truncated_body_is_rejected_without_writes(tmp_path, kind):
    app = create_app(tmp_path)
    studio = Studio(tmp_path)
    episode = studio.create_episode({"title": "Before"})
    path = f"/api/episodes/{episode['id']}" + ("/files" if kind == "audio" else "")
    status, error = request(app, path, method="POST" if kind == "audio" else "PATCH",
                            CONTENT_LENGTH="20", **{"wsgi.input": BoundedInput(b"{}")})
    assert status == 400
    assert error["error"]["code"] == "invalid_length"
    assert studio.get_episode(episode["id"]) == episode
    assert studio.list_files(episode["id"]) == []


@pytest.mark.parametrize("length", [None, "", "0"])
def test_missing_or_zero_length_never_reads_stream(tmp_path, length):
    stream = BoundedInput(b"unread")
    status, error = request(create_app(tmp_path), "/api/episodes",
                            CONTENT_LENGTH=length, **{"wsgi.input": stream})
    assert status == 400
    assert error["error"]["code"] == "invalid_field"
    assert stream.sizes == []
