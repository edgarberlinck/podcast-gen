import io
from pathlib import Path

from wsgiref.util import setup_testing_defaults

from app import create_app


def request(app, path):
    environ = {}
    setup_testing_defaults(environ)
    environ.update({"REQUEST_METHOD": "GET", "PATH_INFO": path, "CONTENT_LENGTH": "0", "wsgi.input": io.BytesIO()})
    response = {}

    def start_response(status, headers):
        response["status"] = int(status.split()[0])
        response["headers"] = dict(headers)

    body = b"".join(app(environ, start_response))
    return response["status"], response["headers"], body


def test_local_app_serves_interface_assets(tmp_path):
    app = create_app(tmp_path)
    status, headers, body = request(app, "/")
    assert status == 200
    assert headers["Content-Type"] == "text/html; charset=utf-8"
    assert b"/static/app.js" in body
    assert b"/static/styles.css" in body
    for name, media_type, expected in [
        ("api.js", "text/javascript; charset=utf-8", b"saveOriginal"),
        ("app.js", "text/javascript; charset=utf-8", b"saveScripts"),
        ("styles.css", "text/css; charset=utf-8", b"@media(max-width:720px)"),
    ]:
        status, headers, body = request(app, f"/static/{name}")
        assert status == 200
        assert headers["Content-Type"] == media_type
        assert headers["X-Content-Type-Options"] == "nosniff"
        assert expected in body
        assert body == (Path(__file__).parents[1] / "static" / name).read_bytes()


def test_static_route_only_serves_allowlisted_assets(tmp_path):
    status, headers, body = request(create_app(tmp_path), "/static/../../README.md")
    assert status == 404
    assert headers["Content-Type"].startswith("application/json")
    assert b"Asset not found" in body
