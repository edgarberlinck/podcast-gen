const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createApi } = require("../static/api.js");

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json; charset=utf-8" },
    json: async () => payload,
  };
}

test("metadata and content use their dedicated local API routes", async () => {
  const calls = [];
  const api = createApi(async (path, options) => {
    calls.push({ path, options });
    return response({ id: "episode-1" }, path === "/api/episodes" ? 201 : 200);
  });

  await api.createEpisode({ title: "Draft", original_article: "Original" });
  await api.updateEpisode("episode-1", { title: "Edited" });
  await api.saveScript("episode-1", "narration", "Narration text");
  await api.saveScript("episode-1", "fishAudio", "[pause]Fish text");
  await api.episode("episode-1");
  await api.voices();
  await api.registerVoice({ display_name: "Voice", fish_audio_id: "fish-id", language: "en" });

  assert.deepEqual(calls.map(({ path }) => path), [
    "/api/episodes",
    "/api/episodes/episode-1",
    "/api/episodes/episode-1/scripts/narration",
    "/api/episodes/episode-1/scripts/fish-audio",
    "/api/episodes/episode-1",
    "/api/voices",
    "/api/voices",
  ]);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[2].options.body), { content: "Narration text" });
  assert.deepEqual(JSON.parse(calls[3].options.body), { content: "[pause]Fish text" });
  assert.equal(calls[6].options.method, "POST");
  assert.ok(calls.slice(1).every(({ path }) => !path.endsWith("/original")));
});

test("voice cloning requires consent and uploads the reference as an audio body", async () => {
  const calls = [];
  const api = createApi(async (path, options) => {
    calls.push({ path, options });
    return response({ job: { id: "clone-job-1" } }, 202);
  });
  const file = { name: "voice sample.wav", type: "audio/wav" };
  const details = {
    display_name: "Narrator", language: "pt", visibility: "private", description: "Warm",
  };
  assert.throws(() => api.cloneVoice(file, details, false), /autorização/i);
  assert.equal(calls.length, 0);
  await api.cloneVoice(file, details, true);
  await api.voiceCloneJob("clone-job-1");

  const url = new URL(calls[0].path, "http://localhost");
  assert.equal(url.pathname, "/api/voices/clone");
  assert.equal(url.searchParams.get("consent"), "true");
  assert.equal(url.searchParams.get("filename"), file.name);
  assert.equal(url.searchParams.get("visibility"), "private");
  assert.equal(url.searchParams.get("description"), details.description);
  assert.equal(calls[0].options.body, file);
  assert.equal(calls[0].options.headers["Content-Type"], "audio/wav");
  assert.equal(calls[1].path, "/api/voice-clone-jobs/clone-job-1");
});

test("editing an existing original requires affirmative confirmation", async () => {
  const calls = [];
  const api = createApi(async (path, options) => {
    calls.push({ path, options });
    return response({ original_article: "New article" });
  });
  assert.throws(() => api.saveOriginal("episode-1", "New article", false), /confirmação/i);
  assert.equal(calls.length, 0);
  await api.saveOriginal("episode-1", "New article", true);
  assert.equal(calls[0].path, "/api/episodes/episode-1/original");
  assert.equal(calls[0].options.method, "PUT");
  assert.deepEqual(JSON.parse(calls[0].options.body), { content: "New article", confirm_edit: true });
});

test("suggestion scopes and exact-script approval use separate explicit API operations", async () => {
  const calls = [];
  const api = createApi(async (path, options) => {
    calls.push({ path, options });
    return response({ suggestion: { id: "suggestion-1" } });
  });
  await api.requestNarrationSuggestion("episode-1", "article");
  await api.requestNarrationSuggestion("episode-1", "paragraph", 2);
  assert.throws(() => api.approveFishScript("episode-1", "script", false), /confirmação explícita/i);
  await api.approveFishScript("episode-1", "saved script", true);
  assert.deepEqual(calls.map(({ path }) => path), [
    "/api/episodes/episode-1/narration-suggestions",
    "/api/episodes/episode-1/narration-suggestions",
    "/api/episodes/episode-1/scripts/fish-audio-approval",
  ]);
  assert.deepEqual(JSON.parse(calls[0].options.body), { scope: "article" });
  assert.deepEqual(JSON.parse(calls[1].options.body), { scope: "paragraph", paragraph_index: 2 });
  assert.deepEqual(JSON.parse(calls[2].options.body), { content: "saved script", confirm_approval: true });
});

