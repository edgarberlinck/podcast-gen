import json
import subprocess
from email.message import Message
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from codex_audio import CodexAudioError, CodexFishAudio

HANDOFF = {"script": "Approved narration.", "fish_audio_id": "voice-001"}


def codex_success(result):
    def run(command, **kwargs):
        output_path = command[command.index("--output-last-message") + 1]
        with open(output_path, "w", encoding="utf-8") as output:
            json.dump(result, output)
        return SimpleNamespace(returncode=0)

    return run


def test_quote_runs_codex_with_only_quote_and_polling_tools():
    with patch("codex_audio.shutil.which", return_value="/usr/bin/codex"), \
            patch("codex_audio.subprocess.run", side_effect=codex_success({
                "estimated_credits": 36, "quote_summary": "36 credits for this script."
            })) as run:
        quote = CodexFishAudio().quote(HANDOFF)

    command = run.call_args.args[0]
    prompt = command[-1]
    assert quote == {"estimated_credits": 36, "quote_summary": "36 credits for this script."}
    assert 'mcp_servers.fish-audio.enabled_tools=["text_to_speech","get_speech"]' in command
    assert '--ignore-user-config' in command
    assert 'mcp_servers.fish-audio.default_tools_approval_mode="approve"' in command
    assert "dry_run=true" in prompt
    assert "do not generate audio" in prompt
    assert "Approved narration." in prompt
    assert run.call_args.kwargs["stdin"] is subprocess.DEVNULL
    assert "LLM_API_KEY" not in run.call_args.kwargs["env"]
    assert "TRANSISTOR_API_KEY" not in run.call_args.kwargs["env"]


def test_quote_rejects_missing_or_invalid_cost():
    with patch("codex_audio.shutil.which", return_value="/usr/bin/codex"), \
            patch("codex_audio.subprocess.run", side_effect=codex_success({
                "estimated_credits": 0, "quote_summary": "No price."
            })), pytest.raises(CodexAudioError, match="valid credit quote"):
        CodexFishAudio().quote(HANDOFF)


def test_voice_clone_uploads_sample_then_calls_only_clone_tool():
    results = iter([
        {
            "success": True, "upload_url": "https://api.fish.audio/upload/temporary",
            "file_url": "https://cdn.fish.audio/temporary/sample.wav", "message": "",
        },
        {
            "result": "created", "fish_audio_id": "fish-voice-new", "state": "trained",
            "visibility": "private", "instructions": "", "message": "",
        },
    ])
    calls = []
    def run(command, **kwargs):
        calls.append((command, kwargs))
        output_path = command[command.index("--output-last-message") + 1]
        with open(output_path, "w", encoding="utf-8") as output:
            json.dump(next(results), output)
        return SimpleNamespace(returncode=0)

    with patch("codex_audio.shutil.which", return_value="/usr/bin/codex"), \
            patch("codex_audio.subprocess.run", side_effect=run), \
            patch.object(CodexFishAudio, "_upload_voice_sample") as upload:
        clone = CodexFishAudio().clone_voice(
            b"reference audio", "sample.wav", display_name="My Voice",
        )

    assert clone == {"fish_audio_id": "fish-voice-new", "state": "trained", "visibility": "private"}
    upload.assert_called_once_with("https://api.fish.audio/upload/temporary", b"reference audio", "sample.wav")
    assert 'mcp_servers.fish-audio.enabled_tools=["get_upload_url"]' in calls[0][0]
    assert 'mcp_servers.fish-audio.enabled_tools=["create_voice_clone"]' in calls[1][0]
    assert "get_upload_url exactly once" in calls[0][0][-1]
    assert "https://cdn.fish.audio/temporary/sample.wav" in calls[1][0][-1]
    assert "confirm_voice_rights=true" in calls[1][0][-1]
    assert 'visibility="private"' in calls[1][0][-1]
    assert "My Voice" in calls[1][0][-1]


def test_voice_clone_surfaces_provider_verification_and_quality_warnings():
    slot = {
        "success": True, "upload_url": "https://api.fish.audio/upload/temporary",
        "file_url": "https://cdn.fish.audio/temporary/sample.wav", "message": "",
    }
    verification = {
        "result": "verification_required", "fish_audio_id": "", "state": "pending",
        "visibility": "private", "instructions": "Read the verification sentence.", "message": "",
    }
    with patch.object(CodexFishAudio, "_get_voice_upload_slot", return_value=slot), \
            patch.object(CodexFishAudio, "_upload_voice_sample"), \
            patch.object(CodexFishAudio, "_run", return_value=verification), \
            pytest.raises(CodexAudioError, match="speaker verification"):
        CodexFishAudio().clone_voice(
            b"reference audio", "sample.wav", display_name="My Voice",
        )
    warning = {**verification, "result": "quality_warning"}
    with patch.object(CodexFishAudio, "_get_voice_upload_slot", return_value=slot), \
            patch.object(CodexFishAudio, "_upload_voice_sample"), \
            patch.object(CodexFishAudio, "_run", return_value=warning), \
            pytest.raises(CodexAudioError, match="sample needs review"):
        CodexFishAudio().clone_voice(
            b"reference audio", "sample.wav", display_name="My Voice",
        )


def test_voice_upload_rejects_non_fish_urls_and_uses_put():
    with pytest.raises(CodexAudioError, match="trusted upload hosts"):
        CodexFishAudio._upload_voice_sample("https://127.0.0.1/upload", b"audio", "sample.wav")

    class Response:
        status = 204

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    opener = SimpleNamespace(open=lambda request, timeout: (setattr(opener, "request", request), Response())[1])
    with patch("codex_audio.urllib.request.build_opener", return_value=opener):
        CodexFishAudio._upload_voice_sample("https://api.fish.audio/upload", b"sample", "sample.wav")
    assert opener.request.get_method() == "PUT"
    assert opener.request.data == b"sample"
    assert opener.request.get_header("Content-type") == "audio/wav"


def test_generation_downloads_only_https_fish_audio_mp3():
    headers = Message()
    headers["Content-Type"] = "audio/mpeg"

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, _limit):
            return b"ID3 audio"

    Response.headers = headers
    with patch.object(CodexFishAudio, "_run", return_value={
            "audio_url": "https://cdn.fish.audio/result.mp3", "format": "mp3"
    }) as run, patch("codex_audio.urllib.request.build_opener") as build_opener:
        build_opener.return_value.open.return_value = Response()
        audio, media_type = CodexFishAudio().generate(HANDOFF)

    assert audio == b"ID3 audio"
    assert media_type == "audio/mpeg"
    assert "dry_run=false" in run.call_args.args[0]
    assert "exactly once" in run.call_args.args[0]
    build_opener.return_value.open.assert_called_once()


@pytest.mark.parametrize("url", [
    "http://cdn.fish.audio/result.mp3",
    "https://fish.audio.evil.example/result.mp3",
    "https://127.0.0.1/result.mp3",
    "https://user@cdn.fish.audio/result.mp3",
])
def test_generation_rejects_non_https_or_untrusted_audio_urls(url):
    with patch.object(CodexFishAudio, "_run", return_value={"audio_url": url, "format": "mp3"}), \
            pytest.raises(CodexAudioError, match="trusted domain"):
        CodexFishAudio().generate(HANDOFF)
