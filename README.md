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

## Phase 4 audio generation and review interface

The generation screen presents the exact saved, approved Fish Audio script, its approval time/digest, and a registered voice selection that is persisted only after the user saves it. It displays the documented Drama 3 preference (`drama-3`) but does not offer extra parameters because the actual MCP schema and model-selector support remain unverified. Preparing a handoff requires explicit confirmation and only creates a local snapshot; any paid Fish operation still requires the user to inspect and separately confirm the request in Codex. The language switch changes interface copy only, not episode content language.

The local audio history retains each import, shows voice/model/import timestamp and the native player's duration when browser metadata is available, and provides playback and download controls. New imported takes remain pending until an explicit approve/reject confirmation. Approved and rejected files stay in history; a fresh import gets its own generation directory and cannot replace an approved recording. The UI displays the intended handoff provenance but cannot prove what a user-run Codex operation actually synthesized. Audio bytes in automated UI tests are deterministic placeholders, not playable Fish Audio output.

UI assumptions: unknown duration is shown as unavailable rather than estimated; no new generation parameters are inferred from the REST API; review confirmations are local-only and never publish/upload; unknown live MCP/schema errors are represented with safe local guidance rather than vendor traces. The tests use fake local API responses for frontend state and do not call Fish Audio or Transistor.

## Fish Audio workflow boundary (Phase 4, user-mediated)

The local studio implements a manual Codex handoff and local audio import only. It never starts generation, invokes Codex, connects to Fish Audio/MCP, calls the Fish REST API, or publishes. Starting audio generation requires a separate explicit user action in the authenticated Codex session after the user inspects the actual MCP tool schema. This environment did not expose a live MCP connection or schema, so no MCP tool names/arguments are assumed.

To prepare a handoff, save and explicitly approve the exact Fish Audio script, register/select an available voice that matches the episode language, then open the episode's Fish-script review and choose **Prepare audio handoff**. The server requires a second explicit confirmation and snapshots the exact script and SHA-256, selected registered voice ID, Fish voice identifier, and model preference `Fish Audio Drama 3` (`drama-3`). It does not update the episode to “Generating Audio”. The downloaded JSON is a local handoff record, not an MCP request schema. In Codex, inspect its live Fish tool schema, use only documented fields, and confirm any generation there. The model identifier is a documented Fish preference, but its acceptance as an MCP parameter is unverified; do not infer that the MCP will honor it.

After the user has manually generated and downloaded an output, select it on that pending handoff and import it. The API validates the local filename/type/size, stores the file in a fresh immutable `generations/<uuid>/` directory, associates provenance to the handoff, and records the model, selected voice, approved-script digest, and review status. Existing audio bytes are never overwritten. Each handoff accepts one import; another attempt needs a new explicitly prepared handoff. A failed Codex/MCP attempt can be recorded by category without retaining vendor error details; import validation failures leave the handoff retryable. Imported takes start pending human audio review; approval/rejection are explicit and preserve the local audio file. Imported files are playable and downloadable locally.

Additional API routes:

- `POST /api/episodes/{id}/generation-handoffs` with `{"confirm_handoff":true}` prepares the immutable local request snapshot; `GET` lists handoffs and their `prepared`, `imported`, or `failed` status.
- `POST /api/episodes/{id}/generation-handoffs/{handoff-id}/import?filename=take.mp3` accepts raw local audio bytes and creates a new generation (same 500 MiB/audio extension limits as the local library).
- `POST /api/episodes/{id}/generation-handoffs/{handoff-id}/failure` records an explicit failure category (`mcp_error`, `cancelled`, `output_unavailable`, `other`); no arbitrary provider error text is saved.
- `POST /api/files/{file-id}/review` with `{"status":"approved"|"rejected","confirm_review":true}` records an explicit review decision without changing/deleting audio bytes.

## AI narration suggestions (Phase 3 service)

`POST /api/episodes/{id}/narration-suggestions` accepts `{"scope":"article"}` to suggest for the complete original article, or `{"scope":"paragraph","paragraph_index":0}` to regenerate one zero-based, blank-line-delimited paragraph. `GET` on the same route returns the episode's stored suggestions. The source text and SHA-256 digest, suggestion, provider/model, scope/index, timestamp, and `approval_status: "pending"` are stored in a separate `narration_suggestions` table. Suggestion requests never change `original_article`, `narration_script`, or `fish_audio_script`; there is no automatic approval or application route.

The replaceable provider boundary is `SuggestionProvider` in `narration.py`. The included OpenAI-compatible Chat Completions adapter is configured on the local server with `LLM_API_KEY`, optional `LLM_MODEL` (defaults to `gpt-4o-mini`), and optional `LLM_BASE_URL` (defaults to `https://api.openai.com/v1`). Keep these variables in the server process environment or another local secret manager; never expose them to browser code or commit real credentials. `LLM_BASE_URL` requires HTTPS except for loopback development endpoints. Without `LLM_API_KEY`, suggestion requests return `503 suggestion_provider_unavailable`; there is no pretend/mock result in production. Provider HTTP errors do not include response bodies or credentials in API errors. This adapter uses a server-side network call and sends the selected article text to the configured provider, so configure it only if that data transfer is acceptable. No live provider request was performed for this implementation.

The prompt asks for faithful, lightly adapted delivery, preserved paragraph structure, sparse bracketed plain-language cues, and no new facts. These instructions constrain the model but cannot guarantee editorial correctness; all saved output remains an unapproved suggestion for human review. The verified Phase 1 report supports Drama 3 plain-language directions and pauses, not a complete fixed cue vocabulary; this service does not call Fish Audio or claim cue compatibility beyond that documented guidance. Live Fish Audio/MCP invocation and Transistor publishing remain out of scope; the manual handoff and local import are documented separately above.

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

