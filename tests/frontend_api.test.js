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

test("unknown derived content kinds cannot select a route", () => {
  const api = createApi(async () => response({}));
  assert.throws(() => api.saveScript("episode-1", "original", "unsafe"), /desconhecido/i);
});

test("API errors and unavailable local server are surfaced to the UI", async () => {
  const failedApi = createApi(async () => response({ error: { message: "Invalid episode" } }, 400));
  await assert.rejects(failedApi.dashboard(), /Invalid episode/);
  const unavailableApi = createApi(async () => { throw new Error("offline"); });
  await assert.rejects(unavailableApi.voices(), /conectar ao estúdio local/i);
});
