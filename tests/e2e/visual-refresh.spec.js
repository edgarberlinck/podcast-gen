const { test: base, expect } = require("@playwright/test");
const { readFileSync } = require("node:fs");

// Real delivered assets, fully intercepted browser traffic: no server/provider is used.
const origin = "http://studio.test";
const stamp = "2026-11-18T08:00:00Z";
const colors = {
  black: "rgb(17, 17, 17)", red: "rgb(181, 18, 34)", white: "rgb(255, 255, 255)",
  paper: "rgb(245, 244, 242)", safety: "rgb(255, 240, 241)", dark: "rgb(36, 34, 34)",
};
const test = base.extend({
  studio: async ({ page }, use) => {
    const episode = {
      id: "refresh-episode", title: "A deterministic editorial episode", description: "Local fixture only.",
      language: "en", status: "Script Review", updated_at: stamp,
      original_article: "Original paragraph one.\n\nOriginal paragraph two.",
      narration_script: "Separate saved narration.", fish_audio_script: "[calm] Separate Fish script.",
      fish_audio_approved_sha256: null, selected_voice_id: "voice-1",
    };
    const voice = { id: "voice-1", display_name: "Fixture narrator", fish_audio_id: "fake-voice", language: "en", availability: "available" };
    const file = { id: "approved-file", filename: "approved.wav", size_bytes: 16044, created_at: stamp, approval_status: "approved" };
    const state = { episode, files: [file], handoffs: [], publication: null, dashboard: [episode], handlers: new Map(), calls: [] };
    const unexpected = [];
    const assets = {
      "/": ["static/index.html", "text/html"],
      "/static/styles.css": ["static/styles.css", "text/css"],
      "/static/refresh.css": ["static/refresh.css", "text/css"],
      "/static/app.js": ["static/app.js", "text/javascript"],
      "/static/api.js": ["static/api.js", "text/javascript"],
    };
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const key = `${request.method()} ${url.pathname}`;
      if (url.origin === origin) {
        if (assets[url.pathname] && request.method() === "GET") {
          const [path, contentType] = assets[url.pathname];
          return route.fulfill({ contentType, body: readFileSync(path) });
        }
        state.calls.push(key);
        if (state.handlers.has(key)) return state.handlers.get(key)(route);
        if (request.method() === "GET") {
          const responses = {
            "/api/dashboard": { total_episodes: state.dashboard.length, awaiting_review: state.dashboard.length, recent_episodes: state.dashboard },
            "/api/episodes/refresh-episode": episode,
            "/api/voices": { voices: [voice] },
            "/api/episodes/refresh-episode/narration-suggestions": { suggestions: [] },
            "/api/episodes/refresh-episode/generation-handoffs": { handoffs: state.handoffs },
            "/api/episodes/refresh-episode/files": { files: state.files },
            "/api/episodes/refresh-episode/transistor": { publication: state.publication },
            "/api/transistor/shows": { shows: [{ id: "show-1", title: "Código & Cicatriz", time_zone: "America/Sao_Paulo" }] },
          };
          if (Object.hasOwn(responses, url.pathname)) return route.fulfill({ json: responses[url.pathname] });
          // Media failure is deliberate; decoding/playback is covered by audio-workflow.spec.js.
          if (url.pathname.startsWith("/api/files/")) return route.fulfill({ status: 404, body: "Fixture media unavailable" });
        }
      }
      unexpected.push(key);
      return route.abort("blockedbyclient");
    });
    await use(state);
    expect(unexpected, "No external or unhandled requests, including accidental mutations").toEqual([]);
  },
});

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

async function shell(page) {
  await expect(page.locator("body")).toHaveCSS("background-color", colors.paper);
  await expect(page.locator(".sidebar")).toHaveCSS("background-color", colors.black);
  await expect(page.locator(".brand-mark")).toHaveCSS("background-color", colors.red);
}

