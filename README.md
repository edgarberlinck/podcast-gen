# Código & Cicatriz — Local Studio Core

A local-first podcast studio interface and persistence API. This application stores episode metadata, three independent editorial texts, narration suggestions, externally registered voice metadata, and versioned audio files on the local machine. It uses Python's standard library and SQLite. By default it makes no network/vendor calls; when an LLM provider is configured, Phase 3 narration suggestions send the selected source text to that provider from the local server.

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
python -m pytest --cov=app --cov=narration --cov-report=term-missing
python -m ruff check .
npm ci
npm test
node --check static/api.js
node --check static/app.js
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
- `POST /api/episodes/{id}/scripts/fish-audio-approval` → persist explicit approval for `{"content":"<exact saved script>","confirm_approval":true}`. The submitted content must be non-empty and exactly match the saved Fish Audio script, otherwise the API rejects it. Episode records expose `fish_audio_approved_sha256` and `fish_audio_approved_at`; changing the saved Fish Audio script clears both fields. This approval is local and version-specific; it does not call Fish Audio or authorize generation/publishing.

Status values: `Draft`, `Preparing Script`, `Script Review`, `Ready for Generation`, `Generating Audio`, `Audio Review`, `Approved`, `Publishing`, `Published`, and `Failed`. This Phase 2 API stores workflow labels only; it does not generate audio or publish.

Episode response fields: `id`, `title`, `description`, `language`, `status`, `original_article`, `narration_script`, `fish_audio_script`, `fish_audio_approved_sha256`, `fish_audio_approved_at`, `selected_voice_id`, `created_at`, and `updated_at`. The approval fields are `null` until a user confirms approval of the exact saved script.

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

The responsive studio and Phase 3 narration-review UI are served by the same local-only Python server. Start it with `python app.py`, then open `http://127.0.0.1:8000/`. Keep it bound to loopback; the API has no authentication and is not intended to be exposed to a network. The interface assets are local files in `static/` and require no JavaScript packages, build step, external fonts, or cloud services.

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
- A responsive narration review screen for Portuguese and English episodes. The article remains read-only; users can request a whole-article or selected-paragraph suggestion, compare original and editable suggestion, explicitly keep or copy it into the separate narration draft, and save narration and Fish Audio scripts independently. A selected-paragraph change replaces only the corresponding draft paragraph and keeps all others intact. Provider failures show a generic retry/manual-edit message without technical details; pending work is announced accessibly.
- A Fish Audio script review step with save-before-approval, explicit confirmation of the exact saved text, and durable SHA-256/version timestamp. Editing and saving a different script resets approval. Approval does not generate audio or publish.
- A local voice library for display name, Fish Audio identifier, language, description, type, and declared availability, with episode voice selection filtered by content language.
- Loading, empty, API/network error, saved, and validation feedback, semantic labels, keyboard-accessible controls, and narrow-screen responsive layouts.

### Local checks

Run these exact commands from the repository root:

```sh
python -m pip install pytest pytest-cov ruff
python -m pytest --cov=app --cov=narration --cov-report=term-missing
python -m ruff check .
npm ci
npm test
node --check static/api.js
node --check static/app.js
```

Python uses the standard library at runtime. Node.js is used for API client tests, jsdom UI unit tests and Playwright E2E checks. The browser UI is served directly from Python; npm dependencies are development-only. There is no build or JavaScript lint script; JavaScript syntax is checked with `node --check`, and Python lint uses Ruff.

### Browser E2E checks

The Playwright suite exercises the delivered local studio and Phase 3 narration-review UI in Chromium and starts its own loopback server with a disposable temporary data directory. It restarts that server against the same directory to verify real persistence; test data is removed afterward. No generation, Fish Audio, Transistor, publishing, audio uploads, or provider credentials are used.

Install the browser once, then run the checks from the repository root:

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The suite covers dashboard loading/empty/error-and-retry states, semantic landmarks/labels, 375px responsive layout, Portuguese and English episode workflows, voice metadata, separate scripts, deliberate original edits, revision persistence/restart, deterministic whole-article and selected-paragraph suggestion review, paragraph preservation, safe provider errors, and explicit exact-version approval/reset. The suggestion response is intercepted with a deterministic test fixture; no LLM credentials or live provider are used. The responsive assertion checks horizontal overflow at one narrow viewport; this is not a full WCAG audit or a cross-browser matrix.

Local verification after PR #6 review fixes:

