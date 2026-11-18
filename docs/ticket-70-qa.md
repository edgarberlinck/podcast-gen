# Ticket #70 responsive visual-refresh E2E evidence

Baseline: merged PR #16 (`e228f88`), checked on 2026-11-18. On startup, `git status`, `git ls-files -u`, and the unmerged diff were clean; there was no merge in progress or conflict to resolve. This change adds tests and documentation only, not product features or styling.

## Coverage added (without duplicating existing safeguards)

`tests/e2e/visual-refresh.spec.js` exercises the **actual delivered HTML/CSS/JavaScript** at 1440×1000 and 390×844 in Chromium. It serves those assets via Playwright interception at `http://studio.test`; this is an intercepted test origin, not a deployment. Every API response is a deterministic in-memory fixture, with fixed timestamps and explicit promise gates (no timed sleeps). Unexpected requests, including external traffic or unplanned mutations, are blocked and fail fixture teardown.

- Dashboard: populated, loading, empty, error/retry; black sidebar, red accent, off-white page; horizontal bounds and desktop columns/mobile stacking.
- Editorial: pale-red safety surface/readable copy, selected paragraphs, suggestion empty/pending/error states, amber pending approval, source/comparison layout, and explicit script-approval dialog.
- Audio: dark Codex handoff/white copy/red action, dark selector, pending handoff, green preserved-audio badge, version-card focus border, handoff and audio-review dialogs.
- Transistor: dark upload panel, dark recap with white copy, red action, responsive metadata/upload layout, upload dialog and consent gating, draft status and separately confirmed publish/schedule dialogs. An already-uploaded draft is fixture data; status refresh is mocked. No upload/publish/schedule endpoint is invoked by this new suite.
- Important buttons and controls use real Tab/Shift+Tab navigation to assert the computed red 3px focus outline with 3px offset. Dialog bounds and readable white-modal/dark-copy styles are checked.

Existing regression coverage is retained and rerun rather than reimplemented:

| Safeguard | Existing browser evidence |
| --- | --- |
| Suggestions preserve original/other scripts and never auto-approve | `narration-suggestions.spec.js` real local app + injectable fake; `core-workflows.spec.js` PT review flow |
| Handoff requires confirmation; prerequisite and cancellation/error gates | `audio-workflow.spec.js`; `core-workflows.spec.js` |
| Imported generations retain prior approved bytes/metadata and independent review | `audio-workflow.spec.js` local WAV imports and restart checks |
| Upload differs from separately confirmed publish/schedule; pending/error/uncertain outcomes | `transistor-publishing.spec.js` intercepted APIs |

## Known acceptance gap: consent selector does not match the delivered DOM

At **both widths**, opening the delivered upload confirmation shows:

```json
{"background":"rgb(255, 255, 255)","copy":"rgb(41, 37, 37)","insideUploadPanel":false}
```

`static/refresh.css` styles `.transistor-upload .transistor-consent`, but `static/app.js` renders `#transistor-upload-dialog` as a sibling of `.transistor-upload`, not its descendant. Thus the intended `#242222`/white consent treatment is not delivered; the existing stylesheet-regex unit test cannot detect this. The nested **recap** is dark/white and passes browser checks; it is not the consent card.

Two narrowly scoped runnable tests named `known delivery gap` assert the desired consent background and copy colors using `test.fail` (expected failure), attaching `rendered-consent.json`. Setup/visibility/network assertions occur before the annotation. **These are not successful visual acceptance checks**, even though Playwright's final aggregate labels expected outcomes as passed. They must be unmarked after a product correction; an unexpected pass fails the run. Product code is unchanged per ticket scope; Lady has been notified. Full consent visual conformance remains open.

## Exact local commands and results

Run from the repository root (Chromium was already installed in this workspace; on a fresh machine install it with `npx playwright install chromium`):

```sh
npm ci
npm test
npm run test:e2e -- tests/e2e/visual-refresh.spec.js
npm run test:e2e
npm run test:e2e -- tests/e2e/visual-refresh.spec.js --repeat-each=3
npm run test:e2e -- tests/e2e/visual-refresh.spec.js --reporter=json
node --experimental-test-coverage --test tests/*.test.js
python -m pytest --cov=. --cov-report=term
python -m ruff check .
node --check tests/e2e/visual-refresh.spec.js
node --check static/app.js
git diff --check
```

Results:

- `npm ci`: passed, 0 vulnerabilities. Node unit tests: **28 passed**.
- Focused refresh suite: **8 ordinary passes + 2 expected failures**. Full Chromium suite: **27 ordinary passes + 2 expected failures** (19 pre-existing safeguard tests pass). No skipped or unexpected failures.
- Three-repeat stability run: **24 ordinary passes + 6 expected failures**, no unexpected failures. JSON reporter independently confirmed both consent results had `expectedStatus: failed` and actual `status: failed`, with the computed values above.
- Python: **140 passed**, **94%** combined line coverage (includes tests); production files: `app.py` **88%**, `narration.py` **92%**, `transistor.py` **83%**.
- Node unit-only coverage: **63.59%** overall (includes test files), `static/api.js` **100%**, `static/app.js` **36.67%**. This does not measure browser-executed code; no claim of 80% frontend coverage is made. No production behavior was changed.
- Ruff, JS syntax checks and whitespace checks passed. There are no npm `lint` or `build` scripts (`npm run` inspected); this app serves static assets directly, so neither command exists to run.
- During test development an initial error-background assertion expected white; the delivered error override is pale red `#FFF8F8`. Corrected the test expectation from the stylesheet and reran successfully; no app change was made.

## Assumptions and limitations

Representative layout and computed-style assertions, not pixel-perfect screenshot baselines; desktop/mobile viewport simulation in Chromium only, not real-device or cross-browser coverage. No full WCAG/contrast audit was performed. Media failure is deliberate in the new fixtures; playable real local WAV coverage remains in the existing audio suite. All provider evidence is mocked/faked: no LLM, Fish Audio, Codex MCP or Transistor requests, paid generation, external upload, publication or scheduling were performed. Local persistence evidence comes from existing temporary SQLite/WAV tests, not these in-memory visual fixtures. No QA deployment was made.
