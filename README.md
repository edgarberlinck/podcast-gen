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
- `POST /api/episodes/{id}/narration-suggestions` → `{"suggestion": {...}}` for `{"scope":"article"}` or `{"scope":"paragraph","paragraph_index":0}`. Paragraph indexes are zero-based and paragraphs are separated by blank lines. Suggestions are stored separately and always have `approval_status: "pending"`; they never update any episode text field.
- `GET /api/episodes/{id}/narration-suggestions` → `{"suggestions":[...]}` (newest first).

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

## AI narration suggestions (Phase 3 service)

`POST /api/episodes/{id}/narration-suggestions` accepts `{"scope":"article"}` to suggest for the complete original article, or `{"scope":"paragraph","paragraph_index":0}` to regenerate one zero-based, blank-line-delimited paragraph. `GET` on the same route returns the episode's stored suggestions. The source text and SHA-256 digest, suggestion, provider/model, scope/index, timestamp, and `approval_status: "pending"` are stored in a separate `narration_suggestions` table. Suggestion requests never change `original_article`, `narration_script`, or `fish_audio_script`; there is no automatic approval or application route.

The replaceable provider boundary is `SuggestionProvider` in `narration.py`. The included OpenAI-compatible Chat Completions adapter is configured on the local server with `LLM_API_KEY`, optional `LLM_MODEL` (defaults to `gpt-4o-mini`), and optional `LLM_BASE_URL` (defaults to `https://api.openai.com/v1`). Keep these variables in the server process environment or another local secret manager; never expose them to browser code or commit real credentials. `LLM_BASE_URL` requires HTTPS except for loopback development endpoints. Without `LLM_API_KEY`, suggestion requests return `503 suggestion_provider_unavailable`; there is no pretend/mock result in production. Provider HTTP errors do not include response bodies or credentials in API errors. This adapter uses a server-side network call and sends the selected article text to the configured provider, so configure it only if that data transfer is acceptable. No live provider request was performed for this implementation.

The prompt asks for faithful, lightly adapted delivery, preserved paragraph structure, sparse bracketed plain-language cues, and no new facts. These instructions constrain the model but cannot guarantee editorial correctness; all saved output remains an unapproved suggestion for human review. The verified Phase 1 report supports Drama 3 plain-language directions and pauses, not a complete fixed cue vocabulary; this service does not call Fish Audio or claim cue compatibility beyond that documented guidance. Fish Audio generation and Transistor remain out of scope.

### Local configuration example

Copy `.env.example` as a reference only; the app does not load dotenv files. Export the variables into the shell that starts `python app.py`, or configure them through a local secret manager. The actual API key is intentionally absent from the example file.

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

### Browser E2E checks

The Playwright suite exercises the delivered local Phase 2 UI in Chromium and starts its own loopback server with a disposable temporary data directory. It restarts that server against the same directory to verify real persistence; test data is removed afterward. No generation, Fish Audio, Transistor, publishing, audio uploads, or provider credentials are used.

Install the browser once, then run the checks from the repository root:

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The suite covers dashboard loading/empty/error-and-retry states, keyboard-oriented semantic landmarks/labels, a 375px mobile viewport, Portuguese and English episode create/list/filter/reopen flows, required-title validation, local voice registration/selection, separate manual narration/Fish scripts, deliberately confirmed and declined original edits, revision preservation, and persistence across a server restart. Error-state testing aborts a local dashboard request deliberately. The responsive assertion checks horizontal overflow at one narrow viewport; this is not a full WCAG audit or a cross-browser matrix. Browser-native and backend validation not represented in these tests remains outside the reported evidence.

QA run in this workspace: `npm run test:e2e` — 2 Playwright tests passed in Chromium, including a real temporary-server restart. `python -m pytest --cov=app --cov-report=term-missing` — 100 passed, 89% app.py line coverage. `python -m ruff check .`, `node --test tests/frontend_api.test.js`, and both JavaScript `node --check` commands passed. These are local test results, not CI or deployment evidence. The test target was the application and API running locally; no remote QA deployment, non-Chromium browser, full WCAG audit, live provider, audio generation, or publishing integration was exercised.

### UI integration assumptions and boundaries

- The backend dashboard contract has counts and recent episodes, but no event/activity feed or generated-audio approval metric. The UI therefore presents recent episode updates as recent activity, uses the API's combined editorial/audio-review count, and does not invent an audio-approval count.
- Voice records are local user-entered metadata. Availability is descriptive only; no Fish Audio request or identifier validation occurs.
- The published count is a local status label, not evidence that content was sent to any external platform.
- Import accepts text/Markdown files only. Audio upload/library management remains an API capability but is not surfaced as an audio generation/review workflow in this UI phase.
- The UI labels are Portuguese; article text may be Portuguese or English. Dates and word-count labels are presented in Portuguese locale.
- The interface uses the API's existing 100,000-character limit for each manuscript field. There is no autosave; use the explicit save controls before navigating away.

## Out of scope

There is no AI narration, Fish Audio integration, Transistor integration, cloud storage, or automatic publishing. The Fish Audio model and tag vocabulary are not validated here. Audio generation, approval, and publication require later implementation and explicit user workflows.