test("generation quote and paid audio generation require explicit consent", async () => {
  const calls = [];
  const api = createApi(async (path, options) => {
    calls.push({ path, options });
    return response({ handoff: { id: "handoff-1" } });
  });
  assert.throws(() => api.prepareGenerationHandoff("episode/1", false), /confirmação explícita/i);
  assert.throws(() => api.quoteGeneration("episode/1", "handoff/1", false), /confirmação explícita/i);
  assert.throws(() => api.generateAudio("episode/1", "handoff/1", false), /confirmação explícita/i);
  await api.prepareGenerationHandoff("episode/1", true);
  await api.quoteGeneration("episode/1", "handoff/1", true);
  await api.generateAudio("episode/1", "handoff/1", true);
  const audio = { name: "take one.mp3", type: "audio/mpeg" };
  await api.importGeneration("episode/1", "handoff/1", audio);
  assert.equal(calls[0].path, "/api/episodes/episode%2F1/generation-handoffs");
  assert.deepEqual(JSON.parse(calls[0].options.body), { confirm_handoff: true });
  assert.equal(calls[1].path, "/api/episodes/episode%2F1/generation-handoffs/handoff%2F1/quote");
  assert.deepEqual(JSON.parse(calls[1].options.body), { confirm_quote: true });
  assert.equal(calls[2].path, "/api/episodes/episode%2F1/generation-handoffs/handoff%2F1/generate");
  assert.deepEqual(JSON.parse(calls[2].options.body), { confirm_generation: true });
  assert.equal(calls[3].path, "/api/episodes/episode%2F1/generation-handoffs/handoff%2F1/import?filename=take%20one.mp3");
  assert.equal(calls[3].options.body, audio);
  assert.equal(calls[3].options.headers["Content-Type"], "audio/mpeg");
});

test("audio review is explicitly confirmed and failure categories are reported locally", async () => {
  const calls = [];
  const api = createApi(async (path, options) => {
    calls.push({ path, options });
    return response({ approval_status: "approved" });
  });
  assert.throws(() => api.reviewAudioFile("file-1", "approved", false), /confirmação explícita/i);
  await api.reviewAudioFile("file-1", "approved", true);
  await api.failGenerationHandoff("episode-1", "handoff-1", "mcp_error");
  assert.deepEqual(calls.map(({ path }) => path), [
    "/api/files/file-1/review",
    "/api/episodes/episode-1/generation-handoffs/handoff-1/failure",
  ]);
  assert.deepEqual(JSON.parse(calls[0].options.body), { status: "approved", confirm_review: true });
  assert.deepEqual(JSON.parse(calls[1].options.body), { confirm_failure: true, failure_code: "mcp_error" });
});

test("Transistor upload and publish actions require separate confirmation", async () => {
  const calls = [];
  const api = createApi(async (path, options) => {
    calls.push({ path, options });
    return response({ publication: { status: "draft" }, shows: [] });
  });
  assert.throws(() => api.createTransistorDraft("ep-1", { show_id: "show-1" }, false), /explicit/i);
  assert.throws(() => api.publishTransistorEpisode("ep-1", "published", "", false), /separate explicit/i);
  await api.transistorShows();
  await api.transistorPublication("ep-1");
  await api.createTransistorDraft("ep-1", { show_id: "show-1", file_id: "file-1" }, true);
  await api.refreshTransistorPublication("ep-1");
  await api.publishTransistorEpisode("ep-1", "scheduled", "2026-12-01T10:00", true);
  assert.deepEqual(calls.map(({ path }) => path), [
    "/api/transistor/shows", "/api/episodes/ep-1/transistor",
    "/api/episodes/ep-1/transistor/draft", "/api/episodes/ep-1/transistor/refresh",
    "/api/episodes/ep-1/transistor/publish",
  ]);
  assert.deepEqual(JSON.parse(calls[2].options.body), { show_id: "show-1", file_id: "file-1", confirm_upload: true });
  assert.deepEqual(JSON.parse(calls[4].options.body), { status: "scheduled", published_at: "2026-12-01T10:00", confirm_publish: true });
});

test("unknown derived content kinds cannot select a route", () => {
  const api = createApi(async () => response({}));
  assert.throws(() => api.saveScript("episode-1", "original", "unsafe"), /desconhecido/i);
});

test("API errors preserve safe contract codes and unavailable local server is surfaced to the UI", async () => {
  const failedApi = createApi(async () => response({ error: { code: "transistor_creation_uncertain", message: "Inspect Transistor manually." } }, 502));
  await assert.rejects(failedApi.dashboard(), (error) => error.message === "Inspect Transistor manually." && error.code === "transistor_creation_uncertain");
  const unavailableApi = createApi(async () => { throw new Error("offline"); });
  await assert.rejects(unavailableApi.voices(), /conectar ao estúdio local/i);
});
