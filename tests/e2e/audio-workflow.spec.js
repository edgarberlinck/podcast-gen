const { test, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { createHash } = require("node:crypto");

let server;
let dataDir;
let port;
let baseURL;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).on("error", reject));
  const { port: selected } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return selected;
}

function startServer() {
  server = spawn("python", ["app.py"], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, LLM_API_KEY: "", STUDIO_HOST: "127.0.0.1", STUDIO_PORT: String(port), STUDIO_DATA_DIR: dataDir },
    stdio: "ignore",
  });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const check = async () => {
      if (server.exitCode !== null) return reject(new Error(`Local app exited with code ${server.exitCode}`));
      try {
        const response = await fetch(`${baseURL}/health`);
        if (response.ok) return resolve();
      } catch { /* Wait for the loopback server. */ }
      if (Date.now() > deadline) return reject(new Error("Local app did not become ready within 10 seconds"));
      setTimeout(check, 100);
    };
    check();
  });
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const child = server;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  server = null;
}

function oneSecondSilentWav() {
  const sampleRate = 8_000;
  const samples = sampleRate;
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function createEpisode(page, { title = "Audio QA", language = "en", approved = true, voice = "available", voiceLanguage = language } = {}) {
  const created = await page.request.post(`${baseURL}/api/episodes`, {
    data: { title, language, original_article: "A source article for local audio workflow QA." },
  });
  expect(created.status()).toBe(201);
  const episode = await created.json();
  let registeredVoice;
  if (voice !== "none") {
    const result = await page.request.post(`${baseURL}/api/voices`, {
      data: { display_name: "Local QA narrator", fish_audio_id: `local-fake-${episode.id}`, language: voiceLanguage, availability: voice },
    });
    expect(result.status()).toBe(201);
    registeredVoice = await result.json();
    await page.request.patch(`${baseURL}/api/episodes/${episode.id}`, { data: { selected_voice_id: registeredVoice.id } });
  }
  const script = "[calm]This is a deterministic local test script.";
  await page.request.put(`${baseURL}/api/episodes/${episode.id}/scripts/fish-audio`, { data: { content: script } });
  if (approved) {
    const result = await page.request.post(`${baseURL}/api/episodes/${episode.id}/scripts/fish-audio-approval`, {
      data: { content: script, confirm_approval: true },
    });
    expect(result.status()).toBe(200);
  }
  return { episode, voice: registeredVoice, script };
}

async function approveLocalAudio(page, episodeId, filename, bytes) {
  const upload = await page.request.post(`${baseURL}/api/episodes/${episodeId}/files?filename=${encodeURIComponent(filename)}`, {
    data: bytes, headers: { "Content-Type": "audio/wav" },
  });
  expect(upload.status()).toBe(201);
  const record = await upload.json();
  const reviewed = await page.request.post(`${baseURL}/api/files/${record.id}/review`, {
    data: { status: "approved", confirm_review: true },
  });
  expect(reviewed.status()).toBe(200);
  return { ...record, approval_status: "approved" };
}

async function expectEpisodeNotGenerating(page, episodeId) {
  const response = await page.request.get(`${baseURL}/api/episodes/${episodeId}`);
  expect(response.status()).toBe(200);
  const persistedEpisode = await response.json();
  expect(persistedEpisode.status).not.toBe("Generating Audio");
}

async function prepareInUi(page, episodeId) {
  await page.getByRole("button", { name: "Prepare Codex handoff" }).click();
  await expect(page.getByRole("dialog", { name: "Prepare request for Codex?" })).toBeVisible();
  await page.getByRole("button", { name: "Yes, prepare local handoff" }).click();
  await expect(page.getByText("Awaiting your action in Codex").last()).toBeVisible();
  await expectEpisodeNotGenerating(page, episodeId);
}

test.beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "codigo-cicatriz-audio-e2e-"));
  port = await freePort();
  baseURL = `http://127.0.0.1:${port}`;
  await startServer();
});

