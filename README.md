# Código & Cicatriz — Local Studio Core

A local-first podcast studio interface and persistence API. This Phase 2 application stores episode metadata, three independent editorial texts, externally registered voice metadata, and versioned audio files on the local machine. It uses Python's standard library and SQLite; it makes no network/vendor calls.

## Requirements and setup

- Python 3.10 or newer (tested with Python 3.12).
- No third-party packages are required.

```sh
python app.py
```

The API listens on `http://127.0.0.1:8000` by default. Keep it bound to loopback for local use. Configure `STUDIO_HOST`, `STUDIO_PORT`, `STUDIO_DATA_DIR`, and `LOG_LEVEL` as needed. The default data directory is `./data/`. The directory contains `studio.sqlite3` and an `episodes/<uuid>/` folder for each episode. Back up the entire data directory while the server is stopped.

## Development checks

```sh
python -m pip install pytest pytest-cov ruff
python -m pytest --cov=app --cov-report=term-missing
python -m ruff check .
```

The test suite uses temporary directories and does not change the default local database.

## Persistence and editorial safety

Episode metadata and content fields are stored in SQLite. Human-readable copies live at `data/episodes/<episode-id>/original.md`, `narration.md`, and `fish-audio-script.txt`. Scripts have dedicated update routes and cannot update the original field. Editing the original requires `PUT /api/episodes/{id}/original` with `confirm_edit: true`; the prior text is retained in the `article_revisions` table. This is an explicit user action, not an absolute lock. A future UI must make this intent clear and must never write an adaptation into the original route.

Audio uploads receive a fresh generation UUID and are stored under `data/episodes/<episode-id>/generations/<generation-id>/audio.<ext>`. Existing generations are never overwritten. The upload is limited to 500 MiB and accepted formats are MP3, WAV, M4A, AAC, OGG, OPUS, and FLAC. Local metadata records the original filename, MIME type, size, and timestamp. The service validates path-like filenames and does not accept arbitrary filesystem paths.

This is a local single-user development API, not an Internet-facing service: it intentionally has no authentication, account system, remote storage, or CORS policy. SQLite is the metadata source of truth; on-disk text copies are maintained atomically on write. Take regular local backups. Logs include local entity IDs and exception details on the server only; request errors avoid leaking internal exception details.

## API contract

All API routes use JSON request/response bodies unless a route serves raw audio. Errors use `{"error":{"code":"...","message":"..."}}`. Timestamps are UTC ISO-8601 strings. IDs are UUIDs.

### Episodes

- `GET /api/episodes` → `{"episodes": [...]}` (newest updated first).
- `POST /api/episodes` → `201` episode. Required `title`; optional `description`, `language` (`pt` or `en`, default `pt`), `status` (default `Draft`), and `original_article`.
- `GET /api/episodes/{id}` → episode record.
- `PATCH /api/episodes/{id}` → update only `title`, `description`, `language`, `status`, and `selected_voice_id` (UUID or `null`). Unknown keys are rejected.
- `DELETE /api/episodes/{id}` → permanently deletes its metadata and local files.
- `GET /api/episodes/{id}/original` → `{"content":"..."}`.
- `PUT /api/episodes/{id}/original` → `{"content":"...","confirm_edit":true}`. Confirmation is mandatory; old versions are retained in the revision log.
- `GET /api/episodes/{id}/revisions` → `{"revisions":[...]}` (newest first).
- `PUT /api/episodes/{id}/scripts/narration` and `/fish-audio` → `{"content":"..."}`. These routes only change their designated derived text.

Status values: `Draft`, `Preparing Script`, `Script Review`, `Ready for Generation`, `Generating Audio`, `Audio Review`, `Approved`, `Publishing`, `Published`, and `Failed`. This Phase 2 API stores workflow labels only; it does not generate audio or publish.

Episode response fields: `id`, `title`, `description`, `language`, `status`, `original_article`, `narration_script`, `fish_audio_script`, `selected_voice_id`, `created_at`, and `updated_at`.

### Voices

- `GET /api/voices` → `{"voices":[...]}`.
- `POST /api/voices` → `201` voice with required `display_name`, `fish_audio_id`, `language` (`pt` or `en`); optional `description`, `voice_type` (`external`, `own`, `other`; default `external`) and `availability` (`available`, `unavailable`, `unknown`; default `unknown`). Fish Audio IDs are unique.
- `GET /api/voices/{id}` → voice metadata.

