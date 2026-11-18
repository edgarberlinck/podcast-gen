"""Server-side client for the verified Transistor API operations used by the studio."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

API_ROOT = "https://api.transistor.fm/v1"
MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Never forward API credentials or media to a redirect destination."""

    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


_DEFAULT_OPENER = urllib.request.build_opener(_NoRedirectHandler()).open


class TransistorError(Exception):
    """Safe, non-sensitive failure to complete a Transistor operation."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class TransistorClient:
    def __init__(self, api_key: str | None = None, opener=None):
        self._api_key = api_key if api_key is not None else os.environ.get("TRANSISTOR_API_KEY", "")
        self._opener = opener or _DEFAULT_OPENER

    @property
    def configured(self) -> bool:
        return bool(self._api_key.strip())

    def _require_key(self):
        if not self.configured:
            raise TransistorError("not_configured", "Set TRANSISTOR_API_KEY in the local server environment to enable Transistor.")

    def _request(self, method: str, path: str, *, params=None, form=None, expected_json=True):
        self._require_key()
        url = API_ROOT + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = urllib.parse.urlencode(form).encode("utf-8") if form is not None else None
        headers = {"x-api-key": self._api_key, "Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self._opener(request, timeout=30) as response:
                payload = response.read()
        except urllib.error.HTTPError as exc:
            code = "rate_limited" if exc.code == 429 else "remote_error"
            message = "Transistor rate limit reached. Wait before retrying." if exc.code == 429 else "Transistor rejected the request. Check the selected show and episode details."
            raise TransistorError(code, message) from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise TransistorError("network_error", "Could not reach Transistor. Check the connection and refresh before retrying.") from None
        if not expected_json:
            return None
        try:
            decoded = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise TransistorError("invalid_response", "Transistor returned an unreadable response. Refresh status before retrying.") from None
        if not isinstance(decoded, dict):
            raise TransistorError("invalid_response", "Transistor returned an unexpected response. Refresh status before retrying.")
        return decoded

    @staticmethod
    def _resource(payload: dict[str, Any], expected_type: str) -> dict[str, Any]:
        resource = payload.get("data")
        if not isinstance(resource, dict) or resource.get("type") != expected_type:
            raise TransistorError("invalid_response", "Transistor returned an unexpected resource. Refresh status before retrying.")
        attributes = resource.get("attributes")
        if not isinstance(attributes, dict) or not isinstance(resource.get("id"), (str, int)):
            raise TransistorError("invalid_response", "Transistor returned an incomplete resource. Refresh status before retrying.")
        return {"id": str(resource["id"]), **attributes}

    def list_shows(self) -> list[dict[str, Any]]:
        payload = self._request("GET", "/shows", params={"pagination[per]": 100})
        resources = payload.get("data")
        if not isinstance(resources, list):
            raise TransistorError("invalid_response", "Transistor returned an unexpected show list.")
        shows = []
        for item in resources:
            if not isinstance(item, dict) or item.get("type") != "show" or not isinstance(item.get("attributes"), dict):
                continue
            show_id = item.get("id")
            if isinstance(show_id, (str, int)):
                attributes = item["attributes"]
                shows.append({"id": str(show_id), "title": attributes.get("title", ""),
                              "time_zone": attributes.get("time_zone", "")})
        return shows

    def get_show(self, show_id: str) -> dict[str, Any]:
        return self._resource(self._request("GET", f"/shows/{urllib.parse.quote(show_id, safe='')}"), "show")

    def get_episode(self, episode_id: str) -> dict[str, Any]:
        return self._resource(self._request("GET", f"/episodes/{urllib.parse.quote(episode_id, safe='')}"), "episode")

    def authorize_upload(self, filename: str) -> dict[str, Any]:
        payload = self._request("GET", "/episodes/authorize_upload", params={"filename": filename})
        resource = self._resource(payload, "audio_upload")
        upload_url = resource.get("upload_url")
        audio_url = resource.get("audio_url")
        content_type = resource.get("content_type")
        if not all(isinstance(value, str) and value for value in (upload_url, audio_url, content_type)):
            raise TransistorError("invalid_upload_authorization", "Transistor returned incomplete upload authorization.")
        parsed = urllib.parse.urlsplit(upload_url)
        if parsed.scheme != "https" or not (parsed.hostname or "").endswith(".r2.cloudflarestorage.com"):
            raise TransistorError("invalid_upload_authorization", "Transistor returned an unsupported upload destination.")
        return {"upload_url": upload_url, "audio_url": audio_url, "content_type": content_type}

    def upload_audio(self, upload_url: str, content_type: str, audio_path: Path):
        size = audio_path.stat().st_size
        if size <= 0 or size > MAX_UPLOAD_BYTES:
            raise TransistorError("invalid_audio_size", "The audio file is empty or exceeds Transistor's documented 5 GB limit.")
        parsed = urllib.parse.urlsplit(upload_url)
        if parsed.scheme != "https" or not (parsed.hostname or "").endswith(".r2.cloudflarestorage.com"):
            raise TransistorError("invalid_upload_authorization", "Transistor returned an unsupported upload destination.")
        request = urllib.request.Request(upload_url, data=audio_path.read_bytes(), headers={"Content-Type": content_type}, method="PUT")
        try:
            with self._opener(request, timeout=120) as response:
                response.read()
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise TransistorError("upload_failed", "Audio upload did not complete. The file remains local; request a fresh upload authorization before retrying.") from None

    def create_draft(self, show_id: str, episode: dict[str, str], audio_url: str) -> dict[str, Any]:
        form = {
            "episode[show_id]": show_id,
            "episode[audio_url]": audio_url,
            "episode[title]": episode["title"],
            "episode[description]": episode["description"],
            "episode[summary]": episode["summary"],
            "episode[keywords]": episode["keywords"],
        }
        return self._resource(self._request("POST", "/episodes", form=form), "episode")

    def publish(self, episode_id: str, status: str, published_at: str | None = None) -> dict[str, Any]:
        form = {"episode[status]": status}
        if published_at is not None:
            form["episode[published_at]"] = published_at
        return self._resource(self._request("PATCH", f"/episodes/{urllib.parse.quote(episode_id, safe='')}/publish", form=form), "episode")