test.afterAll(async () => {
  await stopServer();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("handoff prerequisites require an approved exact script and matching available registered voice", async ({ page }) => {
  const noApproval = await createEpisode(page, { title: "No script approval", approved: false });
  const noApprovalResult = await page.request.post(`${baseURL}/api/episodes/${noApproval.episode.id}/generation-handoffs`, { data: { confirm_handoff: true } });
  expect(noApprovalResult.status()).toBe(409);
  expect((await noApprovalResult.json()).error.code).toBe("script_not_approved");
  await page.goto(`${baseURL}/#generation/${noApproval.episode.id}`);
  await expect(page.getByRole("button", { name: "Prepare Codex handoff" })).toBeDisabled();

  const noVoice = await createEpisode(page, { title: "No registered voice", voice: "none" });
  const noVoiceResult = await page.request.post(`${baseURL}/api/episodes/${noVoice.episode.id}/generation-handoffs`, { data: { confirm_handoff: true } });
  expect(noVoiceResult.status()).toBe(409);
  expect((await noVoiceResult.json()).error.code).toBe("voice_not_selected");
  await page.goto(`${baseURL}/#generation/${noVoice.episode.id}`);
  await expect(page.getByRole("button", { name: "Prepare Codex handoff" })).toBeDisabled();

  const unavailable = await createEpisode(page, { title: "Unavailable voice", voice: "unavailable" });
  const unavailableResult = await page.request.post(`${baseURL}/api/episodes/${unavailable.episode.id}/generation-handoffs`, { data: { confirm_handoff: true } });
  expect(unavailableResult.status()).toBe(409);
  expect((await unavailableResult.json()).error.code).toBe("voice_unavailable");
  await page.goto(`${baseURL}/#generation/${unavailable.episode.id}`);
  await expect(page.getByRole("button", { name: "Prepare Codex handoff" })).toBeDisabled();

  const mismatch = await createEpisode(page, { title: "Mismatched voice", voiceLanguage: "pt" });
  const mismatchResult = await page.request.post(`${baseURL}/api/episodes/${mismatch.episode.id}/generation-handoffs`, { data: { confirm_handoff: true } });
  expect(mismatchResult.status()).toBe(409);
  expect((await mismatchResult.json()).error.code).toBe("voice_language_mismatch");
  await page.goto(`${baseURL}/#generation/${mismatch.episode.id}`);
  await expect(page.getByRole("button", { name: "Prepare Codex handoff" })).toBeDisabled();

  for (const id of [noApproval.episode.id, noVoice.episode.id, unavailable.episode.id, mismatch.episode.id]) {
    const list = await page.request.get(`${baseURL}/api/episodes/${id}/generation-handoffs`);
    expect((await list.json()).handoffs).toEqual([]);
  }
});

test("cancelled handoff, safe failure status and invalid import remain local and retryable", async ({ page }) => {
  const { episode } = await createEpisode(page, { title: "Safe error paths" });
  const externalRequests = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(baseURL) && !request.url().startsWith("data:")) externalRequests.push(request.url());
  });
  await page.goto(`${baseURL}/#generation/${episode.id}`);
  await page.getByRole("button", { name: "Prepare Codex handoff" }).click();
  await expect(page.getByRole("dialog", { name: "Prepare request for Codex?" })).toBeVisible();
  await page.getByRole("button", { name: "Back to review" }).click();
  expect((await (await page.request.get(`${baseURL}/api/episodes/${episode.id}/generation-handoffs`)).json()).handoffs).toEqual([]);
  await expectEpisodeNotGenerating(page, episode.id);

  await prepareInUi(page, episode.id);
  const failedHandoff = page.locator(".generation-handoff").first();
  await failedHandoff.locator("[data-handoff-failure]").selectOption("mcp_error");
  page.once("dialog", (dialog) => dialog.dismiss());
  await failedHandoff.getByRole("button", { name: "Record failure" }).click();
  await expect(failedHandoff).toContainText("Awaiting your action in Codex");
  page.once("dialog", (dialog) => dialog.accept());
  await failedHandoff.getByRole("button", { name: "Record failure" }).click();
  await expect(page.getByText("Handoff failed")).toBeVisible();
  await expect(page.getByText("mcp_error")).toBeVisible();
  const listed = (await (await page.request.get(`${baseURL}/api/episodes/${episode.id}/generation-handoffs`)).json()).handoffs;
  expect(listed[0]).toMatchObject({ status: "failed", failure_code: "mcp_error" });
  expect(JSON.stringify(listed)).not.toContain("provider trace");
  await expectEpisodeNotGenerating(page, episode.id);

  // A distinct prepared handoff remains retryable after local file validation rejects a bad extension.
  await prepareInUi(page, episode.id);
  const active = page.locator('.generation-handoff:has([data-generation-file])').first();
  const handoffId = await active.locator("[data-generation-file]").getAttribute("data-generation-file");
  await active.locator("[data-generation-file]").setInputFiles({ name: "not-audio.txt", mimeType: "text/plain", buffer: Buffer.from("not audio") });
  await expect(active.locator(`[data-handoff-error="${handoffId}"]`)).toContainText("supported audio extension");
  const retryable = (await (await page.request.get(`${baseURL}/api/episodes/${episode.id}/generation-handoffs`)).json()).handoffs;
  expect(retryable.find((item) => item.id === handoffId).status).toBe("prepared");
  await expectEpisodeNotGenerating(page, episode.id);
  expect(externalRequests).toEqual([]);
});