Registration is local metadata only; it does not validate the identifier against Fish Audio or make any API/MCP calls.

### Audio file library

- `POST /api/episodes/{id}/files?filename=take.mp3` with raw audio bytes and an `audio/*` Content-Type → `201` file record. Every upload creates a distinct generation.
- `GET /api/episodes/{id}/files` → `{"files":[...]}`.
- `GET /api/files/{file-id}` → raw audio attachment.

Maximum JSON body is 2 MiB. Maximum audio file size is 500 MiB. Supported extension and MIME type are both checked. Body-bearing requests must supply a non-negative decimal `Content-Length`; malformed or negative lengths return `400 invalid_length`, and oversized declared bodies return `413` before reading. Reads are bounded to the declared length in chunks of at most 64 KiB; truncated bodies return `400 invalid_length`. Following WSGI semantics, a missing or empty length is treated as zero (no body is read); chunked request decoding is not implemented. Enum fields must be strings with one of the documented values; other JSON types return field-specific `400` errors without modifying stored records.

### Dashboard and health

- `GET /api/dashboard` → total, draft, editorial-review, published counts, status counts, and up to 10 recent episodes.
- `GET /health` → `{"status":"ok"}`.

## Local web interface

The Phase 2 browser UI is served by the same local-only Python server. Start it with `python app.py`, then open `http://127.0.0.1:8000/`. Keep it bound to loopback; the API has no authentication and is not intended to be exposed to a network. The interface assets are local files in `static/` and require no JavaScript packages, build step, external fonts, or cloud services.

The responsive interface provides:

- A dashboard with episode, draft, editorial-review, and locally marked published counts, plus the latest saved episodes.
- Search and status/language filters for the episode list; episodes reopen by selecting their title.
- Portuguese (Brazil) or English content language, title, description, and article entry. Paste directly or import a UTF-8 `.txt`/`.md` article (100,000 character limit).
- A deliberately protected original article on existing episodes. The user must first choose **Edit original article** and confirm intent; saving a changed original asks for a second confirmation and calls only the confirmed original endpoint. Previous article text remains available in the backend revision history. Creating a new episode saves its initial article as its first source version.
- Independent, manually editable narration and Fish Audio script panels beside a read-only original for comparison. Each derived save uses its own script endpoint; derived editor actions never call the original route.
- A local voice library for display name, Fish Audio identifier, language, description, type, and declared availability, with episode voice selection filtered by content language.
- Loading, empty, API/network error, saved, and validation feedback, semantic labels, keyboard-accessible controls, and narrow-screen responsive layouts.

### Local checks

Run these exact commands from the repository root:

```sh
python -m pip install pytest pytest-cov ruff
python -m pytest --cov=app --cov-report=term-missing
python -m ruff check .
node --test tests/frontend_api.test.js
node --check static/api.js
node --check static/app.js
```

Python uses the standard library at runtime. Node.js is needed only for the dependency-free JavaScript API client tests and syntax checks. The browser UI is served directly from the Python app; no npm install/build is required.

### UI integration assumptions and boundaries

- The backend dashboard contract has counts and recent episodes, but no event/activity feed or generated-audio approval metric. The UI therefore presents recent episode updates as recent activity, uses the API's combined editorial/audio-review count, and does not invent an audio-approval count.
- Voice records are local user-entered metadata. Availability is descriptive only; no Fish Audio request or identifier validation occurs.
- The published count is a local status label, not evidence that content was sent to any external platform.
- Import accepts text/Markdown files only. Audio upload/library management remains an API capability but is not surfaced as an audio generation/review workflow in this UI phase.
- The UI labels are Portuguese; article text may be Portuguese or English. Dates and word-count labels are presented in Portuguese locale.
- The interface uses the API's existing 100,000-character limit for each manuscript field. There is no autosave; use the explicit save controls before navigating away.

## Out of scope

There is no AI narration, Fish Audio integration, Transistor integration, cloud storage, or automatic publishing. The Fish Audio model and tag vocabulary are not validated here. Audio generation, approval, and publication require later implementation and explicit user workflows.
