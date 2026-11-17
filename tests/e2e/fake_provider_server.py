"""Local WSGI harness for deterministic narration-provider browser tests."""

from __future__ import annotations

import os
import sys
from wsgiref.simple_server import make_server

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
sys.path.insert(0, ROOT)

from app import create_app  # noqa: E402


class DeterministicProvider:
    name = "e2e-local-fake"
    model = "fixture-v1"

    def suggest(self, source: str, *, language: str, scope: str) -> str:
        if "FAIL_PROVIDER_SENTINEL" in source:
            raise RuntimeError("PRIVATE_PROVIDER_TRACE secret-token-should-never-reach-browser")
        return f"[fixture {scope} {language}] {source}"


def main() -> None:
    port = int(os.environ["STUDIO_PORT"])
    data_dir = os.environ["STUDIO_DATA_DIR"]
    app = create_app(data_dir, suggestion_provider=DeterministicProvider())
    with make_server("127.0.0.1", port, app) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