The Chromium suite covers dashboard loading/empty/error-and-retry states, semantic landmarks/labels, responsive layout, Portuguese and English episode workflows, voice metadata, separate scripts, deliberate original edits, revision persistence/restart, article/paragraph suggestion scopes and source text, paragraph preservation, explicit editing/use/save, exact-script approval/reset, and persistence across a real local server restart. A test-only WSGI harness injects a deterministic fake into the actual provider boundary for successful and failing service requests; the separate unconfigured-provider test runs against the real app with `LLM_API_KEY` explicitly empty. Assertions verify pending records and unchanged article/scripts before deliberate actions, and verify provider/credential sentinels do not appear in UI or API errors. A delayed browser fixture also verifies PT/EN interface switching while paragraph requests remain pending on both PT and EN content episodes, preserving localized loading copy, source language/text, paragraph selection, and saved narration/Fish scripts. No live LLM credentials or requests are used. The responsive assertion checks horizontal overflow at a narrow viewport; this is not a full WCAG audit or a cross-browser matrix.

Local verification after PR #6 review fixes:

- `python -m pytest --cov=. --cov-report=term`: 120 passed, 95% including tests (application files: `app.py` 89%, `narration.py` 92%). `python -m pytest --cov=app --cov=narration --cov-report=term-missing` reports 89% combined application coverage.
- `python -m ruff check .`: passed.
- `npm ci`, `npm test`: passed, 9 Node tests (5 API and 4 jsdom UI unit tests).
- `node --experimental-test-coverage --test tests/*.test.js`: API client 100% line coverage; whole `static/app.js` 55.05% from the focused unit tests alone. This is below the 80% target for that entire legacy UI file; browser E2E exercises additional paths but is not included in this unit metric.
- `node --check static/api.js`, `node --check static/app.js`, `git diff --check`: passed.
- `npm ci`: passed; 31 development packages installed, 0 reported vulnerabilities.
- `npx playwright install chromium`: passed.
- `npm run test:e2e -- --grep "pending paragraph suggestion"`: 2 Chromium tests passed for pending-state interface switching on PT and EN content episodes.
- `npm run test:e2e`: 11 Chromium tests passed locally. Includes 2 narration service/UI tests using an injected deterministic provider fake and actual app API, an actual unconfigured-provider API/UI test, mocked intercepted error/loading and locale-switch cases, scope/index/source validation, preservation of all three texts before deliberate edits, persistence of pending suggestions and approval across server restart, manual edit/use/save, exact-script approval/reset, and PT/EN navigation behavior.
- No live LLM provider was configured or called. Successful suggestion output came from a local deterministic fake; pending locale-state behavior and some error/loading paths used delayed/browser intercept fixtures. No LLM output quality was evaluated and no credentials were sent to an external provider.

No live LLM provider was called. These are local results, not CI or deployment evidence. No remote QA deployment, non-Chromium browser, full WCAG audit, Fish Audio generation, or publishing integration was exercised.

### UI integration assumptions and boundaries

- The backend dashboard contract has counts and recent episodes, but no event/activity feed or generated-audio approval metric. The UI therefore presents recent episode updates as recent activity, uses the API's combined editorial/audio-review count, and does not invent an audio-approval count.
- Voice records are local user-entered metadata. Availability is descriptive only; no Fish Audio request or identifier validation occurs.
- The published count is a local status label, not evidence that content was sent to any external platform.
- Article import accepts text/Markdown files. Phase 4 audio handoff, local file import, playback, version history, and explicit audio review are available on the episode generation screen; no live provider call is made.
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

### Phase 4 verification evidence (ticket #55)

Exact commands run:

```sh
npm ci
python -m pytest --cov=app --cov=narration --cov-report=term-missing
python -m ruff check .
npm test
node --check static/api.js
node --check static/app.js
node --check tests/e2e/core-workflows.spec.js
npm run test:e2e
node --experimental-test-coverage --test tests/frontend_api.test.js
git diff --check
```

Results: Python passed 126 tests with app.py 89% and narration.py 92% line coverage (90% combined); Ruff passed; Node unit/jsdom passed 11 tests; Chromium Playwright passed 12 tests; the API client module measured 100% line coverage. The Node API/E2E workflow uses deterministic fake audio bytes, not a real audio codec/output. It exercises the real local WSGI API, SQLite and temporary filesystem. Existing LLM E2E paths use deterministic provider fakes or browser intercepts; provider-unconfigured behavior uses the actual local API with no key. No Fish Audio/MCP call, Codex tool invocation, OAuth, actual audio generation, live LLM call, or Transistor operation was run. No output quality was evaluated.

The local app behavior exercised as real includes handoff approval/voice checks, persisted snapshots, explicit status transitions, file type/path/size validation, creating a separate generation directory, downloading local files, and preserving an existing approved file's bytes. Real target Codex schema, model-selector acceptance, Fish result transfer, audio playback/codec, deployment QA, cross-browser QA, and full WCAG remain unverified. In particular, imported test bytes are not playable vendor output.

## Out of scope

No live Fish Audio MCP connection/call or audio generation was performed or implemented; the Codex handoff is user-mediated, and imported test audio is a deterministic local fake. No direct Fish REST integration, Transistor integration, cloud storage, or publishing is included. The service prompts for faithful adaptation but does not fact-check or guarantee output quality. The verified documentation does not establish a complete fixed cue vocabulary, so tag compatibility is not validated. No live LLM provider was called during local tests; narration E2E suggestion behavior uses deterministic browser fixtures and an injected local provider fake, while provider-unconfigured behavior uses the real local API without a configured key.
