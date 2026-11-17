const { test, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const net = require("node:net");

let server;
let dataDir;
let port;
let baseURL;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).on("error", reject));
  const selected = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return selected;
}

async function startServer() {
  server = spawn("python", [path.resolve(__dirname, "fake_provider_server.py")], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, STUDIO_HOST: "127.0.0.1", STUDIO_PORT: String(port), STUDIO_DATA_DIR: dataDir },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Fake-provider app exited with code ${server.exitCode}`);
    try {
      const response = await fetch(`${baseURL}/health`);
      if (response.ok) return;
    } catch { /* Wait for the loopback WSGI server to start. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Fake-provider app did not become ready within 10 seconds");
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const child = server;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  server = null;
}

async function getEpisode(request, id) {
  const response = await request.get(`${baseURL}/api/episodes/${id}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function getSuggestions(request, id) {
  const response = await request.get(`${baseURL}/api/episodes/${id}/narration-suggestions`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).suggestions;
}

test.beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "codigo-cicatriz-fake-provider-e2e-"));
  port = await freePort();
  baseURL = `http://127.0.0.1:${port}`;
  await startServer();
});

test.afterAll(async () => {
  await stopServer();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("real local UI and injectable fake provider preserve, review and persist suggestions and approval", async ({ page }) => {
  const original = "Source paragraph one.\n\nSource paragraph two.\n\nSource paragraph three.";
  const originalNarration = "Saved narration one.\n\nSaved narration two.\n\nSaved narration three.";
  const fishScript = "[measured]Saved Fish script stays independent.";
  const created = await page.request.post(`${baseURL}/api/episodes`, {
    data: { title: "Deterministic narration E2E", language: "en", original_article: original },
  });
  expect(created.status()).toBe(201);
  const episode = await created.json();
  await page.request.put(`${baseURL}/api/episodes/${episode.id}/scripts/narration`, { data: { content: originalNarration } });
  await page.request.put(`${baseURL}/api/episodes/${episode.id}/scripts/fish-audio`, { data: { content: fishScript } });

  const before = await getEpisode(page.request, episode.id);
  expect(before.original_article).toBe(original);
  expect(before.narration_script).toBe(originalNarration);
  expect(before.fish_audio_script).toBe(fishScript);
  expect(before.fish_audio_approved_sha256).toBeNull();
  const requestBodies = [];
  page.on("request", (request) => {
    if (request.url().endsWith(`/api/episodes/${episode.id}/narration-suggestions`) && request.method() === "POST") {
      requestBodies.push(request.postDataJSON());
    }
  });

  await page.goto(`${baseURL}/#scripts/${episode.id}`);
  await expect(page.getByRole("heading", { name: "Prepare the narration draft" })).toBeVisible();
  await expect(page.locator(".source-paragraphs")).toContainText("Source paragraph two.");
  await expect(page.getByLabel("Editable narration draft")).toHaveValue(originalNarration);

  // Whole-article request: observe accessible pending state, exact scope and source,
  // and ensure no script or article mutates merely because a suggestion was returned.
  await page.getByRole("button", { name: "✦ Request suggestion" }).click();
  await expect(page.getByRole("button", { name: /Preparing suggestion/ })).toBeDisabled();
  await expect(page.getByLabel("Suggestion · editable")).toHaveValue(`[fixture article en] ${original}`);
  expect(requestBodies[0]).toEqual({ scope: "article" });
  let suggestions = await getSuggestions(page.request, episode.id);
  expect(suggestions).toHaveLength(1);
  expect(suggestions[0]).toMatchObject({ scope: "article", paragraph_index: null, source_text: original, approval_status: "pending" });
  let current = await getEpisode(page.request, episode.id);
  expect(current.original_article).toBe(original);
  expect(current.narration_script).toBe(originalNarration);
  expect(current.fish_audio_script).toBe(fishScript);
  expect(current.fish_audio_approved_sha256).toBeNull();

  // Read-only source versus editable suggestion comparison; rejecting the suggestion
  // leaves the saved narration unchanged. Then exercise zero-based paragraph scope.
  await expect(page.locator(".suggestion-compare article")).toContainText(original);
  await page.getByRole("button", { name: "Keep current text" }).click();
  await expect(page.getByLabel("Editable narration draft")).toHaveValue(originalNarration);
  await page.getByRole("button", { name: /Select paragraph 2/ }).click();
  await page.getByRole("button", { name: "✦ Request suggestion" }).click();
  await expect(page.getByLabel("Suggestion · editable")).toHaveValue("[fixture paragraph en] Source paragraph two.");
  expect(requestBodies[1]).toEqual({ scope: "paragraph", paragraph_index: 1 });
  suggestions = await getSuggestions(page.request, episode.id);
  expect(suggestions).toHaveLength(2);
  expect(suggestions.find((suggestion) => suggestion.scope === "paragraph")).toMatchObject({ paragraph_index: 1, source_text: "Source paragraph two.", approval_status: "pending" });
  current = await getEpisode(page.request, episode.id);
  expect(current.original_article).toBe(original);
  expect(current.narration_script).toBe(originalNarration);
  expect(current.fish_audio_script).toBe(fishScript);
  expect(current.fish_audio_approved_sha256).toBeNull();

  // Deliberate use, manual edit, and explicit save change only narration.
  await page.getByLabel("Suggestion · editable").fill("Edited paragraph two after review.");
  await page.getByRole("button", { name: "Use in draft" }).click();
  await expect(page.getByLabel("Editable narration draft")).toHaveValue(
    "Saved narration one.\n\nEdited paragraph two after review.\n\nSaved narration three.",
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toContainText("Current script saved locally");
  current = await getEpisode(page.request, episode.id);
  expect(current.original_article).toBe(original);
  expect(current.narration_script).toBe("Saved narration one.\n\nEdited paragraph two after review.\n\nSaved narration three.");
  expect(current.fish_audio_script).toBe(fishScript);
  expect(current.fish_audio_approved_sha256).toBeNull();

  // Save exact Fish script separately and explicitly approve it.
  await page.getByRole("button", { name: "Review Fish Audio script →" }).click();
  await expect(page.getByLabel("Original article for comparison")).toHaveValue(original);
  await expect(page.getByLabel("Saved narration draft")).toHaveValue(current.narration_script);
  await page.getByRole("button", { name: "Approve this saved version" }).click();
  await expect(page.getByRole("button", { name: "Yes, approve this version" })).toBeVisible();
  await page.getByRole("button", { name: "Yes, approve this version" }).click();
  await expect(page.getByText("This exact saved version is approved")).toBeVisible();
  current = await getEpisode(page.request, episode.id);
  expect(current.fish_audio_approved_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(current.original_article).toBe(original);
  expect(current.fish_audio_script).toBe(fishScript);

  // Restart the actual WSGI server on the same SQLite directory: separately stored
  // pending suggestions, scripts and exact-version approval all survive.
  const approvedDigest = current.fish_audio_approved_sha256;
  await stopServer();
  await startServer();
  suggestions = await getSuggestions(page.request, episode.id);
  expect(suggestions).toHaveLength(2);
  expect(suggestions.every((suggestion) => suggestion.approval_status === "pending")).toBeTruthy();
  expect(suggestions.map((suggestion) => [suggestion.scope, suggestion.paragraph_index])).toEqual(expect.arrayContaining([
    ["paragraph", 1], ["article", null],
  ]));
  current = await getEpisode(page.request, episode.id);
  expect(current.fish_audio_approved_sha256).toBe(approvedDigest);
  expect(current.original_article).toBe(original);
  expect(current.narration_script).toBe("Saved narration one.\n\nEdited paragraph two after review.\n\nSaved narration three.");
  expect(current.fish_audio_script).toBe(fishScript);
  await page.reload();
  await page.getByRole("button", { name: "Review Fish Audio script →" }).click();
  await expect(page.getByText("This exact saved version is approved")).toBeVisible();

  // A changed, separately saved Fish script resets approval and cannot affect source/narration.
  await page.getByLabel("Editable Fish Audio script").fill(`${fishScript} edited`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Awaiting your decision")).toBeVisible();
  current = await getEpisode(page.request, episode.id);
  expect(current.original_article).toBe(original);
  expect(current.narration_script).toBe("Saved narration one.\n\nEdited paragraph two after review.\n\nSaved narration three.");
  expect(current.fish_audio_script).toBe(`${fishScript} edited`);
  expect(current.fish_audio_approved_sha256).toBeNull();
});

test("injectable fake provider failures are accessible, retryable and sanitized", async ({ page }) => {
  const source = "FAIL_PROVIDER_SENTINEL: do not expose this provider trace.";
  const created = await page.request.post(`${baseURL}/api/episodes`, {
    data: { title: "Provider failure safety", language: "en", original_article: source },
  });
  const episode = await created.json();
  let attempts = 0;
  page.on("request", (request) => {
    if (request.url().endsWith(`/api/episodes/${episode.id}/narration-suggestions`) && request.method() === "POST") attempts += 1;
  });
  await page.goto(`${baseURL}/#scripts/${episode.id}`);
  await page.getByRole("button", { name: "✦ Request suggestion" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("We couldn’t create this suggestion");
  await expect(alert).toContainText("Try again");
  await expect(alert).not.toContainText("PRIVATE_PROVIDER_TRACE");
  await expect(alert).not.toContainText("secret-token");
  const response = await page.request.post(`${baseURL}/api/episodes/${episode.id}/narration-suggestions`, { data: { scope: "article" } });
  expect(response.status()).toBe(502);
  const errorBody = await response.text();
  expect(errorBody).not.toContain("PRIVATE_PROVIDER_TRACE");
  expect(errorBody).not.toContain("secret-token");
  expect((await getSuggestions(page.request, episode.id))).toHaveLength(0);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(alert).toContainText("We couldn’t create this suggestion");
  expect(attempts).toBe(2);
});
