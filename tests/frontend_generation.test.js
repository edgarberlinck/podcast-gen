const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { JSDOM } = require("jsdom");

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function generationStudio(t, language = "en") {
  const dom = new JSDOM(readFileSync("static/index.html", "utf8"), {
    url: "http://localhost/#generation/episode-1", runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  dom.window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close = function close() { this.removeAttribute("open"); };
  const episode = {
    id: "episode-1", title: "Local episode", language, fish_audio_script: "Approved script.",
    fish_audio_approved_sha256: "a".repeat(64), fish_audio_approved_at: "2026-11-18T00:31:00Z", selected_voice_id: "voice-1",
  };
  const voices = [
    { id: "voice-1", display_name: "Marina", fish_audio_id: "fish-voice-a", language, availability: "available" },
    { id: "voice-2", display_name: "Jo", fish_audio_id: "fish-voice-b", language, availability: "available" },
  ];
  const approvedAudio = { id: "file-approved", filename: "old-approved.mp3", size_bytes: 4096, created_at: "2026-11-17T20:00:00Z", approval_status: "approved", voice_name: "Marina", fish_audio_id: "fish-voice-a", model: "drama-3", handoff_id: null };
  const pendingAudio = { id: "file-pending", filename: "new-take.mp3", size_bytes: 8192, created_at: "2026-11-18T00:31:00Z", approval_status: "pending", voice_name: "Marina", fish_audio_id: "fish-voice-a", model: "drama-3", handoff_id: "handoff-1", script_sha256: "b".repeat(64) };
  const files = [pendingAudio, approvedAudio];
  const handoffs = [];
  const calls = [];
  const api = {
    episode: async () => ({ ...episode }),
    generationHandoffs: async () => ({ handoffs: [...handoffs] }),
    episodeFiles: async () => ({ files: [...files] }),
    voices: async () => ({ voices: [...voices] }),
    updateEpisode: async (_id, changes) => { calls.push(["updateEpisode", changes]); Object.assign(episode, changes); return { ...episode }; },
    prepareGenerationHandoff: async (_id, confirmed) => {
      calls.push(["prepareGenerationHandoff", confirmed]);
      const handoff = { id: "handoff-2", status: "prepared", voice_name: voices.find((item) => item.id === episode.selected_voice_id).display_name, fish_audio_id: "fish-voice-b", model: "drama-3", script: episode.fish_audio_script, script_sha256: episode.fish_audio_approved_sha256, created_at: "2026-11-18T00:32:00Z" };
      handoffs.unshift(handoff);
      return { handoff };
    },
    reviewAudioFile: async (id, status, confirmed) => {
      calls.push(["reviewAudioFile", id, status, confirmed]);
      const file = files.find((item) => item.id === id);
      file.approval_status = status;
      return { ...file };
    },
  };
  dom.window.StudioApi = { createApi: () => api };
  dom.window.eval(readFileSync("static/app.js", "utf8"));
  await tick();
  return { dom, doc: dom.window.document, calls, episode, files, handoffs };
}

test("generation review localizes independently, selects only registered voices and retains confirmed files", async (t) => {
  const { dom, doc, calls, episode, files, handoffs } = await generationStudio(t);
  assert.equal(doc.documentElement.lang, "en");
  assert.match(doc.querySelector("h1").textContent, /Prepare and review audio/);
  assert.match(doc.querySelector(".model-caveat").textContent, /schema/);
  assert.equal(doc.querySelectorAll(".audio-version").length, 2);
  assert.match(doc.querySelector(".audio-version-heading").textContent, /Awaiting review/);
  assert.match(doc.body.textContent, /Approved · preserved/);
  assert.match(doc.querySelector("[data-duration-label='file-pending']").textContent, /Loading duration/);

  const player = doc.querySelector("audio[data-audio-duration='file-pending']");
  Object.defineProperty(player, "duration", { configurable: true, value: 83 });
  player.dispatchEvent(new dom.window.Event("loadedmetadata"));
  assert.equal(doc.querySelector("[data-duration-label='file-pending']").textContent, "Duration · 1:23");

  doc.querySelector("#generation-language").value = "pt";
  doc.querySelector("#generation-language").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await tick();
  assert.equal(doc.documentElement.lang, "pt-BR");
  assert.match(doc.querySelector("h1").textContent, /Preparar e revisar áudio/);
  assert.match(doc.querySelector("[data-duration-label='file-pending']").textContent, /Duração/);

  const voice = doc.querySelector("#generation-voice");
  voice.value = "voice-2";
  voice.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal(doc.querySelector('[data-action="save-generation-voice"]').disabled, false);
  await doc.querySelector('[data-action="save-generation-voice"]').click();
  await tick();
  assert.equal(episode.selected_voice_id, "voice-2");
  assert.equal(calls[0][0], "updateEpisode");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { selected_voice_id: "voice-2" });

  const prepare = doc.querySelector('[data-action="prepare-handoff"]');
  assert.equal(prepare.disabled, false);
  prepare.click();
  const handoffDialog = doc.querySelector("#handoff-confirm-dialog");
  assert.equal(handoffDialog.open, true);
  assert.match(handoffDialog.textContent, /Nenhum áudio é gerado aqui/);
  assert.equal(calls.some(([name]) => name === "prepareGenerationHandoff"), false);
  handoffDialog.querySelector('[data-action="confirm-handoff"]').click();
  await tick();
  assert.equal(calls.some(([name, confirmed]) => name === "prepareGenerationHandoff" && confirmed === true), true);
  assert.equal(handoffs.length, 1);
  assert.match(doc.body.textContent, /Aguardando sua ação no Codex/);

  doc.querySelector('[data-action="review-audio"][data-status="approved"]').click();
  const reviewDialog = doc.querySelector("#audio-review-dialog");
  assert.equal(reviewDialog.open, true);
  assert.match(reviewDialog.textContent, /As outras versões permanecem inalteradas/);
  assert.equal(calls.some(([name]) => name === "reviewAudioFile"), false);
  reviewDialog.querySelector('[data-action="confirm-audio-review"]').click();
  await tick();
  assert.equal(files.find((item) => item.id === "file-pending").approval_status, "approved");
  assert.equal(files.find((item) => item.id === "file-approved").approval_status, "approved");
  assert.deepEqual(calls.at(-1), ["reviewAudioFile", "file-pending", "approved", true]);
  assert.match(doc.querySelector("[data-audio-version='file-pending']").textContent, /Aprovada · preservada/);
  assert.equal(doc.querySelector('[data-action="review-audio"][data-id="file-pending"]'), null);
  assert.equal(calls.some(([name]) => /fish|transistor|publish/i.test(name)), false);
});

test("unavailable voice and unapproved script cannot prepare a handoff; reject keeps the local version", async (t) => {
  const { doc, calls, files } = await generationStudio(t, "pt");
  const prepare = doc.querySelector('[data-action="prepare-handoff"]');
  assert.equal(prepare.disabled, false);
  const selected = doc.querySelector("#generation-voice");
  selected.value = "";
  selected.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
  assert.equal(prepare.disabled, true);
  assert.equal(calls.some(([name]) => name === "prepareGenerationHandoff"), false);

  doc.querySelector('[data-action="review-audio"][data-status="rejected"]').click();
  const dialog = doc.querySelector("#audio-review-dialog");
  assert.match(dialog.textContent, /O arquivo local será preservado/);
  dialog.querySelector('[data-action="confirm-audio-review"]').click();
  await tick();
  assert.equal(files.find((item) => item.id === "file-pending").approval_status, "rejected");
  assert.equal(doc.querySelector('[data-action="review-audio"][data-id="file-pending"]'), null);
});