- `python -m pytest --cov=. --cov-report=term`: 120 passed, 95% including tests (application files: `app.py` 89%, `narration.py` 92%). `python -m pytest --cov=app --cov=narration --cov-report=term-missing` reports 89% combined application coverage.
- `python -m ruff check .`: passed.
- `npm ci`, `npm test`: passed, 9 Node tests (5 API and 4 jsdom UI unit tests).
- `node --experimental-test-coverage --test tests/*.test.js`: API client 100% line coverage; whole `static/app.js` 55.05% from the focused unit tests alone. This is below the 80% target for that entire legacy UI file; browser E2E exercises additional paths but is not included in this unit metric.
- `node --check static/api.js`, `node --check static/app.js`, `git diff --check`: passed.
- `npm run test:e2e`: 6 Chromium tests passed against the actual loopback app. Includes both directions of independent language selection on PT/EN episodes, mobile narration/Fish stage visibility, focus, draft preservation, no mutation on navigation, and save-before-approval.

No live LLM provider was called. These are local results, not CI or deployment evidence. No remote QA deployment, non-Chromium browser, full WCAG audit, Fish Audio generation, or publishing integration was exercised.

### UI integration assumptions and boundaries

- The backend dashboard contract has counts and recent episodes, but no event/activity feed or generated-audio approval metric. The UI therefore presents recent episode updates as recent activity, uses the API's combined editorial/audio-review count, and does not invent an audio-approval count.
- Voice records are local user-entered metadata. Availability is descriptive only; no Fish Audio request or identifier validation occurs.
- The published count is a local status label, not evidence that content was sent to any external platform.
- Import accepts text/Markdown files only. Audio upload/library management remains an API capability but is not surfaced as an audio generation/review workflow in this UI phase.
- Narration and Fish-review screens provide an independent **PT-BR / EN** interface-language selector, including navigation labels and the document language. Content language and editorial text are never translated or changed by this selector. Legacy studio screens remain Portuguese.
- The interface uses the API's existing 100,000-character limit for each manuscript field. There is no autosave; use the explicit save controls before navigating away.

## Phase 3 narration UI behavior and assumptions

- A request creates a stored pending suggestion through the existing local API. It is not automatically copied into narration; the user must choose **Use in draft**. **Keep current text** discards the displayed suggestion without changing either source or draft.
- Whole-article suggestions replace only the editable narration draft after the user chooses to use them. A paragraph suggestion replaces only the matching blank-line-delimited paragraph in the narration draft; any other draft paragraphs are retained. If the narration draft has no matching paragraph yet, unchanged source paragraphs are used to seed the remaining positions.
- Suggestion comparisons are read-only for the original and editable for the suggestion. Copying a suggestion does not save it automatically; narration and Fish Audio script have separate explicit saves.
- Pending requests show a live status and disable duplicate requests. The current synchronous narration API has no cancellation operation, so the UI does not offer cancellation. Provider/API details are intentionally replaced with a generic localized retry message; server credentials and provider response bodies remain server-side.
- The interface language initially defaults to episode content language. Once selected, the PT-BR/EN preference lasts for the current browser page session, independently of episode language. Reloading defaults to content language again. Whole article is the default suggestion scope.
- The approved [#50 Penpot design](http://localhost:9001/#/view?file-id=5f95b9ac-b793-81b5-8008-f6332f924e3a) is implemented as two focused stages: narration preparation, then **Review Fish Audio script**. The second stage has its own heading, active progress step, version summary, read-only original/saved-narration comparison, Fish editor and approval confirmation. Back/next moves keyboard focus to the screen heading.
- Stage and language changes preserve unsaved narration, Fish text, suggestion edits, scope and selected paragraph in memory; they do not save or call the provider. Each save writes only the active stage's script (and selected voice on the Fish stage). The version summary distinguishes unsaved narration from saved comparison text without claiming that a manual review occurred. Leaving the script workflow or reloading discards unsaved work; there is no autosave or stage deep-link. These are local navigation defaults, not new API semantics.
- Fish Audio approval requires a saved, non-empty exact script and a second explicit confirmation. The server persists a SHA-256 digest and timestamp for that script version, and clears approval when a different script is saved. Approval is only a local editorial decision, not a workflow status label or an audio-generation command.

## Out of scope

No Fish Audio calls, audio generation/uploads, Transistor integration, cloud storage, or publishing are implemented. The service prompts for faithful adaptation but does not fact-check or guarantee output quality. Its verified documentation does not establish a complete fixed cue vocabulary, so tag compatibility is not validated. No live LLM provider was called during local tests; suggestion UI E2E uses a deterministic intercepted response, and provider error behavior uses a mocked failure.
