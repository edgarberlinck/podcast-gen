(function (root) {
  "use strict";

  const SCRIPT_PATHS = Object.freeze({
    narration: "narration",
    fishAudio: "fish-audio",
  });

  function createApi(fetchImpl) {
    const request = fetchImpl || ((...args) => root.fetch(...args));

    async function send(path, options = {}) {
      let response;
      try {
        response = await request(path, {
          ...options,
          headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
        });
      } catch (error) {
        throw new Error("Não foi possível conectar ao estúdio local. Verifique se o servidor está em execução.", { cause: error });
      }
      const contentType = response.headers && response.headers.get ? response.headers.get("Content-Type") || "" : "";
      const payload = contentType.includes("application/json") ? await response.json() : null;
      if (!response.ok) {
        const detail = payload && payload.error && payload.error.message;
        const error = new Error(detail || `A solicitação falhou (${response.status}).`);
        error.code = payload && payload.error && payload.error.code;
        throw error;
      }
      return payload;
    }

    function json(method, value) {
      return { method, body: JSON.stringify(value) };
    }

    return Object.freeze({
      dashboard: () => send("/api/dashboard"),
      episodes: () => send("/api/episodes"),
      episode: (id) => send(`/api/episodes/${encodeURIComponent(id)}`),
      createEpisode: (value) => send("/api/episodes", json("POST", value)),
      updateEpisode: (id, value) => send(`/api/episodes/${encodeURIComponent(id)}`, json("PATCH", value)),
      saveOriginal: (id, content, confirmed) => {
        if (confirmed !== true) throw new Error("A confirmação explícita é necessária para editar o artigo original.");
        return send(`/api/episodes/${encodeURIComponent(id)}/original`, json("PUT", { content, confirm_edit: true }));
      },
      saveScript: (id, kind, content) => {
        const route = SCRIPT_PATHS[kind];
        if (!route) throw new Error("Tipo de roteiro desconhecido.");
        return send(`/api/episodes/${encodeURIComponent(id)}/scripts/${route}`, json("PUT", { content }));
      },
      narrationSuggestions: (id) => send(`/api/episodes/${encodeURIComponent(id)}/narration-suggestions`),
      requestNarrationSuggestion: (id, scope, paragraphIndex) => {
        const body = scope === "paragraph" ? { scope, paragraph_index: paragraphIndex } : { scope };
        return send(`/api/episodes/${encodeURIComponent(id)}/narration-suggestions`, json("POST", body));
      },
      approveFishScript: (id, content, confirmed) => {
        if (confirmed !== true) throw new Error("A confirmação explícita é necessária para aprovar o script Fish Audio.");
        return send(`/api/episodes/${encodeURIComponent(id)}/scripts/fish-audio-approval`, json("POST", { content, confirm_approval: true }));
      },
      voices: () => send("/api/voices"),
      registerVoice: (value) => send("/api/voices", json("POST", value)),
      generationHandoffs: (id) => send(`/api/episodes/${encodeURIComponent(id)}/generation-handoffs`),
      prepareGenerationHandoff: (id, confirmed) => {
        if (confirmed !== true) throw new Error("A confirmação explícita é necessária para preparar o handoff.");
        return send(`/api/episodes/${encodeURIComponent(id)}/generation-handoffs`, json("POST", { confirm_handoff: true }));
      },
      importGeneration: (episodeId, handoffId, file) => send(
        `/api/episodes/${encodeURIComponent(episodeId)}/generation-handoffs/${encodeURIComponent(handoffId)}/import?filename=${encodeURIComponent(file.name)}`,
        { method: "POST", body: file, headers: { "Content-Type": file.type || `audio/${file.name.split(".").pop().toLowerCase()}` } },
      ),
      failGenerationHandoff: (episodeId, handoffId, failureCode) => send(
        `/api/episodes/${encodeURIComponent(episodeId)}/generation-handoffs/${encodeURIComponent(handoffId)}/failure`,
        json("POST", { confirm_failure: true, failure_code: failureCode }),
      ),
      episodeFiles: (id) => send(`/api/episodes/${encodeURIComponent(id)}/files`),
      transistorShows: () => send("/api/transistor/shows"),
      transistorPublication: (id) => send(`/api/episodes/${encodeURIComponent(id)}/transistor`),
      createTransistorDraft: (id, value, confirmed) => {
        if (confirmed !== true) throw new Error("Explicit confirmation is required to upload audio to Transistor.");
        return send(`/api/episodes/${encodeURIComponent(id)}/transistor/draft`, json("POST", { ...value, confirm_upload: true }));
      },
      refreshTransistorPublication: (id) => send(`/api/episodes/${encodeURIComponent(id)}/transistor/refresh`, json("POST", {})),
      publishTransistorEpisode: (id, status, publishedAt, confirmed) => {
        if (confirmed !== true) throw new Error("A separate explicit confirmation is required to publish or schedule.");
        return send(`/api/episodes/${encodeURIComponent(id)}/transistor/publish`, json("POST", {
          status, ...(publishedAt ? { published_at: publishedAt } : {}), confirm_publish: true,
        }));
      },
      reviewAudioFile: (id, status, confirmed) => {
        if (confirmed !== true) throw new Error("A confirmação explícita é necessária para revisar o áudio.");
        return send(`/api/files/${encodeURIComponent(id)}/review`, json("POST", { status, confirm_review: true }));
      },
    });
  }

  const api = { createApi, SCRIPT_PATHS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.StudioApi = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
