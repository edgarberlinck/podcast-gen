import io
import json

import pytest

from app import ApiError, MAX_FILE_BYTES, MAX_JSON_BYTES, read_body, read_json


class ChunkLimitedInput(io.BytesIO):
    def read(self, size=-1):
        assert 0 < size <= 64 * 1024
        return super().read(size)


@pytest.mark.parametrize("extra", [-1, 0, 1])
def test_json_size_boundary(extra):
    size = MAX_JSON_BYTES + extra
    stream = ChunkLimitedInput(b"{}" + b" " * (size - 2))
    environ = {"CONTENT_LENGTH": str(size), "wsgi.input": stream}
    if extra > 0:
        with pytest.raises(ApiError) as caught:
            read_json(environ)
        assert caught.value.status == 413
        assert caught.value.code == "request_too_large"
        assert stream.tell() == 0
    else:
        assert read_json(environ) == json.loads(b"{}")
        assert stream.tell() == size


@pytest.mark.parametrize("extra", [-1, 0, 1])
def test_audio_size_boundary_with_reduced_limit(extra):
    # Exercise multiple chunks without allocating a 500 MiB recording.
    maximum = 128 * 1024
    size = maximum + extra
    stream = ChunkLimitedInput(b"x" * size)
    environ = {"CONTENT_LENGTH": str(size), "wsgi.input": stream}
    if extra > 0:
        with pytest.raises(ApiError) as caught:
            read_body(environ, maximum, "file_too_large", "Audio too large.")
        assert caught.value.status == 413
        assert caught.value.code == "file_too_large"
        assert stream.tell() == 0
    else:
        assert len(read_body(environ, maximum, "file_too_large", "Audio too large.")) == size
        assert stream.tell() == size


def test_production_audio_limit_rejects_before_reading():
    stream = ChunkLimitedInput(b"")
    with pytest.raises(ApiError) as caught:
        read_body({"CONTENT_LENGTH": str(MAX_FILE_BYTES + 1), "wsgi.input": stream},
                  MAX_FILE_BYTES, "file_too_large", "Audio too large.")
    assert caught.value.status == 413
    assert stream.tell() == 0
