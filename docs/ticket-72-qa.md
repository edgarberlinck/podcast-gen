# Ticket #72 independent QA follow-up

Date: 2026-11-18. Scope: independently verify merged PR #18 and its rendered consent regression coverage against the scenarios recorded in the Visual Refresh (#69) and Visual Refresh QA (#70) wiki pages. No product or test changes were needed; existing coverage was sufficient.

## Review and coverage

PR #18 scopes the consent styling to `#transistor-upload-dialog .transistor-consent`; its existing rendered upload-dialog browser test asserts computed background (`#242222`), border (`#625D5D`), and white label copy at 1440×1000 and 390×844. The former expected-failure diagnostics are removed.

The visual-refresh test covers representative dashboard, editorial, handoff/audio-review, and publishing UI states at desktop/mobile viewport sizes, including the consent surface. The retained local browser suites cover source/script separation and explicit approval, confirmed handoff and preserved audio versions, and separate upload/publish/schedule confirmations. The broader workflow checks use local deterministic fixtures or intercepted requests. No additional test was added.

## Independent checks

Run from the repository root:

```sh
npm ci
npm run test:e2e -- tests/e2e/visual-refresh.spec.js
npm run test:e2e
npm test
python -m pytest --cov=. --cov-report=term
python -m ruff check .
node --check tests/e2e/visual-refresh.spec.js
node --check static/app.js
git diff --check
```

Results:

- `npm ci`: passed; 0 vulnerabilities.
- Focused Chromium suite: **8 passed**.
- Full Chromium suite: **27 passed**, no expected failures.
- Node unit tests: **28 passed**.
- Python: **140 passed**, **94%** combined line coverage including tests (`app.py` 88%, `narration.py` 92%, `transistor.py` 83%).
- Ruff, both JavaScript syntax checks, and `git diff --check`: passed.
- `package.json` has no npm lint or build script.

## Assumptions and evidence limits

This verification used deterministic local fixtures and intercepted requests only. No live LLM, Fish Audio, Codex MCP, or Transistor service was called; no external upload, publication, scheduling, or paid generation was performed. These results are representative computed-style/viewport and workflow regression checks, not screenshot baselines. No QA deployment, real-device evaluation, full WCAG/contrast audit, or cross-browser coverage is claimed.