test("two local WAV imports remain playable/downloadable, review decisions retain versions across restart", async ({ page }) => {
  const { episode, script } = await createEpisode(page, { title: "Retained local takes" });
  const audioBytes = oneSecondSilentWav();
  const priorBytes = oneSecondSilentWav();
  const prior = await approveLocalAudio(page, episode.id, "previous-approved.wav", priorBytes);
  const before = await (await page.request.get(`${baseURL}/api/files/${prior.id}`)).body();
  const priorMetadata = (await (await page.request.get(`${baseURL}/api/episodes/${episode.id}/files`)).json()).files.find((item) => item.id === prior.id);
  const providerCalls = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== baseURL && url.protocol !== "data:") providerCalls.push(request.url());
  });

  await page.goto(`${baseURL}/#generation/${episode.id}`);
  await prepareInUi(page, episode.id);
  let pendingHandoff = page.locator('.generation-handoff:has([data-generation-file])').first();
  let handoffId = await pendingHandoff.locator("[data-generation-file]").getAttribute("data-generation-file");
  const handoffHref = await pendingHandoff.getByRole("link", { name: "Download handoff JSON" }).getAttribute("href");
  expect(handoffHref).toMatch(/^data:application\/json/);
  const handoffData = JSON.parse(decodeURIComponent(handoffHref.split(",")[1]));
  expect(handoffData.script).toBe(script);
  expect(handoffData.voice.fish_audio_id).toMatch(/^local-fake-/);
  expect(handoffData.model_preference.identifier).toBe("drama-3");
  await pendingHandoff.locator("[data-generation-file]").setInputFiles({ name: "take-one.wav", mimeType: "audio/wav", buffer: audioBytes });
  await expect(page.getByRole("status")).toContainText("Audio imported as a new local version");
  await expectEpisodeNotGenerating(page, episode.id);

  await prepareInUi(page, episode.id);
  pendingHandoff = page.locator('.generation-handoff:has([data-generation-file])').first();
  handoffId = await pendingHandoff.locator("[data-generation-file]").getAttribute("data-generation-file");
  await pendingHandoff.locator("[data-generation-file]").setInputFiles({ name: "take-two.wav", mimeType: "audio/wav", buffer: oneSecondSilentWav() });
  await expect(page.getByRole("status")).toContainText("Audio imported as a new local version");
  await expectEpisodeNotGenerating(page, episode.id);

  const records = (await (await page.request.get(`${baseURL}/api/episodes/${episode.id}/files`)).json()).files;
  expect(records).toHaveLength(3);
  const firstTake = records.find((item) => item.filename === "take-one.wav");
  const secondTake = records.find((item) => item.filename === "take-two.wav");
  expect(firstTake.generation_id).not.toBe(secondTake.generation_id);
  expect(firstTake.handoff_id).not.toBe(secondTake.handoff_id);
  expect(firstTake.approval_status).toBe("pending");
  expect(secondTake.approval_status).toBe("pending");
  expect(firstTake.script_sha256).toBe(createHash("sha256").update(script).digest("hex"));
  expect(firstTake.model).toBe("drama-3");

  const secondCard = page.locator(`[data-audio-version="${secondTake.id}"]`);
  const player = secondCard.locator("audio");
  await expect(player).toHaveAttribute("controls", "");
  expect(new URL(await player.getAttribute("src"), baseURL).pathname).toBe(`/api/files/${secondTake.id}`);
  await expect.poll(async () => secondCard.locator(`[data-duration-label="${secondTake.id}"]`).textContent()).toContain("0:01");
  const download = await page.request.get(`${baseURL}${await secondCard.getByRole("link", { name: "Download audio" }).getAttribute("href")}`);
  expect(download.status()).toBe(200);
  expect(await download.body()).toEqual(audioBytes);

  await page.locator(`[data-audio-version="${firstTake.id}"] [data-action="review-audio"][data-status="rejected"]`).click();
  await expect(page.getByRole("dialog", { name: "Review audio version" })).toBeVisible();
  await page.getByRole("button", { name: "Keep listening" }).click();
  expect((await (await page.request.get(`${baseURL}/api/episodes/${episode.id}/files`)).json()).files.find((item) => item.id === firstTake.id).approval_status).toBe("pending");
  await page.locator(`[data-audio-version="${firstTake.id}"] [data-action="review-audio"][data-status="rejected"]`).click();
  await page.getByRole("button", { name: "Confirm review" }).click();
  await expect(page.locator(`[data-audio-version="${firstTake.id}"]`)).toContainText("Rejected · retained");
  await expectEpisodeNotGenerating(page, episode.id);

  await page.locator(`[data-audio-version="${secondTake.id}"] [data-action="review-audio"][data-status="approved"]`).click();
  await page.getByRole("button", { name: "Confirm review" }).click();
  await expect(page.locator(`[data-audio-version="${secondTake.id}"]`)).toContainText("Approved · preserved");
  await expectEpisodeNotGenerating(page, episode.id);

  await stopServer();
  await startServer();
  await page.reload();
  await expect(page.locator(`[data-audio-version="${firstTake.id}"]`)).toContainText("Rejected · retained");
  await expect(page.locator(`[data-audio-version="${secondTake.id}"]`)).toContainText("Approved · preserved");
  await expectEpisodeNotGenerating(page, episode.id);
  const afterFiles = (await (await page.request.get(`${baseURL}/api/episodes/${episode.id}/files`)).json()).files;
  expect(afterFiles).toHaveLength(3);
  expect(afterFiles.find((item) => item.id === prior.id)).toEqual(priorMetadata);
  expect(await (await page.request.get(`${baseURL}/api/files/${prior.id}`)).body()).toEqual(before);
  expect(await (await page.request.get(`${baseURL}/api/files/${firstTake.id}`)).body()).toEqual(audioBytes);
  expect(await (await page.request.get(`${baseURL}/api/files/${secondTake.id}`)).body()).toEqual(audioBytes);
  expect(providerCalls).toEqual([]);
});
