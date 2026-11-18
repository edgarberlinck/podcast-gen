const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { JSDOM } = require("jsdom");

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function transistorStudio(t, initialPublication = null, options = {}) {
  const dom = new JSDOM(readFileSync("static/index.html", "utf8"), {
    url: "http://localhost/#transistor/episode-1", runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const episode = { id: "episode-1", title: "Local episode", description: "Episode summary", language: "en" };
  const files = [
    { id: "file-approved", filename: "approved.mp3", size_bytes: 4096, created_at: "2026-11-18T00:31:00Z", approval_status: "approved" },
    { id: "file-pending", filename: "pending.mp3", size_bytes: 512, created_at: "2026-11-18T00:32:00Z", approval_status: "pending" },
    { id: "file-approved-2", filename: "approved-2.wav", size_bytes: 2048, created_at: "2026-11-18T00:33:00Z", approval_status: "approved" },
  ];
  let publication = initialPublication && { ...initialPublication };
  const calls = [];
  const api = {
    episode: async () => ({ ...episode }),
    updateEpisode: async (id, value) => { calls.push(["metadata", id, value]); Object.assign(episode, value); return { ...episode }; },
    episodeFiles: async () => ({ files }),
    transistorPublication: async () => ({ publication }),
    transistorShows: async () => options.showsError ? Promise.reject(new Error("safe 503")) : ({ shows: [{ id: "show-1", title: "Code & Scars", time_zone: options.timeZone === false ? "" : "America/Sao_Paulo" }] }),
    createTransistorDraft: async (id, value, confirmed) => {
      calls.push(["draft", id, value, confirmed]);
      if (options.createFailure) {
        publication = { episode_id: id, file_id: value.file_id, show_id: value.show_id, remote_episode_id: options.createFailure === "uncertain" ? null : "", status: options.createFailure, show_title: "Code & Scars", title: episode.title, description: episode.description, summary: value.summary, keywords: value.keywords, show_time_zone: "America/Sao_Paulo", show_time_zone_supported: true };
        throw new Error(options.createFailure === "upload_failed" ? "Safe upload failure" : "Draft creation could not be confirmed; inspect Transistor manually.");
      }
      publication = { episode_id: id, file_id: value.file_id, show_id: value.show_id, remote_episode_id: "remote-1", status: "draft", show_title: "Code & Scars", title: episode.title, description: episode.description, summary: value.summary, keywords: value.keywords, show_time_zone: options.timeZone === false ? "" : "America/Sao_Paulo", show_time_zone_supported: options.timeZone !== false };
      return { publication };
    },
    refreshTransistorPublication: async (id) => {
      calls.push(["refresh", id]);
      if (options.refreshError) throw new Error("safe rate-limit response");
      publication = { ...publication, status: "draft" };
      return { publication };
    },
    publishTransistorEpisode: async (id, status, time, confirmed) => {
      calls.push(["publish", id, status, time, confirmed]);
      publication = { ...publication, status, published_at: time || null };
      return { publication };
    },
  };
  dom.window.StudioApi = { createApi: () => api };
  dom.window.eval(readFileSync("static/app.js", "utf8"));
  await tick();
  return { dom, doc: dom.window.document, calls };
}

async function consentAndClick(doc, consentId, actionSelector) {
  const checkbox = doc.getElementById(consentId);
  checkbox.checked = true;
  checkbox.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
  const button = doc.querySelector(actionSelector);
  assert.equal(button.disabled, false);
  button.click();
  await tick();
}

async function uploadApprovedDraft(doc, calls) {
  const existingCalls = calls.length;
  doc.querySelector('[data-action="open-transistor-upload"]').click();
  await tick();
  assert.equal(doc.getElementById("transistor-upload-dialog").open, true);
  assert.equal(calls.length, existingCalls, "opening confirmation must not start an external action");
  await consentAndClick(doc, "transistor-upload-consent", '[data-action="confirm-transistor-upload"]');
  assert.equal(calls.at(-1)[0], "draft");
}

async function confirmDraftReadback(doc, calls) {
  doc.querySelector('[data-action="refresh-transistor"]').click();
  await tick();
  assert.equal(calls.at(-1)[0], "refresh");
  assert.equal(doc.querySelector('[data-action="open-transistor-publish"]').disabled, false);
}

test("upload requires a separate checked confirmation and creates a draft only", async (t) => {
  const { doc, calls } = await transistorStudio(t);
  assert.match(doc.querySelector("h1").textContent, /Seu rascunho/);
  assert.equal(doc.querySelectorAll("#transistor-file option").length, 2);
  assert.equal(doc.querySelector("#transistor-file option").value, "file-approved");
  assert.match(doc.querySelector(".transistor-audio audio").getAttribute("src"), /file-approved/);
  assert.equal(doc.querySelector('[data-action="open-transistor-upload"]').disabled, false);
  await uploadApprovedDraft(doc, calls);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ["draft", "episode-1", {
    show_id: "show-1", file_id: "file-approved", summary: "Episode summary", keywords: "",
  }, true]);
  assert.match(doc.body.textContent, /Rascunho salvo/);
  assert.equal(doc.querySelector('[data-action="open-transistor-publish"]').disabled, true, "publishing waits for a remote status read-back");
  assert.equal(calls.some(([kind]) => kind === "publish"), false);
});

test("metadata is saved locally, then draft status must be refreshed before a distinct publish confirmation", async (t) => {
  const { doc, calls } = await transistorStudio(t);
  doc.querySelector("#transistor-title").value = "Edited locally";
  doc.querySelector('[data-action="save-transistor-metadata"]').click();
  await tick();
  assert.equal(calls[0][0], "metadata");
  assert.equal(calls[0][2].title, "Edited locally");
  await uploadApprovedDraft(doc, calls);
  await confirmDraftReadback(doc, calls);
  doc.querySelector('[data-action="open-transistor-publish"]').click();
  await tick();
  assert.equal(doc.getElementById("transistor-publish-dialog").open, true);
  assert.equal(calls.some(([kind]) => kind === "publish"), false, "opening the second confirmation must not publish");
  await consentAndClick(doc, "transistor-publish-consent", '[data-action="confirm-transistor-publish"]');
  assert.deepEqual(calls.at(-1), ["publish", "episode-1", "published", "", true]);
  assert.match(doc.body.textContent, /Publicado no Transistor/);
});

test("scheduling has its own confirmation and uses podcast timezone label", async (t) => {
  const { doc, calls } = await transistorStudio(t);
  await uploadApprovedDraft(doc, calls);
  await confirmDraftReadback(doc, calls);
  const radio = doc.querySelector('input[name="transistor-action"][value="scheduled"]');
  radio.checked = true;
  radio.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
  const date = doc.querySelector("#transistor-published-at");
  assert.equal(date.disabled, false);
  date.value = "2026-12-01T10:00";
  assert.match(doc.querySelector(".timezone-note").textContent, /America\/Sao_Paulo/);
  doc.querySelector('[data-action="open-transistor-publish"]').click();
  await tick();
  assert.equal(calls.some(([kind]) => kind === "publish"), false);
  await consentAndClick(doc, "transistor-publish-consent", '[data-action="confirm-transistor-publish"]');
  assert.deepEqual(calls.at(-1), ["publish", "episode-1", "scheduled", "2026-12-01T10:00", true]);
  assert.match(doc.body.textContent, /Agendado · ainda não publicado/);
});

test("schedule remains unavailable without a supported show time zone", async (t) => {
  const { doc, calls } = await transistorStudio(t, null, { timeZone: false });
  await uploadApprovedDraft(doc, calls);
  await confirmDraftReadback(doc, calls);
  const schedule = doc.querySelector('input[name="transistor-action"][value="scheduled"]');
  assert.equal(schedule.disabled, true);
  assert.match(doc.body.textContent, /agendamento não está disponível/i);
  assert.equal(doc.querySelector('[data-action="open-transistor-publish"]').disabled, false);
});

test("status refresh failure is visible and no automatic retry or publication occurs", async (t) => {
  const draft = { episode_id: "episode-1", file_id: "file-approved", show_id: "show-1", remote_episode_id: "remote-1", status: "draft", show_title: "Code & Scars", show_time_zone: "America/Sao_Paulo", show_time_zone_supported: true };
  const { doc, calls } = await transistorStudio(t, draft, { refreshError: true });
  doc.querySelector('[data-action="refresh-transistor"]').click();
  await tick();
  assert.equal(calls.filter(([kind]) => kind === "refresh").length, 1);
  assert.match(doc.getElementById("notice").textContent, /Status refresh failed|Falha ao atualizar/);
  assert.match(doc.getElementById("notice").textContent, /safe rate-limit response/);
  assert.equal(calls.some(([kind]) => kind === "publish"), false);
});

test("upload failure keeps only a same-file retry while uncertain draft creation blocks retries", async (t) => {
  const failed = await transistorStudio(t, null, { createFailure: "upload_failed" });
  await uploadApprovedDraft(failed.doc, failed.calls);
  assert.match(failed.doc.body.textContent, /Falha antes da criação do rascunho/);
  assert.equal(failed.doc.querySelector('[data-action="open-transistor-upload"]').disabled, false);
  assert.equal(failed.doc.querySelector("#transistor-show").disabled, true);
  assert.equal(failed.doc.querySelector("#transistor-file").disabled, true);
  assert.equal(failed.calls.filter(([kind]) => kind === "draft").length, 1);

  const uncertain = await transistorStudio(t, null, { createFailure: "creation_uncertain" });
  await uploadApprovedDraft(uncertain.doc, uncertain.calls);
  assert.match(uncertain.doc.body.textContent, /Inspecione o Transistor manualmente/);
  assert.equal(uncertain.doc.querySelector('[data-action="open-transistor-upload"]'), null);
  assert.equal(uncertain.doc.querySelector('[data-action="refresh-transistor"]'), null);
  assert.equal(uncertain.calls.filter(([kind]) => kind === "draft").length, 1);
});

test("show lookup errors are explicit, localized and disable the upload path", async (t) => {
  const { doc } = await transistorStudio(t, null, { showsError: true });
  assert.match(doc.querySelector('[role="alert"]').textContent, /TRANSISTOR_API_KEY/);
  assert.equal(doc.querySelector('[data-action="open-transistor-upload"]').disabled, true);
});
