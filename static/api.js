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
        throw new Error(detail || `A solicitação falhou (${response.status}).`);
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
      voices: () => send("/api/voices"),
      registerVoice: (value) => send("/api/voices", json("POST", value)),
    });
  }

  const api = { createApi, SCRIPT_PATHS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.StudioApi = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
