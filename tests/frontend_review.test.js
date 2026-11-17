const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { JSDOM } = require("jsdom");

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function studio(t, language = "pt", requestSuggestion) {
  const dom = new JSDOM(readFileSync("static/index.html", "utf8"), {
    url: "http://localhost/#scripts/episode-1", runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  let episode = { id: "episode-1", title: "Editorial title", language,
    original_article: "Original one.\n\nOriginal two.", narration_script: "Saved narration.",
    fish_audio_script: "Saved Fish.", fish_audio_approved_sha256: null, selected_voice_id: null };
  const writes = [];
  const api = {
    episode: async () => ({ ...episode }), voices: async () => ({ voices: [] }),
    narrationSuggestions: async () => ({ suggestions: [] }),
    requestNarrationSuggestion: requestSuggestion || (async () => ({ suggestion: {
      id: "suggestion-1", source_text: episode.original_article, suggested_text: "Suggested text.", scope: "article", approval_status: "pending",
    } })),
    saveScript: async (_id, kind, content) => {
      writes.push({ kind, content });
      episode = { ...episode, [kind === "narration" ? "narration_script" : "fish_audio_script"]: content };
      return { ...episode };
    },
  };
  dom.window.StudioApi = { createApi: () => api };
  dom.window.eval(`${readFileSync("static/app.js", "utf8")}
//# sourceURL=${require("node:url").pathToFileURL(require("node:path").resolve("static/app.js"))}`);
  await tick();
  const doc = dom.window.document;
  const selectLanguage = (value) => {
    doc.querySelector("#interface-language").value = value;
    doc.querySelector("#interface-language").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  const click = async (selector) => { doc.querySelector(selector).click(); await tick(); };
  return { doc, writes, selectLanguage, click, saved: () => episode };
}

test("interface language is independent of PT content and preserves unsaved narration and suggestion edits", async (t) => {
  const { doc, writes, selectLanguage, click, saved } = await studio(t);
  await click('[data-action="request-suggestion"]');
  doc.querySelector("#suggestion-text").value = "Edited suggestion.";
  doc.querySelector("#narration-script").value = "Unsaved narration.";
  selectLanguage("en");
  assert.equal(doc.documentElement.lang, "en");
  assert.equal(doc.querySelector("h1").textContent, "Prepare the narration draft");
  assert.equal(doc.querySelector("#narration-script").value, "Unsaved narration.");
  assert.equal(doc.querySelector("#suggestion-text").value, "Edited suggestion.");
  assert.match(doc.querySelector(".page-heading p").textContent, /Português/);
  assert.equal(saved().language, "pt");
  assert.equal(writes.length, 0);
  selectLanguage("pt");
  assert.equal(doc.documentElement.lang, "pt-BR");
  assert.equal(doc.querySelector("#suggestion-text").value, "Edited suggestion.");
});

test("stages focus their title, preserve drafts, and save only the active version", async (t) => {
  const { doc, writes, selectLanguage, click, saved } = await studio(t, "en");
  assert.equal(doc.querySelector("#fish-script"), null);
  doc.querySelector("#narration-script").value = "Unsaved narration.";
  await click('[data-stage="fish"]');
  assert.equal(doc.activeElement, doc.querySelector("h1"));
  assert.match(doc.querySelector("[aria-current=step]").textContent, /03/);
  assert.equal(doc.querySelector("#narration-script"), null);
  assert.equal(doc.querySelector('[data-action="request-suggestion"]'), null);
  assert.match(doc.querySelector(".version-summary").textContent, /Unsaved changes/);
  assert.equal(doc.querySelector('[aria-label="Saved narration draft"]').value, "Saved narration.");
  assert.equal(doc.querySelector('[aria-label="Saved narration draft"]').readOnly, true);
  doc.querySelector("#fish-script").value = "Unsaved Fish.";
  selectLanguage("pt");
  assert.equal(doc.querySelector("#fish-script").value, "Unsaved Fish.");
  assert.equal(doc.querySelector('[data-action="open-approval"]').disabled, true);
  await click('[data-action="save-scripts"]');
  assert.deepEqual(writes, [{ kind: "fishAudio", content: "Unsaved Fish." }]);
  assert.equal(saved().narration_script, "Saved narration.");
  assert.equal(doc.querySelector('[data-action="open-approval"]').disabled, false);
  await click('[data-stage="narration"]');
  assert.equal(doc.querySelector("#narration-script").value, "Unsaved narration.");
  await click('[data-action="save-scripts"]');
  assert.deepEqual(writes[1], { kind: "narration", content: "Unsaved narration." });
  await click('[data-stage="fish"]');
  assert.equal(doc.querySelector('[aria-label="Roteiro de narração salvo"]').value, "Unsaved narration.");
  assert.equal(doc.querySelector("#fish-script").value, "Unsaved Fish.");
});

test("pending request survives language and stage changes without duplicate writes", async (t) => {
  let resolve;
  let requests = 0;
  const { doc, selectLanguage, click } = await studio(t, "pt", () => {
    requests++;
    return new Promise((done) => { resolve = done; });
  });
  await click('[data-action="request-suggestion"]');
  selectLanguage("en");
  assert.equal(doc.querySelector('[data-action="request-suggestion"]').disabled, true);
  assert.match(doc.querySelector("#suggestion-status").textContent, /Preparing suggestion/);
  await click('[data-action="request-suggestion"]');
  assert.equal(requests, 1);
  await click('[data-stage="fish"]');
  resolve({ suggestion: { id: "late", scope: "article", suggested_text: "Ready.", source_text: "Source.", approval_status: "pending" } });
  await tick();
  await click('[data-stage="narration"]');
  assert.equal(doc.querySelector("#suggestion-text").value, "Ready.");
  assert.equal(doc.querySelector('[data-action="request-suggestion"]').disabled, false);
});

test("provider errors and retry stay safely localized when toggling language", async (t) => {
  const { doc, selectLanguage, click } = await studio(t, "en", async () => { throw new Error("private provider trace"); });
  await click('[data-action="request-suggestion"]');
  selectLanguage("pt");
  assert.match(doc.querySelector('[role="alert"]').textContent, /Não foi possível/);
  assert.doesNotMatch(doc.body.textContent, /private provider trace/);
  await click('[data-action="retry-suggestion"]');
  assert.match(doc.querySelector('[role="alert"]').textContent, /Não foi possível/);
  selectLanguage("en");
  assert.match(doc.querySelector('[role="alert"]').textContent, /We couldn’t create/);
});
