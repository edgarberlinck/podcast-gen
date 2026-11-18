const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { JSDOM } = require("jsdom");

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function transistorStudio(t, initialPublication = null) {
  const dom = new JSDOM(readFileSync("static/index.html", "utf8"), {
    url: "http://localhost/#transistor/episode-1", runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const episode = { id: "episode-1", title: "Local episode", description: "Episode summary", language: "en" };
  const files = [
    { id: "file-approved", filename: "approved.mp3", size_bytes: 4096, created_at: "2026-11-18T00:31:00Z", approval_status: "approved" },
    { id: "file-pending", filename: "pending.mp3", size_bytes: 512, created_at: "2026-11-18T00:32:00Z", approval_status: "pending" },
  ];
  let publication = initialPublication && { ...initialPublication };
  const calls = [];
  const confirmations = [];
  dom.window.confirm = (message) => { confirmations.push(message); return true; };
  const api = {
    episode: async () => ({ ...episode }),
    episodeFiles: async () => ({ files }),
    transistorPublication: async () => ({ publication }),
    transistorShows: async () => ({ shows: [{ id: "show-1", title: "Code & Scars", time_zone: "America/Sao_Paulo" }] }),
    createTransistorDraft: async (id, value, confirmed) => {
      calls.push(["draft", id, value, confirmed]);
      publication = { episode_id: id, file_id: value.file_id, show_id: value.show_id, remote_episode_id: "remote-1", status: "draft", show_title: "Code & Scars", show_time_zone: "America/Sao_Paulo", show_time_zone_supported: true };
      return { publication };
    },
    refreshTransistorPublication: async (id) => {
      calls.push(["refresh", id]);
      publication = { ...publication, status: "published" };
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
  return { dom, doc: dom.window.document, calls, confirmations };
}

test("Transistor screen uploads only explicitly selected approved audio and stops at draft", async (t) => {
  const { doc, calls, confirmations } = await transistorStudio(t);
  assert.match(doc.querySelector("h1").textContent, /Publicação no Transistor/);
  assert.equal(doc.querySelectorAll("#transistor-file option").length, 1);
  assert.equal(doc.querySelector("#transistor-file option").value, "file-approved");
  assert.equal(doc.querySelector('[data-action="create-transistor-draft"]').disabled, false);
  doc.querySelector('[data-action="create-transistor-draft"]').click();
  await tick();
  assert.match(confirmations[0], /nada será publicado/i);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ["draft", "episode-1", {
    show_id: "show-1", file_id: "file-approved", summary: "Episode summary", keywords: "",
  }, true]);
  assert.match(doc.body.textContent, /Rascunho criado no Transistor/);
  assert.equal(doc.querySelector('[data-action="publish-transistor"][data-status="published"]') !== null, true);
  assert.equal(calls.some(([kind]) => kind === "publish"), false);
});

test("publishing and scheduling each require a separate confirmation; refresh reads status", async (t) => {
  const draft = { episode_id: "episode-1", file_id: "file-approved", show_id: "show-1", remote_episode_id: "remote-1", status: "draft", show_title: "Code & Scars", show_time_zone: "America/Sao_Paulo", show_time_zone_supported: true };
  const { doc, calls, confirmations } = await transistorStudio(t, draft);
  doc.querySelector('[data-action="publish-transistor"][data-status="published"]').click();
  await tick();
  assert.match(confirmations[0], /ação externa separada/i);
  assert.deepEqual(calls[0], ["publish", "episode-1", "published", "", true]);
  assert.match(doc.body.textContent, /Publicado/);

  const scheduledStudio = await transistorStudio(t, draft);
  const date = scheduledStudio.doc.querySelector("#transistor-published-at");
  date.value = "2026-12-01T10:00";
  scheduledStudio.doc.querySelector('[data-action="publish-transistor"][data-status="scheduled"]').click();
  await tick();
  assert.match(scheduledStudio.confirmations[0], /horário local do podcast selecionado/i);
  assert.deepEqual(JSON.parse(JSON.stringify(scheduledStudio.calls[0])), ["publish", "episode-1", "scheduled", "2026-12-01T10:00", true]);

  scheduledStudio.doc.querySelector('[data-action="refresh-transistor"]').click();
  await tick();
  assert.equal(scheduledStudio.calls.at(-1)[0], "refresh");
  assert.match(scheduledStudio.doc.body.textContent, /Publicado/);
});

test("scheduling stays disabled when the show time zone is unavailable", async (t) => {
  const draft = { episode_id: "episode-1", file_id: "file-approved", show_id: "show-1", remote_episode_id: "remote-1", status: "draft", show_title: "Code & Scars", show_time_zone: "", show_time_zone_supported: false };
  const { doc } = await transistorStudio(t, draft);
  assert.equal(doc.querySelector('[data-action="publish-transistor"][data-status="scheduled"]').disabled, true);
  assert.equal(doc.querySelector('[data-action="publish-transistor"][data-status="published"]').disabled, false);
  assert.match(doc.body.textContent, /servidor não reconhece o fuso retornado/i);
});
