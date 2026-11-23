const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { JSDOM } = require("jsdom");

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

async function voiceLibrary(t, api) {
  const dom = new JSDOM(readFileSync("static/index.html", "utf8"), {
    url: "http://localhost/#voices", runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  dom.window.URL.createObjectURL = () => "blob:voice-sample";
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.StudioApi = { createApi: () => api };
  dom.window.eval(readFileSync("static/app.js", "utf8"));
  await tick();
  return { dom, doc: dom.window.document };
}

test("voice library offers a rich guided sample and explicit permission before cloning", async (t) => {
  const api = { voices: async () => ({ voices: [] }) };
  const { doc } = await voiceLibrary(t, api);
  assert.match(doc.querySelector("#voice-clone-script").value, /curiosidade/i);
  assert.match(doc.querySelector(".voice-clone-panel").textContent, /10–60 segundos/);
  assert.match(doc.querySelector(".voice-clone-panel").textContent, /Fish Audio/);
  assert.equal(doc.querySelector("#voice-clone-consent").required, true);
  assert.equal(doc.querySelector("#voice-sample-file").accept.includes(".wav"), true);
  assert.ok(doc.querySelector('[data-action="start-voice-recording"]'));
});

test("voice library uploads the chosen clip only after explicit consent", async (t) => {
  const calls = [];
  const voices = [];
  const api = {
    voices: async () => ({ voices: [...voices] }),
    cloneVoice: async (file, details, confirmed) => {
      calls.push({ file, details, confirmed });
      voices.push({
        id: "voice-1", display_name: details.display_name, fish_audio_id: "fish-private-id",
        language: details.language, voice_type: "own", availability: "available",
        fish_audio_visibility: "private", registered_at: "2026-11-23T00:00:00Z",
      });
      return { job: { id: "clone-job-1" } };
    },
    voiceCloneJob: async () => ({
      job: { id: "clone-job-1", status: "completed", fish_audio_id: "fish-private-id", visibility: "private" },
    }),
  };
  const { dom, doc } = await voiceLibrary(t, api);
  const file = new dom.window.File(["audio bytes"], "sample.wav", { type: "audio/wav" });
  Object.defineProperty(doc.querySelector("#voice-sample-file"), "files", { value: [file] });
  doc.querySelector("#voice-sample-file").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  doc.querySelector("#voice-clone-name").value = "My voice";
  doc.querySelector("#voice-clone-consent").checked = true;
  doc.querySelector("#voice-clone-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await tick();
  await tick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file.name, "sample.wav");
  assert.equal(calls[0].details.display_name, "My voice");
  assert.equal(calls[0].confirmed, true);
  assert.match(doc.querySelector("#notice").textContent, /fish-private-id/);
  assert.match(doc.querySelector(".voice-card-meta").textContent, /Fish Audio · privada/);
});