async function fits(page, selectors) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  for (const selector of selectors) {
    const element = page.locator(selector);
    await expect(element).toBeVisible();
    const box = await element.boundingBox();
    expect(box.x, `${selector} left edge`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${selector} right edge`).toBeLessThanOrEqual(page.viewportSize().width + 1);
  }
}

async function columns(page, left, right, mobile) {
  const a = await page.locator(left).boundingBox();
  const b = await page.locator(right).boundingBox();
  if (mobile) expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
  else expect(b.x).toBeGreaterThanOrEqual(a.x + a.width - 1);
}

async function keyboardFocus(page, target) {
  // Use real keyboard navigation to enable :focus-visible, not an injected CSS class.
  await target.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(target).toBeFocused();
  await expect(target).toHaveCSS("outline-color", colors.red);
  await expect(target).toHaveCSS("outline-style", "solid");
  await expect(target).toHaveCSS("outline-width", "3px");
  await expect(target).toHaveCSS("outline-offset", "3px");
}

async function modal(page, selector) {
  await expect(page.locator(selector)).toBeVisible();
  await expect(page.locator(selector)).toHaveCSS("background-color", colors.white);
  await expect(page.locator(selector)).toHaveCSS("color", "rgb(41, 37, 37)");
  await fits(page, [selector]);
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px visual refresh`, () => {
    test.use({ viewport });
    const mobile = viewport.width < 720;

    test("dashboard palette and responsive populated/loading/empty/error states", async ({ page, studio }) => {
      const pending = gate();
      studio.handlers.set("GET /api/dashboard", async (route) => {
        await pending.promise;
        return route.fulfill({ json: { recent_episodes: [] } });
      });
      try {
        await page.goto(origin);
        await expect(page.locator(".loading[role=status]")).toContainText("Carregando");
        await shell(page);
      } finally { pending.release(); }
      await expect(page.locator(".empty-state h2")).toContainText("Seu próximo episódio");
      await expect(page.locator(".empty-state")).toHaveCSS("background-color", colors.white);
      await fits(page, [".metrics", ".empty-state", ".activity-panel"]);
      await keyboardFocus(page, page.locator(".empty-state .button"));
      studio.handlers.set("GET /api/dashboard", (route) => route.fulfill({ status: 503, json: { error: { message: "Deterministic local failure" } } }));
      await page.reload();
      await expect(page.locator(".error-state[role=alert]")).toContainText("Não foi possível");
      await expect(page.locator(".error-state")).toHaveCSS("background-color", "rgb(255, 248, 248)");
      await keyboardFocus(page, page.locator('[data-action="retry"]'));
      studio.handlers.delete("GET /api/dashboard");
      await page.locator('[data-action="retry"]').press("Enter");
      await expect(page.locator(".continue-card h3")).toHaveText(studio.episode.title);
      await expect(page.locator(".metric:nth-child(3) .metric-value")).toHaveCSS("color", colors.red);
      await fits(page, [".continue-card", ".activity-panel", ".workflow-grid"]);
      await columns(page, ".dashboard-grid > section", ".activity-panel", mobile);
    });

    test("editorial safety, suggestion pending/error and script approval confirmation remain readable", async ({ page, studio }) => {
      const pending = gate();
      studio.handlers.set("POST /api/episodes/refresh-episode/narration-suggestions", async (route) => {
        await pending.promise;
        return route.fulfill({ status: 502, json: { error: { message: "Fixture suggestion failure" } } });
      });
      await page.goto(`${origin}/#scripts/refresh-episode`);
      await expect(page.locator(".suggestion-empty")).toBeVisible();
      await shell(page);
      await expect(page.locator(".editorial-safety")).toHaveCSS("background-color", colors.safety);
      await expect(page.locator(".editorial-safety p")).toHaveCSS("color", "rgb(97, 47, 50)");
      await fits(page, [".source-card", ".suggestion-card", ".draft-editor"]);
      await columns(page, ".source-card", ".suggestion-card", mobile);
      await keyboardFocus(page, page.locator(".source-paragraph").first());
      await page.locator(".source-paragraph").first().press("Enter");
      await expect(page.locator(".source-paragraph").first()).toHaveCSS("background-color", colors.safety);
      try {
        await page.locator('[data-action="request-suggestion"]').click();
        await expect(page.locator('[data-action="request-suggestion"]')).toBeDisabled();
        await expect(page.locator("#suggestion-status")).toContainText("Preparing suggestion");
        await fits(page, ["#suggestion-status", ".editorial-safety"]);
      } finally { pending.release(); }
      await expect(page.locator('#suggestion-status[role="alert"]')).toContainText("We couldn’t create this suggestion");
      await keyboardFocus(page, page.locator('[data-action="retry-suggestion"]'));
      await page.locator('[data-action="review-stage"][data-stage="fish"]').click();
      await expect(page.locator(".fish-approval-state.pending")).toHaveCSS("background-color", "rgb(255, 242, 216)");
      await fits(page, [".fish-review", ".approval-comparison"]);
      await columns(page, ".fish-review", ".approval-comparison", mobile);
      await page.locator('[data-action="open-approval"]').click();
      await modal(page, "#approval-dialog");
      await keyboardFocus(page, page.locator('[data-action="confirm-approval"]'));
      await page.keyboard.press("Escape");
      // All mutating operations other than the deterministic failed suggestion are blocked.
      expect(studio.calls.filter((call) => call.startsWith("POST"))).toEqual(["POST /api/episodes/refresh-episode/narration-suggestions"]);
    });

    test("dark Codex handoff, audio review and explicit confirmation have visible keyboard focus", async ({ page, studio }) => {
      studio.episode.fish_audio_approved_sha256 = "a".repeat(64);
      studio.episode.fish_audio_approved_at = stamp;
      studio.handoffs = [{ id: "handoff-1", status: "prepared", voice_name: "Fixture narrator", model: "drama-3", created_at: stamp, script: studio.episode.fish_audio_script }];
      studio.files.push({ ...studio.files[0], id: "pending-file", filename: "pending.wav", approval_status: "pending", handoff_id: "handoff-1" });
      await page.goto(`${origin}/#generation/refresh-episode`);
      const handoff = page.locator(".generation-handoff");
      await expect(handoff).toContainText("Awaiting your action in Codex");
      await shell(page);
      await expect(handoff).toHaveCSS("background-color", colors.black);
      for (const selector of ["strong", ":scope > span", "p", "label"]) {
        for (const node of await handoff.locator(selector).all()) await expect(node).toHaveCSS("color", colors.white);
      }
      await expect(handoff.locator("select")).toHaveCSS("background-color", colors.dark);
      await expect(handoff.locator("select")).toHaveCSS("color", colors.white);
      await expect(handoff.locator(".button")).toHaveCSS("background-color", colors.red);
      await expect(handoff.locator(".button")).toHaveCSS("color", colors.white);
      await keyboardFocus(page, handoff.locator("select"));
      await keyboardFocus(page, handoff.locator(".button"));
      await fits(page, [".generation-setup", ".handoff-panel", ".generation-history"]);
      await columns(page, ".generation-setup", ".handoff-panel", mobile);
      await page.locator('[data-action="prepare-handoff"]').click();
      await modal(page, "#handoff-confirm-dialog");
      await keyboardFocus(page, page.locator('[data-action="confirm-handoff"]'));
      await page.keyboard.press("Escape");
      await expect(page.locator(".approved-lock")).toHaveCSS("background-color", "rgb(232, 241, 234)");
      const approve = page.locator('[data-audio-version="pending-file"] [data-status="approved"]');
      await keyboardFocus(page, approve);
      await expect(page.locator('[data-audio-version="pending-file"]')).toHaveCSS("border-top-color", colors.red);
      await approve.press("Enter");
      await modal(page, "#audio-review-dialog");
      await keyboardFocus(page, page.locator('[data-action="confirm-audio-review"]'));
      await page.keyboard.press("Escape");
      expect(studio.calls.every((call) => call.startsWith("GET"))).toBe(true);
    });

    test("Transistor dark upload and separate publish/schedule confirmation screens", async ({ page, studio }) => {
      await page.goto(`${origin}/#transistor/refresh-episode`);
      await page.locator("#transistor-language").selectOption("en");
      const upload = page.locator(".transistor-upload");
      await expect(upload).toHaveCSS("background-color", colors.black);
      for (const selector of ["h2", ":scope > p:not(.field-help):not(.transistor-error)", ".upload-recap span"]) {
        for (const node of await upload.locator(selector).all()) await expect(node).toHaveCSS("color", colors.white);
      }
      await expect(upload.locator(".upload-recap")).toHaveCSS("background-color", colors.dark);
      await expect(upload.locator(".button.primary")).toHaveCSS("background-color", colors.red);
      await expect(upload.locator(".button.primary")).toHaveCSS("color", colors.white);
      await fits(page, [".transistor-metadata", ".transistor-upload", ".transistor-status"]);
      await columns(page, ".transistor-metadata", ".transistor-upload", mobile);
      await keyboardFocus(page, upload.locator(".button"));
      await upload.locator(".button").press("Enter");
      await modal(page, "#transistor-upload-dialog");
      await expect(page.locator('[data-action="confirm-transistor-upload"]')).toBeDisabled();
      await keyboardFocus(page, page.locator("#transistor-upload-consent"));
      await page.keyboard.press("Space");
      await keyboardFocus(page, page.locator('[data-action="confirm-transistor-upload"]'));
      await page.keyboard.press("Escape");

      // Render an already-uploaded draft; the actual upload/publish regression is in
      // transistor-publishing.spec.js. No duplicate workflow or remote mutation here.
      studio.publication = { status: "draft", remote_episode_id: "remote-fixture", file_id: "approved-file", show_id: "show-1", show_title: "Código & Cicatriz", title: studio.episode.title, show_time_zone: "America/Sao_Paulo", show_time_zone_supported: true };
      studio.handlers.set("POST /api/episodes/refresh-episode/transistor/refresh", (route) => route.fulfill({ json: { publication: studio.publication } }));
      await page.reload();
      await page.locator("#transistor-language").selectOption("en");
      await expect(page.locator(".transistor-status-chip.draft")).toHaveCSS("background-color", "rgb(255, 242, 216)");
      await expect(page.locator('[data-action="open-transistor-publish"]')).toBeDisabled();
      await page.locator('[data-action="refresh-transistor"]').click();
      await expect(page.locator('[data-action="open-transistor-publish"]')).toBeEnabled();
      await fits(page, [".transistor-next", ".transistor-publish-options"]);
      for (const action of ["published", "scheduled"]) {
        await page.locator(`input[name="transistor-action"][value="${action}"]`).check();
        if (action === "scheduled") await page.locator("#transistor-published-at").fill("2099-01-15T12:30");
        await page.locator('[data-action="open-transistor-publish"]').click();
        await modal(page, "#transistor-publish-dialog");
        await expect(page.locator('[data-action="confirm-transistor-publish"]')).toBeDisabled();
        await keyboardFocus(page, page.locator("#transistor-publish-consent"));
        await page.keyboard.press("Space");
        await keyboardFocus(page, page.locator('[data-action="confirm-transistor-publish"]'));
        await page.keyboard.press("Escape");
      }
      expect(studio.calls.filter((call) => call.startsWith("POST"))).toEqual(["POST /api/episodes/refresh-episode/transistor/refresh"]);
    });

    test("known delivery gap: upload consent uses the approved dark surface and white copy", async ({ page, studio }, testInfo) => {
      await page.goto(`${origin}/#transistor/refresh-episode`);
      await page.locator("#transistor-language").selectOption("en");
      await page.locator('[data-action="open-transistor-upload"]').click();
      const consent = page.locator("#transistor-upload-dialog .transistor-consent");
      await expect(consent).toBeVisible();
      const actual = await consent.evaluate((node) => ({
        background: getComputedStyle(node).backgroundColor,
        copy: getComputedStyle(node.querySelector("span")).color,
        insideUploadPanel: !!node.closest(".transistor-upload"),
      }));
      await testInfo.attach("rendered-consent.json", { body: JSON.stringify(actual, null, 2), contentType: "application/json" });
      expect(studio.calls.every((call) => call.startsWith("GET"))).toBe(true);
      // PR #16's rule requires .transistor-upload ancestry, but this delivered
      // dialog is its sibling. Keep the desired check runnable without changing UI.
      // Unexpected pass requires removing this annotation after the product fix.
      test.fail(true, "Ticket #70: consent is outside .transistor-upload; approved nested dark rule does not match the delivered DOM.");
      expect.soft(actual.background).toBe(colors.dark);
      expect.soft(actual.copy).toBe(colors.white);
    });
  });
}
