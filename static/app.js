(function () {
  "use strict";

  const api = window.StudioApi.createApi();
  const view = document.getElementById("view");
  const notice = document.getElementById("notice");
  const importInput = document.getElementById("article-import");
  const statuses = ["Draft", "Preparing Script", "Script Review", "Ready for Generation", "Generating Audio", "Audio Review", "Approved", "Publishing", "Published", "Failed"];
  const FISH_AUDIO_MODEL_LABEL = "Fish Audio Drama 3";
  const VOICE_SAMPLE_SCRIPTS = Object.freeze({
    pt: "Olá, meu nome é [diga seu nome]. Hoje, compartilho uma história. Pela manhã, abri a janela e ouvi a cidade despertar: passos na calçada, uma conversa distante e o vento entre as árvores.\n\nImaginei de onde vinha cada pessoa e para onde ia. Uma pequena curiosidade pode transformar um caminho comum em descoberta.\n\nMais tarde, encontrei uma amiga. Conversamos sobre planos e lembranças, rimos de algo inesperado e o tempo pareceu passar devagar.\n\nNo fim do dia, voltei para casa serena. Nem toda mudança começa com um grande acontecimento; às vezes, basta parar, observar e contar o que sentimos.",
    en: "Hello, my name is [say your name]. Today, I have a story to share. In the morning, I opened the window and heard the city waking up: footsteps on the sidewalk, a distant conversation, and wind moving through the trees.\n\nI wondered where each person had come from and where they were going. A small question can turn an ordinary walk into a discovery.\n\nLater, I met a friend. We talked about plans and memories, laughed at something unexpected, and time seemed to slow down.\n\nAt the end of the day, I returned home feeling calm. Not every change begins with a dramatic event; sometimes it is enough to pause, notice, and describe what we feel.",
  });
  let pageRequest = 0;
  let currentRoute = "";
  let originalUnlocked = false;
  let currentVoices = [];
  let episodeCache = [];
  let listFilters = { search: "", status: "", language: "" };
  let scriptReview = null;
  let interfaceLanguage = null;
  let generationLanguage = null;
  let pendingAudioReview = null;
  let voiceSampleFile = null;
  let voiceRecorder = null;
  let voiceRecorderStream = null;
  let voiceRecorderChunks = [];
  let voiceRecorderTimer = null;
  let voiceRecorderStopHandler = null;
  let voiceSamplePreviewUrl = "";
  let voiceClonePollTimer = null;
  const confirmedTransistorDrafts = new Set();

  const h = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const langName = (code) => code === "en" ? "English" : "Português (Brasil)";
  const langShort = (code) => code === "en" ? "EN" : "PT-BR";
  const fishVisibilityName = (value) => ({ private: "privada", unlist: "não listada", public: "pública", unknown: "não informada" }[value] || value);
  const languageSelect = (selected) => `<select id="episode-language" aria-label="Idioma do conteúdo" required><option value="pt" ${selected === "pt" ? "selected" : ""}>Português (Brasil)</option><option value="en" ${selected === "en" ? "selected" : ""}>English</option></select>`;
  const statusOptions = (selected, includeAll = false) => `${includeAll ? '<option value="">Todos os status</option>' : ""}${statuses.map((status) => `<option value="${h(status)}" ${status === selected ? "selected" : ""}>${h(status)}</option>`).join("")}`;
  const dateLabel = (stamp, locale = "pt-BR") => {
    if (!stamp) return "";
    const date = new Date(stamp);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
  };
  const formatAudioDuration = (seconds) => {
    const duration = Math.floor(seconds);
    const hours = Math.floor(duration / 3600);
    const minutes = Math.floor((duration % 3600) / 60);
    const remaining = duration % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}` : `${minutes}:${String(remaining).padStart(2, "0")}`;
  };
  const statusClass = (status) => status === "Draft" ? "draft" : ["Script Review", "Audio Review"].includes(status) ? "review" : ["Ready for Generation", "Approved"].includes(status) ? "ready" : "";
  const articleStats = (text) => {
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    return `${words.toLocaleString("pt-BR")} palavras · ${Math.max(1, Math.ceil(words / 180))} min de leitura`;
  };
  function showNotice(message, type = "success") {
    notice.textContent = message;
    notice.className = `notice ${type}`;
    notice.hidden = false;
  }
  function hideNotice() { notice.hidden = true; notice.textContent = ""; }
  function go(hash) { window.location.hash = hash; }
  function heading(title, subtitle, action = "") {
    return `<div class="page-heading"><div><h1>${h(title)}</h1><p>${h(subtitle)}</p></div>${action ? `<div class="heading-actions">${action}</div>` : ""}</div>`;
  }
  function setNav(active, crumb) {
    document.querySelectorAll("[data-nav]").forEach((link) => {
      if (link.dataset.nav === active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    document.getElementById("breadcrumb").textContent = `Estúdio / ${crumb}`;
  }
  function fail(error, retryHash) {
    view.innerHTML = `<section class="error-state" role="alert"><h2>Não foi possível carregar esta página</h2><p>${h(error.message)}</p><button class="button secondary" data-action="retry" data-hash="${h(retryHash)}">Tentar novamente</button></section>`;
  }
  function statusChip(status) {
    return `<span class="status-chip ${statusClass(status)}">${h(status || "Draft")}</span>`;
  }

  function setShellLanguage(language) {
    const english = language === "en";
    document.documentElement.lang = english ? "en" : "pt-BR";
    const labels = english ? ["Overview", "Episodes", "Voice library"] : ["Visão geral", "Episódios", "Biblioteca de vozes"];
    document.querySelectorAll(".primary-nav a").forEach((link, index) => {
      link.lastChild.textContent = ` ${labels[index]}`;
    });
    document.querySelector(".sidebar").setAttribute("aria-label", english ? "Main navigation" : "Navegação principal");
    document.querySelector(".brand").setAttribute("aria-label", english ? "Código & Cicatriz, overview" : "Código & Cicatriz, visão geral");
    document.querySelector(".skip-link").textContent = english ? "Skip to content" : "Pular para o conteúdo";
    document.querySelector(".sidebar-kicker").textContent = english ? "LOCAL STUDIO" : "ESTÚDIO LOCAL";
    document.querySelector(".local-note strong").textContent = english ? "DATA ON THIS DEVICE" : "DADOS NO DISPOSITIVO";
    document.querySelector(".local-note p").textContent = english ? "Your studio stays on your computer." : "Seu estúdio permanece no seu computador.";
    document.querySelector(".sidebar-footer").textContent = english ? "v0.3 · editorial review" : "v0.3 · revisão editorial";
  }

  async function loadRoute() {
    const requestId = ++pageRequest;
    const nextRoute = window.location.hash || "#dashboard";
    if (currentRoute === "#voices" && nextRoute !== "#voices" && voiceRecorder) discardVoiceRecording();
    currentRoute = nextRoute;
    scriptReview = null;
    setShellLanguage("pt");
    originalUnlocked = false;
    hideNotice();
    view.innerHTML = '<div class="loading" role="status">Carregando seu estúdio…</div>';
    const route = currentRoute.slice(1).split("/");
    try {
      if (route[0] === "episodes") return await renderEpisodes(requestId);
      if (route[0] === "episode" && route[1] === "new") return renderEpisodeEditor(null);
      if (route[0] === "episode" && route[1]) return await renderEpisodeEditor(route[1], requestId);
      if (route[0] === "scripts" && route[1]) return await renderScripts(route[1], requestId);
      if (route[0] === "generation" && route[1]) return await renderGeneration(route[1], requestId);
      if (route[0] === "transistor" && route[1]) return await renderTransistor(route[1], requestId);
      if (route[0] === "voices") return await renderVoices(requestId);
      return await renderDashboard(requestId);
    } catch (error) {
      if (requestId === pageRequest) fail(error, currentRoute);
    }
  }

  async function renderDashboard(requestId) {
    setNav("dashboard", "Visão geral");
    const data = await api.dashboard();
    if (requestId !== pageRequest) return;
    const episodes = data.recent_episodes || [];
    const recent = episodes[0];
    const recentList = episodes.slice(0, 4);
    const recentCard = recent ? `<article class="continue-card"><div class="cover-art"><span>ARTE EDITORIAL</span></div><div class="episode-meta"><span class="eyebrow">${h(recent.status)} · ${langShort(recent.language)}</span><h3>${h(recent.title)}</h3><p>Continue o trabalho editorial salvo localmente. Suas versões permanecem separadas.</p><div class="meta-bottom"><span>Atualizado ${h(dateLabel(recent.updated_at))}</span><a class="button small" href="#episode/${encodeURIComponent(recent.id)}">Abrir episódio →</a></div></div></article>` : `<div class="empty-state"><h2>Seu próximo episódio começa aqui</h2><p>Crie um rascunho para começar a guardar seu artigo e os roteiros em versões independentes.</p><a class="button primary" href="#episode/new">+ Criar episódio</a></div>`;
    const activity = recentList.length ? recentList.map((episode) => `<li>${h(episode.title)} · ${h(episode.status)}<time>${h(dateLabel(episode.updated_at))}</time></li>`).join("") : '<li>Nenhuma atividade ainda.<time>Seus registros ficam neste dispositivo.</time></li>';
    view.innerHTML = `${heading("Bom dia. O próximo episódio começa aqui.", "Seu espaço de trabalho editorial — sem etapas automáticas nem surpresas.", '<a class="button primary" href="#episode/new">+ Criar episódio</a>')}
      <section class="metrics" aria-label="Métricas do estúdio">
        <div class="metric"><span class="metric-label">Episódios no estúdio</span><div class="metric-value">${data.total_episodes || 0}</div><span class="metric-foot">Conteúdo local</span></div>
        <div class="metric"><span class="metric-label">Rascunhos</span><div class="metric-value">${data.draft_episodes || 0}</div><span class="metric-foot">Salvos para continuar</span></div>
        <div class="metric"><span class="metric-label">Em revisão editorial</span><div class="metric-value">${data.awaiting_review || 0}</div><span class="metric-foot">Requerem sua atenção</span></div>
        <div class="metric"><span class="metric-label">Publicados</span><div class="metric-value">${data.published_episodes || 0}</div><span class="metric-foot">Registro editorial local</span></div>
      </section>
      <div class="dashboard-grid"><section><div class="section-title"><h2>Continue de onde parou</h2><a class="text-link" href="#episodes">Ver episódios →</a></div>${recentCard}</section>
      <aside class="activity-panel"><h2>Atividade recente</h2><ul class="activity-list">${activity}</ul><p class="activity-hint">As datas refletem a última alteração registrada localmente. Nenhuma etapa automática é executada.</p></aside></div>
      <section class="workflow"><h2 class="workflow-title">Um fluxo, três textos independentes</h2><p class="workflow-subtitle">O original nunca é substituído pela adaptação de narração ou pelo roteiro formatado.</p><div class="workflow-grid">
      <article class="workflow-card"><span class="eyebrow">01 · Fonte editorial</span><h3>Artigo original</h3><p>Seu texto, editável e preservado como uma versão separada.</p><span class="step-status">● Salvo localmente</span></article>
      <article class="workflow-card"><span class="eyebrow">02 · Texto para leitura</span><h3>Roteiro de narração</h3><p>Uma versão editorial separada, revisada por você.</p><span class="step-status">— Edição manual</span></article>
      <article class="workflow-card"><span class="eyebrow">03 · Formatação manual</span><h3>Script Fish Audio</h3><p>Etiquetas editadas à mão. Sem geração nesta fase.</p><span class="step-status">◷ Geração indisponível</span></article></div></section>`;
  }

  function renderEpisodeRow(episode) {
    const contentSummary = episode.original_article ? (episode.narration_script || episode.fish_audio_script ? "Artigo e versões de roteiro salvos" : "Artigo original salvo · roteiro ainda não criado") : "Artigo original ainda não preenchido";
    return `<article class="episode-row"><div><a class="row-title" href="#episode/${encodeURIComponent(episode.id)}">${h(episode.title)}</a><span class="row-subtitle">${h(contentSummary)}</span></div><div>${statusChip(episode.status)}</div><span class="lang">${langShort(episode.language)}</span><span class="updated">${h(dateLabel(episode.updated_at))}</span><a class="row-open" href="#episode/${encodeURIComponent(episode.id)}" aria-label="Abrir episódio ${h(episode.title)}">Abrir →</a></article>`;
  }
  async function renderEpisodes(requestId) {
    setNav("episodes", "Episódios");
    const result = await api.episodes();
    if (requestId !== pageRequest) return;
    episodeCache = result.episodes || [];
    renderEpisodeList();
  }
  function renderEpisodeList(restoreFocus = false) {
    const activeId = restoreFocus && document.activeElement ? document.activeElement.id : "";
    const selection = activeId === "episode-search" ? document.activeElement.selectionStart : null;
    const query = listFilters.search.trim().toLocaleLowerCase();
    const episodes = episodeCache.filter((episode) => (!query || `${episode.title} ${episode.description}`.toLocaleLowerCase().includes(query)) && (!listFilters.status || episode.status === listFilters.status) && (!listFilters.language || episode.language === listFilters.language));
    view.innerHTML = `${heading("Episódios", "Sua produção, do rascunho à revisão editorial.", '<a class="button primary" href="#episode/new">+ Novo episódio</a>')}
      <section class="panel"><div class="filters"><label class="sr-only" for="episode-search">Buscar título ou descrição</label><input id="episode-search" type="search" placeholder="⌕  Buscar título ou descrição" value="${h(listFilters.search)}"><label class="sr-only" for="status-filter">Filtrar por status</label><select id="status-filter" aria-label="Filtrar por status">${statusOptions(listFilters.status, true)}</select><label class="sr-only" for="language-filter">Filtrar por idioma</label><select id="language-filter" aria-label="Filtrar por idioma"><option value="">Todos os idiomas</option><option value="pt" ${listFilters.language === "pt" ? "selected" : ""}>Português (Brasil)</option><option value="en" ${listFilters.language === "en" ? "selected" : ""}>English</option></select><span class="muted">${episodes.length} episódio${episodes.length === 1 ? "" : "s"} · armazenado localmente</span></div></section>
      ${episodes.length ? `<div class="table-head" aria-hidden="true"><span>Episódio</span><span>Etapa editorial</span><span>Idioma</span><span>Última alteração</span><span></span></div><div class="episode-list">${episodes.map(renderEpisodeRow).join("")}</div>` : `<div class="empty-state"><h2>${episodeCache.length ? "Nenhum episódio encontrado" : "Ainda não há episódios"}</h2><p>${episodeCache.length ? "Tente ajustar os filtros de busca." : "Crie seu primeiro rascunho para começar."}</p>${episodeCache.length ? "" : '<a class="button primary" href="#episode/new">+ Criar episódio</a>'}</div>`}
      <div class="info-strip">“Publicados” registra seu histórico editorial local. Esta versão não envia conteúdo a plataformas externas.</div>`;
    if (activeId) {
      const restored = document.getElementById(activeId);
      if (restored) {
        restored.focus();
        if (selection !== null && restored.setSelectionRange) restored.setSelectionRange(selection, selection);
      }
    }
  }

  async function renderEpisodeEditor(id, requestId = pageRequest) {
    setNav("episodes", id ? "Episódios / Editar episódio" : "Episódios / Novo episódio");
    let episode = null;
    let voices = [];
    currentVoices = [];
    if (id) [episode, voices] = await Promise.all([api.episode(id), api.voices().then((result) => result.voices || [])]);
    if (id && requestId !== pageRequest) return;
    currentVoices = voices;
    const language = episode ? episode.language : "pt";
    const voiceOptions = voices.filter((voice) => voice.language === language);
    const selectedVoice = episode && episode.selected_voice_id;
    const voiceSelect = `<select id="episode-voice"><option value="">Sem voz selecionada</option>${voiceOptions.map((voice) => `<option value="${h(voice.id)}" ${voice.id === selectedVoice ? "selected" : ""}>${h(voice.display_name)} · ${langShort(voice.language)}</option>`).join("")}</select>`;
    const title = episode ? "Editar episódio" : "Criar episódio";
    const originalLabel = episode ? "Artigo original — versão atual" : "Artigo original";
    const originalText = episode ? episode.original_article : "";
    view.innerHTML = `<div class="editor-top"><div>${heading(title, "Comece pelo artigo. Seu original e cada roteiro ficam em versões próprias.")}</div><div class="heading-actions">${episode ? `<span class="save-state">● Salvo localmente</span>` : ""}<button class="button" data-action="save-episode">Salvar rascunho</button></div></div>
      <section class="panel"><span class="eyebrow">Detalhes do episódio</span><div class="form-grid" style="margin-top:15px">
        <div class="form-field"><label for="episode-title">Título do episódio <span aria-hidden="true">*</span></label><input id="episode-title" maxlength="300" required value="${h(episode ? episode.title : "")}" placeholder="Ex.: Entre linhas de código e cicatrizes"></div>
        <div class="form-field"><label for="episode-language">Idioma do conteúdo <span aria-hidden="true">*</span></label>${languageSelect(language)}</div>
        <div class="form-field full"><label for="episode-description">Descrição do episódio</label><textarea id="episode-description" rows="2" style="min-height:74px" maxlength="10000" placeholder="Uma breve descrição editorial">${h(episode ? episode.description : "")}</textarea></div>
        ${episode ? `<div class="form-field"><label for="episode-status">Etapa editorial</label><select id="episode-status">${statusOptions(episode.status)}</select><p class="field-help">O status é apenas um rótulo local; esta tela não gera áudio nem publica.</p></div><div class="form-field"><label for="episode-voice">Voz selecionada</label>${voiceSelect}<p class="field-help">A biblioteca guarda metadados locais e não valida identificadores externamente.</p></div>` : ""}
      </div></section>
      <div class="section-title"><h2>${originalLabel}</h2><div class="heading-actions"><span class="status-chip draft">VERSÃO FONTE · ${episode ? "#1+" : "#1"}</span><button class="button secondary small" data-action="import-article">Colar ou importar texto</button></div></div>
      ${episode ? `<p class="danger-note" id="original-safety">O artigo original está protegido. Para alterá-lo, escolha “Editar artigo original”; a gravação da versão alterada exige uma confirmação adicional e preserva a versão anterior.</p><div class="save-row" style="justify-content:flex-start;margin:0 0 10px"><button class="button subtle small" data-action="unlock-original">Editar artigo original…</button></div>` : ""}
      <div class="editor-wrap"><div class="source-toolbar"><span>ARTIGO ORIGINAL · TEXTO SIMPLES</span><span id="article-stats">${articleStats(originalText)}</span></div><textarea id="original-article" maxlength="100000" aria-label="${h(originalLabel)}" placeholder="Escreva ou cole o artigo original aqui…" ${episode ? "readonly" : ""}>${h(originalText)}</textarea></div>
      <div class="save-row"><span class="save-state" id="episode-save-state" aria-live="polite"></span>${episode ? `<a class="button secondary" href="#scripts/${encodeURIComponent(episode.id)}">Abrir e comparar roteiros →</a>` : ""}<button class="button" data-action="save-episode">${episode ? "Salvar alterações" : "Salvar e continuar →"}</button></div>
      ${episode ? `<section class="panel" style="margin-top:22px"><div class="section-title"><h2>Voz para este episódio</h2><a class="text-link" href="#voices">Biblioteca de vozes →</a></div><p class="muted">${selectedVoice ? `Voz selecionada: ${h((voices.find((voice) => voice.id === selectedVoice) || {}).display_name || "Voz registrada")}` : "Nenhuma voz selecionada."} A seleção não inicia geração de áudio.</p></section>` : ""}`;
  }

  async function renderScripts(id, requestId) {
    setNav("episodes", "Episódios / Roteiros");
    const [episode, voicesResult, suggestionResult] = await Promise.all([
      api.episode(id), api.voices(), api.narrationSuggestions(id),
    ]);
    if (requestId !== pageRequest) return;
    const suggestions = suggestionResult.suggestions || [];
    scriptReview = {
      id, episode, voices: voicesResult.voices || [], suggestions,
      originalParts: episode.original_article.split(/\r?\n[ \t]*\r?\n/),
      selectedIndex: 0, scope: "article", selectedSuggestion: suggestions[0] || null,
      busy: false, error: false, request: null, stage: "narration", saving: false,
      narrationDraft: episode.narration_script, fishDraft: episode.fish_audio_script,
      voiceId: episode.selected_voice_id || "", suggestionEdits: {},
      language: interfaceLanguage || episode.language,
    };
    paintScriptReview();
  }

  // Changing stage or interface language never saves or translates editorial text.
  function captureScriptEditors() {
    if (!scriptReview) return;
    const fields = { "narration-script": "narrationDraft", "fish-script": "fishDraft", "script-voice": "voiceId" };
    Object.entries(fields).forEach(([id, key]) => {
      const field = document.getElementById(id);
      if (field) scriptReview[key] = field.value;
    });
    const suggestion = document.getElementById("suggestion-text");
    if (suggestion && scriptReview.selectedSuggestion) scriptReview.suggestionEdits[scriptReview.selectedSuggestion.id] = suggestion.value;
  }

  function paintScriptReview(focusHeading = false) {
    const { episode, originalParts, voices, stage, language } = scriptReview;
    const fishStage = stage === "fish";
    const english = language === "en";
    setShellLanguage(language);
    const strings = english ? {
      crumb: "Episodes / Narration review", title: "Prepare the narration draft", safety: "Suggestions are drafts — they never change your original article.", safetyCopy: "Your source stays read-only. Review each change and save narration separately when ready.",
      original: "Original article", narration: "Narration draft", fish: "Fish Audio script", source: "SOURCE PRESERVED · READ ONLY", select: "Select paragraph", article: "Whole article", articleDetail: "Complete source text", paragraph: "Selected paragraph", paragraphDetail: "Only selected paragraph; other draft text stays unchanged", history: "Previous suggestions", readOnly: "read-only", voiceReference: "Voice reference", noVoice: "No voice is selected. Approval does not contact Fish Audio.", versions: "Editorial versions", request: "Request suggestion", sourceEmpty: "Add text to the original article before requesting a suggestion.", scopeLabel: "Choose a suggestion scope", compare: "Compare with original", suggestion: "Suggestion · editable", use: "Use in draft", keep: "Keep current text", save: "Save changes", fishTitle: "Review and approve Fish Audio script", approve: "Approve this saved version", pending: "Awaiting your decision", approved: "This exact saved version is approved", notSaved: "Save changes before approving this version.", confirmation: "Approve this exact saved Fish Audio script? This does not generate audio or publish.", confirm: "Yes, approve this version", cancel: "Back to review", retry: "Try again", loading: "Preparing suggestion… Your saved draft and source are unchanged.", safeError: "We couldn’t create this suggestion. Your original and saved draft are unchanged. Try again or continue editing manually. Technical details are hidden.", selected: "Selected paragraph", saved: "Saved locally", noSuggestion: "Request a suggestion to compare it here. Suggestions are never applied automatically.", review: "Review meaning and factual fidelity; suggestions are not fact checks.", manual: "Manual edit", saveOk: "Current script saved locally; other versions are unchanged.", approvedToast: "This exact saved Fish Audio script was approved.",
    } : {
      crumb: "Episódios / Preparar narração", title: "Preparar roteiro de narração", safety: "Sugestões são rascunhos — não alteram seu artigo original.", safetyCopy: "O original fica somente para leitura. Revise cada mudança e salve o roteiro separadamente.",
      original: "Artigo original", narration: "Roteiro de narração", fish: "Script Fish Audio", source: "FONTE PRESERVADA · SOMENTE LEITURA", select: "Selecionar parágrafo", article: "Artigo inteiro", articleDetail: "Texto-fonte completo", paragraph: "Parágrafo selecionado", paragraphDetail: "Somente o parágrafo selecionado; o restante do rascunho permanece igual", history: "Sugestões anteriores", readOnly: "somente leitura", voiceReference: "Voz selecionada para referência", noVoice: "Nenhuma voz selecionada. A aprovação não contata o Fish Audio.", versions: "Versões editoriais", request: "Gerar sugestão", sourceEmpty: "Adicione texto ao artigo original antes de pedir uma sugestão.", scopeLabel: "Como você quer preparar a sugestão?", compare: "Comparar com o original", suggestion: "Sugestão · editável", use: "Usar no rascunho", keep: "Manter texto atual", save: "Salvar alterações", fishTitle: "Revisar e aprovar script Fish Audio", approve: "Aprovar esta versão salva", pending: "Aguardando sua decisão", approved: "Esta versão salva exata está aprovada", notSaved: "Salve as alterações antes de aprovar esta versão.", confirmation: "Aprovar este script Fish Audio salvo exatamente? Isto não gera áudio nem publica.", confirm: "Sim, aprovar esta versão", cancel: "Voltar à revisão", retry: "Tentar novamente", loading: "Preparando sugestão… O rascunho salvo e o original permanecem intactos.", safeError: "Não foi possível criar esta sugestão. O artigo original e o roteiro salvo permanecem intactos. Tente novamente ou continue editando. Detalhes técnicos foram ocultados.", selected: "Parágrafo selecionado", saved: "Salvo localmente", noSuggestion: "Peça uma sugestão para compará-la aqui. Sugestões nunca são aplicadas automaticamente.", review: "Revise o sentido e a fidelidade factual; sugestões não verificam fatos.", manual: "Edição manual", saveOk: "Roteiro atual salvo localmente; as outras versões permanecem intactas.", approvedToast: "Esta versão exata do script Fish Audio foi aprovada.",
    };
    Object.assign(strings, english ? {
      language: "Interface language", next: "Review Fish Audio script →", back: "← Back to narration",
      nextCopy: "A separate version. Review and approve it yourself; no step generates audio.",
      savedNarration: "Saved narration draft", unsaved: "Unsaved changes", preserved: "Preserved · read-only",
      approvalSafety: "All three versions remain separate.", approvalCopy: "Approval confirms only this exact saved script. It does not generate audio, contact Fish Audio, or publish.",
      summary: "Version summary", comparison: "Compare with source versions", savedVersion: "Saved script", empty: "No saved text yet",
    } : {
      language: "Idioma da interface", next: "Revisar script Fish Audio →", back: "← Voltar à narração",
      nextCopy: "Versão separada. Você revisa e aprova; nenhuma etapa gera áudio.",
      savedNarration: "Roteiro de narração salvo", unsaved: "Alterações não salvas", preserved: "Preservado · somente leitura",
      approvalSafety: "As três versões continuam separadas.", approvalCopy: "A aprovação confirma apenas este script salvo exato. Não gera áudio, não contata o Fish Audio nem publica.",
      summary: "Resumo das versões", comparison: "Compare com as versões-fonte", savedVersion: "Script salvo", empty: "Nenhum texto salvo ainda",
    });
    scriptReview.strings = strings;
    setNav("episodes", strings.crumb);
    document.getElementById("breadcrumb").textContent = `${english ? "Studio" : "Estúdio"} / ${fishStage ? strings.fishTitle : strings.crumb}`;
    const selectedVoice = voices.find((voice) => voice.id === scriptReview.voiceId);
    const paragraphButtons = originalParts.map((paragraph, index) => `<li><button type="button" class="source-paragraph" data-action="select-paragraph" data-index="${index}" aria-pressed="false" ${paragraph.trim() ? "" : "disabled"}><span>${h(strings.select)} ${index + 1}</span><span>${h(paragraph)}</span></button></li>`).join("");
    view.innerHTML = `<div class="review-language"><label for="interface-language">${h(strings.language)}</label><select id="interface-language" ${scriptReview.saving ? "disabled" : ""}><option value="pt" ${english ? "" : "selected"}>PT-BR</option><option value="en" ${english ? "selected" : ""}>EN</option></select></div>
      <div class="editor-top"><div>${heading(fishStage ? strings.fishTitle : strings.title, `${episode.title} · ${langName(episode.language)}`)}</div><div class="heading-actions"><button class="button" data-action="save-scripts" ${scriptReview.saving ? "disabled" : ""}>${h(strings.save)}</button></div></div>
      <nav class="script-steps" aria-label="${h(strings.versions)}"><span>01 · ${h(strings.original)}</span><span ${fishStage ? "" : 'aria-current="step"'}>02 · ${h(strings.narration)}</span><span ${fishStage ? 'aria-current="step"' : ""}>03 · ${h(strings.fish)}</span></nav>
      <section class="editorial-safety"><strong>✓ ${h(fishStage ? strings.approvalSafety : strings.safety)}</strong><p>${h(fishStage ? strings.approvalCopy : strings.safetyCopy)}</p></section>
      ${!fishStage ? `
      <div class="narration-layout"><section class="version-card original source-card"><header class="version-header"><span class="eyebrow">${h(strings.source)}</span><h3>${h(strings.original)}</h3></header><ol class="source-paragraphs" lang="${h(episode.language)}">${paragraphButtons || `<li>${h(strings.sourceEmpty)}</li>`}</ol></section>
      <section class="suggestion-card"><header class="version-header"><span class="eyebrow">02 · ${h(strings.suggestion)}</span><h3>${h(strings.narration)}</h3></header>
       <div class="suggestion-controls"><fieldset><legend>${h(strings.scopeLabel)}</legend><label class="scope-option"><input type="radio" name="suggestion-scope" value="article" checked> <span><strong>${h(strings.article)}</strong><small>${h(strings.articleDetail)}</small></span></label><label class="scope-option"><input type="radio" name="suggestion-scope" value="paragraph"> <span><strong>${h(strings.paragraph)}</strong><small>${h(strings.paragraphDetail)}</small></span></label></fieldset>
       <button class="button primary" data-action="request-suggestion" ${episode.original_article.trim() ? "" : "disabled"}>✦ ${h(strings.request)}</button><div id="suggestion-status" aria-live="polite"></div><div id="suggestion-review"></div></div>
      </section></div>
      <section class="version-card narration draft-editor"><header class="version-header"><span class="eyebrow">02 · ${h(strings.manual)}</span><h3>${h(strings.narration)}</h3></header><div class="version-body"><label class="sr-only" for="narration-script">${h(strings.narration)} · ${h(strings.manual)}</label><textarea lang="${h(episode.language)}" id="narration-script" maxlength="100000" aria-label="${english ? "Editable narration draft" : "Roteiro de narração editável"}" placeholder="${h(strings.manual)}…">${h(scriptReview.narrationDraft)}</textarea></div><footer class="version-footer">${h(strings.safetyCopy)}</footer></section>
      <section class="fish-next-step"><span class="eyebrow">03 · ${h(strings.fish)}</span><h2>${h(strings.fishTitle)}</h2><p>${h(strings.nextCopy)}</p><button class="button" data-action="review-stage" data-stage="fish" ${scriptReview.saving ? "disabled" : ""}>${h(strings.next)}</button></section>
      ` : `
      <section class="version-summary" aria-label="${h(strings.summary)}"><div><strong>01 · ${h(strings.original)}</strong><p>${h(strings.preserved)}</p></div><div><strong>02 · ${h(strings.narration)}</strong><p>${h(scriptReview.narrationDraft !== episode.narration_script ? strings.unsaved : episode.narration_script ? strings.saved : strings.empty)}</p></div><div><strong>03 · ${h(strings.fish)}</strong><p>${h(scriptReview.fishDraft !== episode.fish_audio_script ? strings.unsaved : episode.fish_audio_script ? strings.savedVersion : strings.empty)}</p></div></section>
      <div class="fish-review-layout"><section class="fish-review"><header><span class="eyebrow">03 · ${h(strings.manual)}</span><h2>${h(strings.fish)}</h2></header><label for="script-voice">${h(strings.voiceReference)}</label><select id="script-voice"><option value="">${english ? "No voice selected" : "Sem voz selecionada"}</option>${voices.filter((voice) => voice.language === episode.language).map((voice) => `<option value="${h(voice.id)}" ${scriptReview.voiceId === voice.id ? "selected" : ""}>${h(voice.display_name)} · ${langShort(voice.language)}</option>`).join("")}</select><label for="fish-script">${h(strings.fish)}</label><textarea lang="${h(episode.language)}" id="fish-script" maxlength="100000" aria-label="${english ? "Editable Fish Audio script" : "Script Fish Audio editável"}" placeholder="${h(strings.fish)}…">${h(scriptReview.fishDraft)}</textarea><div class="fish-approval-state" id="fish-approval-state" aria-live="polite"></div><p class="muted">${selectedVoice ? `${h(strings.voiceReference)} · ${h(selectedVoice.display_name)} · ${h(selectedVoice.fish_audio_id)}` : h(strings.noVoice)}</p><p class="muted">${h(strings.approvalCopy)}</p><button class="button primary" data-action="open-approval">${h(strings.approve)}</button><a class="button secondary" href="#generation/${encodeURIComponent(episode.id)}">${h(english ? "Prepare audio handoff →" : "Preparar handoff de áudio →")}</a></section>
      <aside class="approval-comparison"><h2>${h(strings.comparison)}</h2><section class="version-card original"><header class="version-header"><h3>${h(strings.original)} · ${h(strings.readOnly)}</h3></header><div class="version-body"><textarea aria-label="${english ? "Original article for comparison" : "Artigo original para comparação"}" readonly>${h(episode.original_article)}</textarea></div></section><section class="version-card narration"><header class="version-header"><h3>${h(strings.savedNarration)} · ${h(strings.readOnly)}</h3></header><div class="version-body"><textarea aria-label="${h(strings.savedNarration)}" readonly>${h(episode.narration_script)}</textarea></div></section></aside></div>
      <dialog id="approval-dialog" class="approval-dialog" aria-labelledby="approval-title"><form method="dialog"><p class="eyebrow">${english ? "EXPLICIT APPROVAL · NO AUTOMATION" : "APROVAÇÃO EXPLÍCITA · SEM AUTOMAÇÃO"}</p><h2 id="approval-title">${h(strings.approve)}?</h2><p>${h(episode.title)}</p><p>${h(strings.confirmation)}</p><p>${h(strings.savedVersion)} · ${h(strings.saved)}</p><div class="dialog-actions"><button class="button secondary" value="cancel">${h(strings.cancel)}</button><button class="button primary" value="confirm" data-action="confirm-approval">${h(strings.confirm)}</button></div></form></dialog>
      <button class="button secondary" data-action="review-stage" data-stage="narration" ${scriptReview.saving ? "disabled" : ""}>${h(strings.back)}</button>
      `}
      <div class="save-row"><a class="button secondary" href="#episode/${encodeURIComponent(episode.id)}">← ${h(english ? "Back to article" : "Voltar ao artigo")}</a><button class="button" data-action="save-scripts" ${scriptReview.saving ? "disabled" : ""}>${h(english ? "Save scripts" : "Salvar roteiros")}</button><span id="scripts-save-state" class="save-state" aria-live="polite"></span></div>`;
    renderSuggestionReview();
    renderFishApprovalState();
    renderSuggestionStatus();
    if (focusHeading) {
      const title = view.querySelector("h1");
      title.tabIndex = -1;
      title.focus();
    }
  }

  function renderSuggestionReview() {
    const panel = document.getElementById("suggestion-review");
    if (!panel || !scriptReview) return;
    const { strings, selectedSuggestion, suggestions } = scriptReview;
    if (!selectedSuggestion) {
      panel.innerHTML = `<p class="suggestion-empty">${h(strings.noSuggestion)}</p>`;
      return;
    }
    const history = suggestions.length > 1 ? `<label class="sr-only" for="suggestion-history">${h(strings.history)}</label><select id="suggestion-history">${suggestions.map((item, index) => `<option value="${h(item.id)}" ${item.id === selectedSuggestion.id ? "selected" : ""}>${h(item.scope === "article" ? strings.article : `${strings.paragraph} ${(item.paragraph_index || 0) + 1}`)} · ${h(item.created_at)}</option>`).join("")}</select>` : "";
    panel.innerHTML = `${history}<div class="suggestion-compare"><article><span>${h(strings.original)} · ${h(strings.readOnly)}</span><p>${h(selectedSuggestion.source_text)}</p></article><div><label for="suggestion-text">${h(strings.suggestion)}</label><textarea id="suggestion-text" maxlength="100000">${h(scriptReview.suggestionEdits[selectedSuggestion.id] ?? selectedSuggestion.suggested_text)}</textarea></div></div><p class="muted">${h(strings.review)} · ${h(strings.pending)}</p><div class="suggestion-actions"><button class="button secondary" data-action="keep-suggestion">${h(strings.keep)}</button><button class="button" data-action="use-suggestion">${h(strings.use)}</button></div>`;
  }

  function renderFishApprovalState() {
    const box = document.getElementById("fish-approval-state");
    if (!box || !scriptReview) return;
    const field = document.getElementById("fish-script");
    const saved = scriptReview.episode.fish_audio_script;
    const changed = field.value !== saved;
    const approved = !changed && !!scriptReview.episode.fish_audio_approved_sha256;
    box.className = `fish-approval-state ${approved ? "approved" : "pending"}`;
    box.textContent = approved ? scriptReview.strings.approved : changed ? scriptReview.strings.notSaved : scriptReview.strings.pending;
    const button = document.querySelector('[data-action="open-approval"]');
    if (button) button.disabled = changed || !field.value.trim();
  }

  function renderSuggestionStatus() {
    const status = document.getElementById("suggestion-status");
    if (!status || !scriptReview) return;
    const { strings, busy, error, episode } = scriptReview;
    const button = document.querySelector('[data-action="request-suggestion"]');
    button.disabled = busy || !episode.original_article.trim();
    button.setAttribute("aria-busy", String(busy));
    button.textContent = busy ? strings.loading : `✦ ${strings.request}`;
    if (error) {
      status.setAttribute("role", "alert");
      status.innerHTML = `${h(strings.safeError)} <button type="button" class="button secondary small" data-action="retry-suggestion">${h(strings.retry)}</button>`;
    } else {
      status.removeAttribute("role");
      status.textContent = busy ? strings.loading : scriptReview.selectedSuggestion ? strings.suggestion : "";
    }
    view.querySelectorAll('input[name="suggestion-scope"]').forEach((input) => { input.checked = input.value === scriptReview.scope; });
    view.querySelectorAll(".source-paragraph").forEach((button) => {
      button.setAttribute("aria-pressed", String(scriptReview.scope === "paragraph" && Number(button.dataset.index) === scriptReview.selectedIndex));
    });
  }

  async function requestSuggestion(scope = scriptReview && scriptReview.scope, paragraphIndex = scriptReview && scriptReview.selectedIndex) {
    if (!scriptReview || scriptReview.busy) return;
    const review = scriptReview;
    captureScriptEditors();
    review.scope = scope;
    review.request = { scope, paragraphIndex };
    review.busy = true;
    review.error = false;
    renderSuggestionStatus();
    try {
      const result = await api.requestNarrationSuggestion(review.id, scope, paragraphIndex);
      if (scriptReview !== review) return;
      review.suggestions = [result.suggestion, ...review.suggestions.filter((item) => item.id !== result.suggestion.id)];
      review.selectedSuggestion = result.suggestion;
      renderSuggestionReview();
    } catch (_error) {
      if (scriptReview !== review) return;
      review.error = true;
    } finally {
      if (scriptReview === review) {
        review.busy = false;
        renderSuggestionStatus();
      }
    }
  }

  function applySuggestion() {
    if (!scriptReview || !scriptReview.selectedSuggestion) return;
    const suggestion = document.getElementById("suggestion-text").value;
    const narrationField = document.getElementById("narration-script");
    if (scriptReview.selectedSuggestion.scope === "article") {
      narrationField.value = suggestion;
    } else {
      const index = scriptReview.selectedSuggestion.paragraph_index;
      const originalParts = scriptReview.originalParts;
      const parts = narrationField.value ? narrationField.value.split(/\r?\n[ \t]*\r?\n/) : originalParts.slice();
      while (parts.length <= index) parts.push(originalParts[parts.length] || "");
      parts[index] = suggestion;
      narrationField.value = parts.join("\n\n");
    }
    narrationField.dispatchEvent(new Event("input", { bubbles: true }));
    showNotice(scriptReview.language === "en" ? "Suggestion copied into the separate narration draft. Save when ready." : "Sugestão copiada para o rascunho de narração separado. Salve quando estiver pronto.");
  }

  async function approveFishScript() {
    if (!scriptReview) return;
    const review = scriptReview;
    const field = document.getElementById("fish-script");
    if (field.value !== review.episode.fish_audio_script || !field.value.trim()) {
      renderFishApprovalState();
      return;
    }
    const dialog = document.getElementById("approval-dialog");
    const confirmButton = dialog.querySelector('[data-action="confirm-approval"]');
    confirmButton.disabled = true;
    try {
      const updated = await api.approveFishScript(review.id, field.value, true);
      if (scriptReview !== review) return;
      review.episode = updated;
      dialog.close();
      renderFishApprovalState();
      showNotice(review.strings.approvedToast);
    } catch (_error) {
      dialog.close();
      showNotice(review.language === "en" ? "Could not approve this script. Reload and verify the saved version." : "Não foi possível aprovar este script. Recarregue e confira a versão salva.", "error");
    } finally { confirmButton.disabled = false; }
  }

  async function renderGeneration(id, requestId) {
    setNav("episodes", "Episódios / Gerar e revisar áudio");
    const [episode, handoffResult, fileResult, voiceResult] = await Promise.all([
      api.episode(id), api.generationHandoffs(id), api.episodeFiles(id), api.voices(),
    ]);
    if (requestId !== pageRequest) return;
    generationLanguage = generationLanguage || interfaceLanguage || episode.language;
    const english = generationLanguage === "en";
    setShellLanguage(generationLanguage);
    document.documentElement.lang = english ? "en" : "pt-BR";
    document.getElementById("breadcrumb").textContent = english ? "Studio / Episodes / Generate and review audio" : "Estúdio / Episódios / Gerar e revisar áudio";
    currentVoices = voiceResult.voices || [];
    const voice = currentVoices.find((item) => item.id === episode.selected_voice_id);
    const matchingVoices = currentVoices.filter((item) => item.language === episode.language);
    const approved = !!episode.fish_audio_approved_sha256 && !!episode.fish_audio_script.trim();
    const handoffs = handoffResult.handoffs || [];
    const files = fileResult.files || [];
    const labels = english ? {
      title: "Generate and review audio", intro: "Codex agent · Fish Audio MCP · local audio import.", locale: "Interface language", handoffStep: "Fish Audio generation",
      safety: "Audio is generated only after you confirm the quoted cost.", safetyCopy: "The app launches Codex with the authenticated Fish Audio MCP and saves each result as a new local version.",
      script: "Exact approved Fish Audio script", voice: "Registered voice", saveVoice: "Save voice selection", model: "Model preference",
      notReady: "Approve the saved Fish Audio script and select an available registered voice before preparing a handoff.",
      prepare: "Prepare generation →", confirm: "Prepare a generation request for this exact approved script and selected voice?",
      handoffs: "Handoff status", history: "Audio versions", empty: "No local audio versions yet.", duration: "Duration", durationPending: "Loading duration…", durationUnknown: "Duration unavailable",
      approved: "Approved · preserved", rejected: "Rejected · retained", pendingReview: "Awaiting review", version: "Version", generated: "Imported", file: "File", download: "Download audio", playUnsupported: "Audio playback is not supported by this browser.",
      import: "Import a file manually", choose: "Choose audio file", importButton: "Import as a new version",
      manual: "Generation runs through the configured fish-audio MCP server in Codex. The quoted cost may change before Fish Audio processes the request.",
      failure: "Generation failed", recordFailure: "Record failure", pending: "Ready to request a free quote", imported: "Audio generated and saved locally · awaiting review", failed: "Generation failed", noMcp: "Codex uses the authenticated Fish Audio MCP connection.",
      review: "Review audio version", approve: "Approve this audio version?", reject: "Reject this audio version? The local file will remain preserved.", confirmReview: "Confirm review", cancelReview: "Keep listening", preserve: "Other versions remain unchanged. This does not publish or upload the episode.",
      voiceNone: "No voice selected", voiceUnavailable: "Selected voice is not marked available", scriptApproval: "Script approval", uploadInfo: "Generated from the approved script and selected Fish Audio voice.", confirmHandoff: "Prepare generation request?", cancelHandoff: "Back to review", yesHandoff: "Yes, prepare request", handoffConfirmCopy: "The app will ask Fish Audio for a free quote first. No audio is generated until you confirm the quoted cost.", generationHelp: "A Codex agent will request a quote; generation requires a separate confirmation.",
    } : {
      title: "Gerar e revisar áudio", intro: "Agente Codex · MCP do Fish Audio · importação local.", locale: "Idioma da interface", handoffStep: "Geração Fish Audio",
      safety: "O áudio só é gerado após sua confirmação do custo cotado.", safetyCopy: "O app inicia o Codex com o MCP autenticado do Fish Audio e salva cada resultado como uma nova versão local.",
      script: "Script Fish Audio exato aprovado", voice: "Voz registrada", saveVoice: "Salvar seleção de voz", model: "Preferência de modelo",
      notReady: "Aprove o script Fish Audio salvo e selecione uma voz registrada disponível antes de preparar o handoff.",
      prepare: "Preparar geração →", confirm: "Preparar uma solicitação para este script aprovado e esta voz?",
      handoffs: "Status dos handoffs", history: "Versões de áudio", empty: "Ainda não há versões de áudio locais.", duration: "Duração", durationPending: "Carregando duração…", durationUnknown: "Duração indisponível",
      approved: "Aprovada · preservada", rejected: "Rejeitada · mantida", pendingReview: "Aguardando revisão", version: "Versão", generated: "Importada", file: "Arquivo", download: "Baixar áudio", playUnsupported: "Este navegador não oferece suporte à reprodução de áudio.",
      import: "Importar arquivo manualmente", choose: "Escolher arquivo de áudio", importButton: "Importar como nova versão",
      manual: "A geração usa o servidor fish-audio configurado no Codex. O custo cotado pode mudar antes do processamento pelo Fish Audio.",
      failure: "Falha na geração", recordFailure: "Registrar falha", pending: "Pronto para solicitar uma cotação gratuita", imported: "Áudio gerado e salvo localmente · aguardando revisão", failed: "Falha na geração", noMcp: "O Codex usa a conexão autenticada do MCP do Fish Audio.",
      review: "Revisar versão de áudio", approve: "Aprovar esta versão de áudio?", reject: "Rejeitar esta versão de áudio? O arquivo local será preservado.", confirmReview: "Confirmar revisão", cancelReview: "Continuar ouvindo", preserve: "As outras versões permanecem inalteradas. Isto não publica nem envia o episódio.",
      voiceNone: "Nenhuma voz selecionada", voiceUnavailable: "A voz selecionada não está marcada como disponível", scriptApproval: "Aprovação do script", uploadInfo: "Gerado com o script aprovado e a voz selecionada no Fish Audio.", confirmHandoff: "Preparar solicitação de geração?", cancelHandoff: "Voltar à revisão", yesHandoff: "Sim, preparar solicitação", handoffConfirmCopy: "O app solicitará primeiro uma cotação gratuita ao Fish Audio. O áudio só será gerado após você confirmar o custo.", generationHelp: "Um agente Codex solicitará a cotação; a geração exige confirmação separada.",
    };
    const statusText = (status) => status === "prepared" ? labels.pending : status === "imported" ? labels.imported : labels.failed;
    const voiceOptions = matchingVoices.map((item) => `<option value="${h(item.id)}" ${item.id === episode.selected_voice_id ? "selected" : ""}>${h(item.display_name)} · ${langShort(item.language)} · ${h(item.availability)}</option>`).join("");
    const handoffRows = handoffs.length ? handoffs.map((item) => {
      const run = item.generation_run;
      const runStatus = run && run.status;
      const runText = runStatus === "quoting" ? (english ? "Getting Fish Audio quote…" : "Obtendo cotação do Fish Audio…")
        : runStatus === "quoted" ? (english ? "Quote ready" : "Cotação pronta")
          : runStatus === "generating" ? (english ? "Generating audio with Fish Audio…" : "Gerando áudio no Fish Audio…")
            : runStatus === "imported" ? labels.imported
              : runStatus === "failed" ? `${labels.failed}: ${run.error_message || run.failure_code || ""}`
                : item.status === "imported" ? labels.imported : item.status === "failed" ? labels.failed : labels.pending;
      const quote = runStatus === "quoted" ? `<p><strong>${english ? "Estimated cost" : "Custo estimado"}: ${h(Number(run.estimated_credits).toLocaleString(english ? "en-US" : "pt-BR"))} ${english ? "credits" : "créditos"}</strong></p><p>${h(run.quote_summary)}</p><button class="button primary small" data-action="generate-audio" data-id="${h(item.id)}" data-credits="${h(run.estimated_credits)}">${english ? "Generate audio" : "Gerar áudio"}</button>` : "";
      const action = !run && item.status === "prepared"
        ? `<button class="button secondary small" data-action="quote-generation" data-id="${h(item.id)}">${english ? "Get free quote" : "Solicitar cotação grátis"}</button>`
        : runStatus === "quoting" || runStatus === "generating"
          ? `<p role="status">${h(runText)}</p>` : quote;
      return `<article class="generation-handoff"><strong>${h(runText)}</strong><span>${h(item.voice_name)} · Drama 3 / ${h(item.model)} · ${h(dateLabel(item.created_at, english ? "en-US" : "pt-BR"))}</span>${run && run.failure_code ? `<small>${h(run.failure_code)}</small>` : ""}${run && run.error_message ? `<p class="generation-error" role="alert">${h(run.error_message)}</p>` : ""}${action}<div class="generation-error" data-handoff-error="${h(item.id)}" role="alert"></div></article>`;
    }).join("") : `<p>${h(labels.empty)}</p>`;
    const reviewStatus = (status) => status === "approved" ? labels.approved : status === "rejected" ? labels.rejected : labels.pendingReview;
    const history = files.length ? files.map((item, index) => `<article class="audio-version" data-audio-version="${h(item.id)}"><div class="audio-version-heading"><strong>${h(labels.version)} ${files.length - index} · ${h(reviewStatus(item.approval_status))}</strong>${item.approval_status === "approved" ? `<span class="approved-lock">🔒 ${h(labels.approved)}</span>` : ""}</div><p>${h(item.voice_name || item.fish_audio_id || (english ? "Local audio import" : "Importação local de áudio"))} ${item.model ? `· Drama 3 / ${h(item.model)}` : ""}</p><p>${h(labels.generated)} · <time datetime="${h(item.created_at)}">${h(dateLabel(item.created_at, english ? "en-US" : "pt-BR")) || "—"}</time></p><p>${h(labels.file)} · ${h(item.filename)} · ${Number(item.size_bytes).toLocaleString(english ? "en-US" : "pt-BR")} bytes</p>${item.script_sha256 ? `<code>SHA-256 · ${h(item.script_sha256)}</code>` : ""}<audio controls preload="metadata" data-audio-duration="${h(item.id)}" aria-label="${h(labels.version)} ${files.length - index}" src="/api/files/${encodeURIComponent(item.id)}">${h(labels.playUnsupported)}</audio><p class="audio-duration" data-duration-label="${h(item.id)}">${h(labels.duration)} · ${h(labels.durationPending)}</p><a class="audio-download" download="${h(item.filename)}" href="/api/files/${encodeURIComponent(item.id)}">↓ ${h(labels.download)}</a>${item.handoff_id && item.approval_status !== "approved" && item.approval_status !== "rejected" ? `<div class="audio-review-actions"><button class="button secondary small" data-action="review-audio" data-id="${h(item.id)}" data-status="rejected">${english ? "Reject version" : "Rejeitar versão"}</button><button class="button small" data-action="review-audio" data-id="${h(item.id)}" data-status="approved">${english ? "Approve version" : "Aprovar versão"}</button></div>` : item.approval_status === "rejected" ? `<strong class="rejected-label">${h(labels.rejected)}</strong>` : ""}${item.handoff_id ? `<p class="audio-provenance">${h(labels.uploadInfo)}</p>` : ""}</article>`).join("") : `<p>${h(labels.empty)}</p>`;
    const selectedVoiceSummary = voice ? `${h(voice.display_name)} · ${h(voice.fish_audio_id)} · ${h(voice.availability)}` : h(labels.voiceNone);
    view.innerHTML = `<div class="review-language"><label for="generation-language">${h(labels.locale)}</label><select id="generation-language" aria-label="${h(labels.locale)}"><option value="pt" ${english ? "" : "selected"}>PT-BR</option><option value="en" ${english ? "selected" : ""}>EN</option></select></div>${heading(labels.title, `${episode.title} · ${labels.intro}`)}
      <section class="editorial-safety"><strong>✓ ${h(labels.safety)}</strong><p>${h(labels.safetyCopy)} ${h(labels.noMcp)}</p></section>
      <nav class="script-steps generation-steps" aria-label="${english ? "Audio workflow" : "Fluxo de áudio"}"><span>01 · ${h(labels.script)} ${approved ? "✓" : "○"}</span><span>02 · ${h(labels.voice)} ${voice && voice.availability === "available" ? "✓" : "○"}</span><span aria-current="step">03 · ${h(labels.handoffStep)}</span><span>04 · ${h(labels.history)}</span></nav>
      <div class="generation-columns"><section class="panel generation-setup"><span class="eyebrow">${h(labels.script)}</span><textarea readonly aria-label="${h(labels.script)}">${h(episode.fish_audio_script)}</textarea>
       <p class="generation-script-state">${approved ? `✓ ${h(labels.scriptApproval)} · ${h(dateLabel(episode.fish_audio_approved_at, english ? "en-US" : "pt-BR"))}` : h(labels.notReady)}</p>${episode.fish_audio_approved_sha256 ? `<code class="script-digest">SHA-256 · ${h(episode.fish_audio_approved_sha256)}</code>` : ""}<a class="text-link" href="#scripts/${encodeURIComponent(episode.id)}">${english ? "Review approved script" : "Revisar script aprovado"} →</a>
       <h3>${h(labels.voice)}</h3><label class="sr-only" for="generation-voice">${h(labels.voice)}</label><div class="voice-selection"><select id="generation-voice" ${matchingVoices.length ? "" : "disabled"}><option value="">${h(labels.voiceNone)}</option>${voiceOptions}</select><button class="button secondary small" data-action="save-generation-voice" ${matchingVoices.length && episode.selected_voice_id ? "" : "disabled"}>${h(labels.saveVoice)}</button></div><p id="generation-voice-summary">${selectedVoiceSummary} ${voice && voice.availability !== "available" ? `· ${h(labels.voiceUnavailable)}` : ""}</p>
       <h3>${h(labels.model)}</h3><p><strong>Fish Audio Drama 3 · drama-3</strong></p><p class="model-caveat">${h(labels.manual)}</p>
       <button class="button primary" data-action="prepare-handoff" data-script-ready="${approved}" data-episode-language="${h(episode.language)}" ${approved && voice && voice.availability === "available" && voice.language === episode.language ? "" : "disabled"}>${h(labels.prepare)}</button><p class="field-help">${h(labels.generationHelp)}</p><div class="generation-error" id="generation-error" role="alert" aria-live="assertive"></div>
      </section><section class="panel handoff-panel"><h2>${h(labels.handoffs)}</h2>${handoffRows}</section></div>
      <section class="panel generation-history"><h2>${h(labels.history)}</h2><p class="muted">${english ? "Every import receives a new directory. Existing and approved audio files are never replaced." : "Cada importação recebe uma nova pasta. Áudios existentes e aprovados nunca são substituídos."}</p>${history}</section>
      <div class="heading-actions"><a class="button secondary" href="#scripts/${encodeURIComponent(episode.id)}">${english ? "Back to script review" : "Voltar à revisão do script"}</a><a class="button" href="#transistor/${encodeURIComponent(episode.id)}">${english ? "Transistor publishing →" : "Publicação no Transistor →"}</a></div>
      <dialog id="handoff-confirm-dialog" class="approval-dialog" aria-labelledby="handoff-confirm-title"><form method="dialog"><p class="eyebrow">${english ? "PREPARE REQUEST · NO AUDIO YET" : "PREPARAR SOLICITAÇÃO · SEM ÁUDIO AINDA"}</p><h2 id="handoff-confirm-title">${h(labels.confirmHandoff)}</h2><p>${h(episode.title)} · ${h(voice ? voice.display_name : labels.voiceNone)} · Fish Audio Drama 3 / drama-3</p><p>${h(labels.confirm)}</p><p>${h(labels.handoffConfirmCopy)}</p><div class="dialog-actions"><button class="button secondary" value="cancel">${h(labels.cancelHandoff)}</button><button class="button primary" value="confirm" data-action="confirm-handoff">${h(labels.yesHandoff)}</button></div></form></dialog>
      <dialog id="generation-confirm-dialog" class="approval-dialog" aria-labelledby="generation-confirm-title"><form method="dialog"><p class="eyebrow">${english ? "PAID FISH AUDIO GENERATION" : "GERAÇÃO PAGA NO FISH AUDIO"}</p><h2 id="generation-confirm-title">${english ? "Generate this audio?" : "Gerar este áudio?"}</h2><p id="generation-confirm-cost"></p><p>${h(labels.manual)}</p><div class="dialog-actions"><button class="button secondary" value="cancel">${h(labels.cancelHandoff)}</button><button class="button primary" value="confirm" data-action="confirm-audio-generation">${english ? "Confirm and generate" : "Confirmar e gerar"}</button></div></form></dialog>
      <dialog id="audio-review-dialog" class="approval-dialog" aria-labelledby="audio-review-title"><form method="dialog"><p class="eyebrow">${english ? "EXPLICIT AUDIO REVIEW · NO PUBLISHING" : "REVISÃO EXPLÍCITA · SEM PUBLICAÇÃO"}</p><h2 id="audio-review-title">${h(labels.review)}</h2><p id="audio-review-prompt"></p><p>${h(labels.preserve)}</p><div class="dialog-actions"><button class="button secondary" value="cancel" data-action="cancel-audio-review">${h(labels.cancelReview)}</button><button class="button primary" value="confirm" data-action="confirm-audio-review">${h(labels.confirmReview)}</button></div></form></dialog>`;
    view.querySelectorAll("audio[data-audio-duration]").forEach((player) => {
      const output = Array.from(view.querySelectorAll("[data-duration-label]")).find((item) => item.dataset.durationLabel === player.dataset.audioDuration);
      if (!output) return;
      player.addEventListener("loadedmetadata", () => {
        output.textContent = `${labels.duration} · ${Number.isFinite(player.duration) ? formatAudioDuration(player.duration) : labels.durationUnknown}`;
      }, { once: true });
      player.addEventListener("error", () => { output.textContent = `${labels.duration} · ${labels.durationUnknown}`; }, { once: true });
      if (Number.isFinite(player.duration) && player.duration > 0) output.textContent = `${labels.duration} · ${formatAudioDuration(player.duration)}`;
    });
    if (handoffs.some((item) => item.generation_run && ["quoting", "generating"].includes(item.generation_run.status))) {
      window.setTimeout(() => {
        if (window.location.hash === `#generation/${encodeURIComponent(id)}`) loadRoute();
      }, 2000);
    }
  }

  async function renderTransistor(id, requestId) {
    const english = interfaceLanguage ? interfaceLanguage === "en" : document.documentElement.lang === "en";
    interfaceLanguage = english ? "en" : "pt";
    document.documentElement.lang = english ? "en" : "pt-BR";
    setShellLanguage(interfaceLanguage);
    setNav("episodes", english ? "Episodes / Publication" : "Episódios / Publicação");
    const [episode, filesResult, publicationResult] = await Promise.all([
      api.episode(id), api.episodeFiles(id), api.transistorPublication(id),
    ]);
    if (requestId !== pageRequest) return;
    let shows = [];
    let configurationError = "";
    try { shows = (await api.transistorShows()).shows || []; }
    catch (error) { configurationError = error.message; }
    if (requestId !== pageRequest) return;
    const publication = publicationResult.publication;
    const approvedFiles = (filesResult.files || []).filter((file) => file.approval_status === "approved");
    const labels = english ? {
      title: "Your draft is ready. Publishing is not.", eyebrow: "PHASE 5 · TRANSISTOR · CONFIRM EACH EXTERNAL ACTION", safety: "No upload or publishing happens automatically.", safetyCopy: "Uploading sends a copy of the approved audio and metadata to Transistor. It only creates a draft. Publishing or scheduling requires a separate confirmation.",
      steps: ["Podcast details", "Metadata and audio", "Upload and draft", "Publish or schedule"], show: "Podcast retrieved from Transistor", chooseShow: "Select a podcast", showHelp: "Choose the destination returned by your Transistor account.",
      metadata: "Review episode metadata", titleLabel: "EPISODE TITLE", description: "DESCRIPTION", save: "Save metadata locally", saved: "Metadata saved locally.", audio: "APPROVED LOCAL RECORDING", audioLabel: "Approved audio", audioNote: "Local preview only. Nothing is transferred by playing this file.", noAudio: "No locally approved audio is available. Approve an audio version first.", selectAudio: "Select approved recording", summary: "Short summary", keywords: "Keywords (comma-separated)",
      uploadHeading: "Before uploading audio", uploadCopy: "The approved file will be transferred to Transistor. This does not publish or schedule the episode.", uploadButton: "Review upload confirmation", confirmUpload: "I confirm sending this approved audio and metadata to Transistor. I understand this transfers a copy to an external service.", uploadYes: "Yes, upload audio", cancel: "Cancel · keep local", draftOnly: "This action uploads the file and creates a draft only.", uploading: "Uploading approved audio and creating a draft…", retryUpload: "Retry audio transfer", retryCopy: "The previous audio transfer failed before draft creation. The same approved file and podcast are locked for a safe retry.", refreshing: "Checking Transistor status…", publishing: "Sending the confirmed publication request…",
      status: "Transistor episode status", refresh: "Refresh status", noStatus: "Not sent to Transistor", details: "Remote episode", statusDraft: "Draft · not published", statusScheduled: "Scheduled · not yet published", statusPublished: "Published on Transistor", statusUploading: "Upload or request in progress", statusUploadFailed: "Upload failed before draft creation. The same file and show may be retried.", statusCreationUncertain: "Draft creation could not be confirmed. Inspect Transistor manually; retry is disabled to prevent duplicates.", statusPublishUncertain: "The publication request may have been accepted. Refresh status before taking another action.", created: "Draft saved. It has not been published.",
      nextTitle: "The draft will not publish automatically", nextCopy: "After refreshing and confirming the remote draft status, choose publish now or schedule. This is a separate external action.", publishNow: "Publish now", schedule: "Schedule for later", date: "DATE & TIME · PODCAST TIME ZONE", zone: "Podcast time zone", zoneHint: "Confirm the local time displayed for the selected podcast. Scheduled does not mean published.", zoneMissing: "Scheduling is unavailable because Transistor did not return a supported podcast time zone. Publish now remains available.", publishConfirm: "I confirm this separate change to the Transistor episode status.", publishYes: "Confirm publication", scheduleYes: "Confirm schedule", publishAction: "Review publication confirmation", scheduleAction: "Review schedule confirmation", readFirst: "Refresh status and confirm the draft before publishing or scheduling.",
      errorTitle: "Transistor could not complete that request.", safeError: "The saved local/remote state has not been assumed to change. Check status before trying again; no automatic retry is running.", configError: "Transistor could not be reached or is not configured. Configure TRANSISTOR_API_KEY in the local server environment; it is never sent to the browser.", noShows: "No podcast shows were returned for this account.", history: "Operation status", distribution: "A successful Transistor status does not mean podcast directories or RSS have updated immediately.", back: "Back to audio review", language: "Interface language",
    } : {
      title: "Seu rascunho está pronto. Publicar é outra etapa.", eyebrow: "FASE 5 · TRANSISTOR · CADA AÇÃO TEM SUA CONFIRMAÇÃO", safety: "Nenhum upload ou publicação acontece automaticamente.", safetyCopy: "O upload envia uma cópia do áudio aprovado e dos metadados ao Transistor. Ele cria somente um rascunho. Publicar ou agendar exige outra confirmação.",
      steps: ["Podcast", "Metadados e áudio", "Upload e rascunho", "Publicar ou agendar"], show: "Podcast recuperado do Transistor", chooseShow: "Selecione um podcast", showHelp: "Escolha o destino retornado pela sua conta Transistor.",
      metadata: "Revise os metadados do episódio", titleLabel: "TÍTULO DO EPISÓDIO", description: "DESCRIÇÃO", save: "Salvar metadados localmente", saved: "Metadados salvos localmente.", audio: "GRAVAÇÃO LOCAL APROVADA", audioLabel: "Áudio aprovado", audioNote: "Prévia local apenas. Reproduzir o arquivo não o transfere.", noAudio: "Não há áudio local aprovado. Aprove uma versão primeiro.", selectAudio: "Selecione a gravação aprovada", summary: "Resumo curto", keywords: "Palavras-chave (separadas por vírgula)",
      uploadHeading: "Antes de enviar o áudio", uploadCopy: "O arquivo aprovado será transferido ao Transistor. Isso não publica nem agenda o episódio.", uploadButton: "Revisar confirmação de envio", confirmUpload: "Confirmo o envio deste áudio aprovado e dos metadados ao Transistor. Entendo que uma cópia será transferida para um serviço externo.", uploadYes: "Sim, enviar áudio", cancel: "Cancelar · manter local", draftOnly: "Esta ação envia o arquivo e cria somente um rascunho.", uploading: "Enviando o áudio aprovado e criando rascunho…", retryUpload: "Tentar novamente o envio", retryCopy: "A transferência anterior falhou antes da criação do rascunho. O mesmo áudio aprovado e podcast estão bloqueados para uma repetição segura.", refreshing: "Consultando o status no Transistor…", publishing: "Enviando a solicitação de publicação confirmada…",
      status: "Status do episódio no Transistor", refresh: "Atualizar status", noStatus: "Ainda não enviado ao Transistor", details: "Episódio remoto", statusDraft: "Rascunho · não publicado", statusScheduled: "Agendado · ainda não publicado", statusPublished: "Publicado no Transistor", statusUploading: "Upload ou solicitação em andamento", statusUploadFailed: "Falha antes da criação do rascunho. É possível tentar novamente com o mesmo arquivo e podcast.", statusCreationUncertain: "Não foi possível confirmar a criação do rascunho. Inspecione o Transistor manualmente; a repetição está desativada para evitar duplicatas.", statusPublishUncertain: "A solicitação pode ter sido aceita. Atualize o status antes de outra ação.", created: "Rascunho salvo. Ainda não foi publicado.",
      nextTitle: "O rascunho não será publicado automaticamente", nextCopy: "Depois de atualizar e confirmar o status remoto do rascunho, escolha publicar ou agendar. É uma ação externa separada.", publishNow: "Publicar agora", schedule: "Agendar para depois", date: "DATA E HORA · FUSO DO PODCAST", zone: "Fuso do podcast", zoneHint: "Confirme o horário local exibido para o podcast selecionado. Agendado não significa publicado.", zoneMissing: "O agendamento não está disponível porque o Transistor não retornou um fuso reconhecido. Publicar agora continua disponível.", publishConfirm: "Confirmo esta alteração separada do status do episódio no Transistor.", publishYes: "Confirmar publicação", scheduleYes: "Confirmar agendamento", publishAction: "Revisar confirmação de publicação", scheduleAction: "Revisar confirmação de agendamento", readFirst: "Atualize o status e confirme o rascunho antes de publicar ou agendar.",
      errorTitle: "O Transistor não concluiu esta solicitação.", safeError: "Não presuma que o estado local/remoto mudou. Confira o status antes de tentar novamente; não há repetição automática.", configError: "O Transistor não respondeu ou não está configurado. Configure TRANSISTOR_API_KEY no ambiente local do servidor; ela nunca é enviada ao navegador.", noShows: "Nenhum podcast foi retornado para esta conta.", history: "Status da operação", distribution: "Um status de sucesso no Transistor não significa que diretórios de podcast ou RSS já foram atualizados.", back: "Voltar à revisão de áudio", language: "Idioma da interface",
    };
    const statusText = !publication ? labels.noStatus : ({ draft: labels.statusDraft, scheduled: labels.statusScheduled, published: labels.statusPublished, uploading: labels.statusUploading, publishing: labels.statusUploading, upload_failed: labels.statusUploadFailed, creation_uncertain: labels.statusCreationUncertain, publish_uncertain: labels.statusPublishUncertain }[publication.status] || labels.statusUploading);
    const retryingUpload = publication?.status === "upload_failed";
    const selectableShows = retryingUpload ? shows.filter((show) => show.id === publication.show_id) : shows;
    const selectedShow = selectableShows[0];
    const showOptions = selectableShows.map((show) => `<option value="${h(show.id)}">${h(show.title || show.id)}</option>`).join("");
    const missingRetryShow = english ? "The podcast from the previous attempt is unavailable. Upload retry is disabled." : "O podcast da tentativa anterior não está disponível. Não é possível repetir o envio.";
    const activePublication = !!publication && !retryingUpload;
    const canSchedule = !!publication?.show_time_zone_supported;
    const confirmedDraft = !!activePublication && publication.status === "draft" && confirmedTransistorDrafts.has(id);
    const formDisabled = activePublication || !selectedShow || !approvedFiles.length || !!configurationError;
    const metadataLocked = activePublication;
    const selectedFile = approvedFiles.find((file) => file.id === publication?.file_id) || approvedFiles[0];
    const fileOptions = approvedFiles.map((file) => `<option value="${h(file.id)}" ${file.id === selectedFile?.id ? "selected" : ""} data-filename="${h(file.filename)}" data-size="${(Number(file.size_bytes) / (1024 * 1024)).toFixed(1)} MB">${h(file.filename)} · ${(Number(file.size_bytes) / (1024 * 1024)).toFixed(1)} MB · ${h(dateLabel(file.created_at, english ? "en-US" : "pt-BR"))}</option>`).join("");
    const showPanel = activePublication ? `<section class="transistor-show panel"><span class="eyebrow">${h(labels.show)}</span><h2>${h(publication.show_title || publication.show_id)}</h2><p>${h(labels.zone)} · ${h(publication.show_time_zone || (english ? "Unavailable" : "Indisponível"))}</p><span class="read-badge">✓ ${english ? "Details read" : "Informações lidas"}</span></section>` : `<section class="transistor-show panel"><label for="transistor-show">${h(labels.show)}</label><select id="transistor-show" ${formDisabled || retryingUpload ? "disabled" : ""}>${showOptions || `<option value="">${h(labels.chooseShow)}</option>`}</select><p class="field-help">${h(labels.showHelp)}</p>${configurationError ? `<p class="transistor-error" role="alert">${h(labels.configError)}</p>` : retryingUpload && !selectedShow ? `<p class="transistor-error" role="alert">${h(missingRetryShow)}</p>` : !shows.length ? `<p class="muted">${h(labels.noShows)}</p>` : ""}</section>`;
    const metadataPanel = `<section class="transistor-metadata panel"><header><span class="eyebrow">02 · ${h(labels.metadata)}</span><h2>${h(labels.metadata)}</h2></header><label for="transistor-title">${h(labels.titleLabel)}</label><input id="transistor-title" maxlength="300" value="${h(activePublication ? publication.title : episode.title)}" ${metadataLocked ? "readonly" : ""}><label for="transistor-description">${h(labels.description)}</label><textarea id="transistor-description" rows="4" maxlength="10000" ${metadataLocked ? "readonly" : ""}>${h(activePublication ? publication.description || "" : episode.description || "")}</textarea><div class="transistor-audio"><span class="eyebrow">${h(labels.audio)}</span>${approvedFiles.length ? `<label for="transistor-file">${h(labels.selectAudio)}</label><select id="transistor-file" ${formDisabled || retryingUpload ? "disabled" : ""}>${fileOptions}</select><audio controls preload="metadata" aria-label="${h(labels.audioLabel)} · ${h(selectedFile.filename)}" src="/api/files/${encodeURIComponent(selectedFile.id)}">${h(english ? "Audio playback is not supported." : "Reprodução de áudio não é suportada.")}</audio><p>${h(selectedFile.filename)} · ${h(labels.audioNote)}</p>` : `<p>${h(labels.noAudio)}</p>`}</div><div class="transistor-extra-metadata"><label for="transistor-summary">${h(labels.summary)}</label><textarea id="transistor-summary" rows="2" maxlength="10000" ${metadataLocked ? "readonly" : ""}>${h(activePublication ? publication.summary || "" : episode.description || "")}</textarea><label for="transistor-keywords">${h(labels.keywords)}</label><input id="transistor-keywords" maxlength="2000" value="${h(activePublication ? publication.keywords || "" : "")}" ${metadataLocked ? "readonly" : ""}></div>${metadataLocked ? "" : `<button class="button secondary" data-action="save-transistor-metadata">${h(labels.save)}</button><span class="save-state" id="transistor-save-state" aria-live="polite"></span>`}</section>`;
    const uploadPanel = activePublication ? "" : `<section class="transistor-upload panel"><span class="eyebrow">03 · ${h(english ? "REMOTE TRANSFER" : "TRANSFERÊNCIA REMOTA")}</span><h2>${h(labels.uploadHeading)}</h2><p>${h(retryingUpload ? labels.retryCopy : labels.uploadCopy)}</p><div class="upload-recap" id="upload-recap"><span data-recap-file>${h(selectedFile ? `${selectedFile.filename} · ${(Number(selectedFile.size_bytes) / (1024 * 1024)).toFixed(1)} MB` : labels.noAudio)}</span><span data-recap-episode>${h(episode.title)}</span><span data-recap-show>${h(selectedShow?.title || selectedShow?.id || labels.chooseShow)} · Transistor</span></div><p id="transistor-error" class="transistor-error" role="alert" aria-live="assertive"></p><button class="button primary" data-action="open-transistor-upload" ${formDisabled ? "disabled" : ""}>${h(retryingUpload ? labels.retryUpload : labels.uploadButton)}</button><p class="field-help">${h(labels.draftOnly)}</p></section>`;
    const publicationPanel = activePublication ? `<section class="transistor-next panel"><span class="eyebrow">04 · ${h(english ? "SEPARATE EXTERNAL ACTION" : "AÇÃO EXTERNA SEPARADA")}</span><h2>${h(labels.nextTitle)}</h2><p>${h(labels.nextCopy)}</p><div class="transistor-publish-options"><label><input type="radio" name="transistor-action" value="published" checked> ${h(labels.publishNow)}</label><label class="schedule-option"><input type="radio" name="transistor-action" value="scheduled" ${canSchedule ? "" : "disabled"}> ${h(labels.schedule)}</label><div class="transistor-date-field"><label for="transistor-published-at">${h(labels.date)}</label><input id="transistor-published-at" type="datetime-local" ${canSchedule && confirmedDraft ? "" : "disabled"}></div></div><p class="timezone-note">${h(publication.show_time_zone ? `${labels.zone}: ${publication.show_time_zone}. ${labels.zoneHint}` : labels.zoneMissing)}</p><div class="transistor-actions"><button class="button primary" data-action="open-transistor-publish" ${confirmedDraft ? "" : "disabled"}>${h(labels.publishAction)}</button></div><p class="field-help">${h(confirmedDraft ? "" : labels.readFirst)}</p></section>` : "";
    const currentStep = publication ? publication.status === "published" || publication.status === "scheduled" ? 3 : 2 : 1;
    view.innerHTML = `<div class="transistor-locale"><label for="transistor-language">${h(labels.language)}</label><select id="transistor-language"><option value="pt" ${english ? "" : "selected"}>PT-BR</option><option value="en" ${english ? "selected" : ""}>EN</option></select></div>${heading(labels.title, `${episode.title} · ${english ? "Approved audio" : "Áudio aprovado"} · ${langShort(episode.language)}`)}<section class="editorial-safety transistor-safety"><strong>✓ ${h(labels.safety)}</strong><p>${h(labels.safetyCopy)}</p></section><nav class="transistor-steps" aria-label="${h(english ? "Publishing workflow" : "Fluxo de publicação")}">${labels.steps.map((step, index) => `<span ${index === currentStep ? 'aria-current="step"' : ""}>0${index + 1} ${index < currentStep ? "✓" : index === currentStep ? "●" : "○"} ${h(step)}</span>`).join("")}</nav><div class="transistor-grid">${showPanel}${metadataPanel}${uploadPanel}</div><section class="transistor-status panel" aria-live="polite"><div><span class="eyebrow">${h(labels.status)} · ${publication ? h(labels.details) : h(english ? "WAITING FOR YOUR CONFIRMATION" : "AGUARDANDO SUA CONFIRMAÇÃO")}</span><h2>${h(statusText)}</h2><p>${publication ? `${h(labels.details)} · ${h(publication.remote_episode_id || "—")}${publication.published_at ? ` · ${h(publication.published_at)}` : ""}` : h(english ? "No upload, publication or scheduling is in progress. This state is local." : "Nenhum upload, publicação ou agendamento está em andamento. O estado continua local.")}</p></div><div class="transistor-status-actions"><span class="transistor-status-chip ${h(publication?.status || "local")}">${h(statusText)}</span>${publication?.remote_episode_id ? `<button class="button secondary" data-action="refresh-transistor">↻ ${h(labels.refresh)}</button>` : ""}</div></section><p id="transistor-operation-error" class="transistor-error" role="alert" aria-live="assertive"></p>${publication && publication.status === "draft" ? `<section class="transistor-draft-note editorial-safety"><strong>✓ ${h(labels.created)}</strong><p>${h(english ? "Publication remains blocked until you explicitly refresh and read back Draft from Transistor." : "A publicação permanece bloqueada até você atualizar e ler Rascunho do Transistor explicitamente.")}</p></section>` : ""}${publicationPanel}<p class="transistor-footer">${h(labels.distribution)}</p><a class="button secondary" href="#generation/${encodeURIComponent(id)}">← ${h(labels.back)}</a><dialog id="transistor-upload-dialog" class="approval-dialog" aria-labelledby="transistor-upload-title"><form method="dialog"><p class="eyebrow">${h(english ? "EXPLICIT CONFIRMATION · UPLOAD ONLY" : "CONFIRMAÇÃO EXPLÍCITA · SOMENTE UPLOAD")}</p><h2 id="transistor-upload-title">${h(labels.uploadHeading)}</h2><p>${h(retryingUpload ? labels.retryCopy : labels.uploadCopy)}</p><div class="upload-recap" id="transistor-upload-recap"><span data-recap-file>${h(selectedFile ? `${selectedFile.filename} · ${(Number(selectedFile.size_bytes) / (1024 * 1024)).toFixed(1)} MB` : "")}</span><span data-recap-episode>${h(episode.title)}</span><span data-recap-show>${h(selectedShow?.title || selectedShow?.id || labels.chooseShow)} · Transistor</span><span>${h(labels.draftOnly)}</span></div><p id="transistor-upload-progress" class="transistor-progress" role="status" aria-live="polite"></p><label class="transistor-consent"><input type="checkbox" id="transistor-upload-consent"> <span>${h(labels.confirmUpload)}</span></label><div class="dialog-actions"><button class="button secondary" value="cancel">${h(labels.cancel)}</button><button class="button primary" value="confirm" data-action="confirm-transistor-upload" disabled>${h(labels.uploadYes)}</button></div></form></dialog><dialog id="transistor-publish-dialog" class="approval-dialog" aria-labelledby="transistor-publish-title"><form method="dialog"><p class="eyebrow">${h(english ? "SEPARATE EXTERNAL ACTION" : "AÇÃO EXTERNA SEPARADA")}</p><h2 id="transistor-publish-title">${h(labels.publishAction)}</h2><p id="transistor-publish-recap">${h(publication?.title || episode.title)}</p><p id="transistor-publish-progress" class="transistor-progress" role="status" aria-live="polite"></p><label class="transistor-consent"><input type="checkbox" id="transistor-publish-consent"> <span>${h(labels.publishConfirm)}</span></label><div class="dialog-actions"><button class="button secondary" value="cancel">${h(labels.cancel)}</button><button class="button primary" value="confirm" data-action="confirm-transistor-publish" disabled>${h(labels.publishYes)}</button></div></form></dialog>`;
    const uploadDialog = document.getElementById("transistor-upload-dialog");
    const publishDialog = document.getElementById("transistor-publish-dialog");
    uploadDialog.addEventListener("close", () => {
      delete uploadDialog.dataset.showId;
      uploadDialog.querySelector("#transistor-upload-consent").checked = false;
      const confirm = uploadDialog.querySelector('[data-action="confirm-transistor-upload"]');
      if (confirm) confirm.disabled = true;
    });
    publishDialog.addEventListener("close", () => {
      document.getElementById("transistor-publish-consent").checked = false;
      const confirm = publishDialog.querySelector('[data-action="confirm-transistor-publish"]');
      if (confirm) confirm.disabled = true;
    });
    view.dataset.transistorEpisode = id;
    view.dataset.transistorLanguage = interfaceLanguage;
    view.dataset.transistorUploadConfirm = labels.confirmUpload;
    view.dataset.transistorPublishConfirm = labels.publishConfirm;
    view.dataset.transistorConfigError = configurationError ? labels.configError : "";
  }
  async function renderVoices(requestId) {
    setNav("voices", "Biblioteca de vozes");
    const result = await api.voices();
    if (requestId !== pageRequest) return;
    if (voiceSamplePreviewUrl) URL.revokeObjectURL(voiceSamplePreviewUrl);
    voiceSamplePreviewUrl = "";
    const voices = result.voices || [];
    currentVoices = voices;
    const cards = voices.map((voice) => `<article class="voice-card">
      <div class="voice-card-head">
        <span class="voice-initial" aria-hidden="true">${h((voice.display_name || "?").slice(0, 1).toLocaleUpperCase())}</span>
        <div class="voice-card-title">
          <div class="voice-card-titleline"><h3>${h(voice.display_name)}</h3><span class="tag">${langShort(voice.language)}</span></div>
          <div class="voice-card-meta">
            <span class="voice-chip">${h({ external: "Externa", own: "Própria", other: "Outra" }[voice.voice_type] || voice.voice_type)}</span>
            <span class="voice-chip ${voice.availability === "available" ? "is-available" : ""}">${h({ available: "Disponível", unavailable: "Indisponível", unknown: "Status desconhecido" }[voice.availability] || voice.availability)}</span>
            ${voice.fish_audio_visibility ? `<span class="voice-chip is-visibility">Fish Audio · ${h(fishVisibilityName(voice.fish_audio_visibility))}</span>` : ""}
          </div>
        </div>
      </div>
      <p class="voice-description">${h(voice.description || "Sem descrição adicionada.")}</p>
      <footer class="voice-card-footer"><span class="voice-id"><span>ID FISH AUDIO</span>${h(voice.fish_audio_id)}</span><span class="voice-added">Registrada · ${h(dateLabel(voice.registered_at))}</span></footer>
    </article>`).join("");
    const activeJobId = window.sessionStorage.getItem("voiceCloneJobId");
    view.innerHTML = `${heading("Biblioteca de vozes", "Crie uma voz própria ou organize seus IDs Fish Audio.", '<button class="button subtle" data-action="register-scroll">Registrar ID existente</button>')}
      <section class="panel voice-clone-panel">
        <header class="voice-clone-heading"><div><span class="eyebrow">FISH AUDIO · CLONAGEM</span><h2>Criar uma voz</h2><p>Envie uma gravação autorizada ou grave direto no microfone.</p></div><div class="voice-duration"><strong>10–60 segundos</strong><span>tempo recomendado</span></div></header>
        <div class="voice-guidance">
          <div><span class="voice-guidance-number">01</span><p><strong>Uma voz, sem ruído</strong><span>Fale com volume e distância constantes para um resultado mais fiel.</span></p></div>
          <div><span class="voice-guidance-number">02</span><p><strong>Privada por padrão</strong><span>O áudio vai ao Fish Audio pelo MCP; o estúdio não guarda a amostra.</span></p></div>
        </div>
        <form id="voice-clone-form" class="registration-form">
          <div class="form-field voice-field-name"><label for="voice-clone-name">Nome da voz *</label><input id="voice-clone-name" required maxlength="200" placeholder="Ex.: Lia — voz principal"></div>
          <div class="form-field voice-field-language"><label for="voice-clone-language">Idioma *</label><select id="voice-clone-language" required><option value="pt">Português (Brasil)</option><option value="en">English</option></select></div>
          <div class="form-field voice-field-visibility"><label for="voice-clone-visibility">Visibilidade no Fish Audio</label><select id="voice-clone-visibility"><option value="private">Privada — somente este workspace</option><option value="unlist">Não listada — qualquer pessoa com o ID</option><option value="public">Pública — biblioteca do Fish Audio</option></select></div>
          <div class="form-field full voice-script-field"><label for="voice-clone-script">Roteiro de gravação <span>opcional</span></label><textarea id="voice-clone-script" rows="7" maxlength="10000">${h(VOICE_SAMPLE_SCRIPTS.pt)}</textarea><span class="field-help">Leia normalmente, depois com acolhimento, curiosidade e reflexão — sempre em volume natural. Sussurros podem alterar o timbre principal. O roteiro é só um guia; o Fish Audio recebe apenas o áudio.</span></div>
          <div class="voice-sample-options form-field full">
            <div class="voice-source-card"><label for="voice-sample-file">Enviar um arquivo</label><p>WAV, MP3, M4A ou OPUS · até 50 MiB</p><input id="voice-sample-file" type="file" accept=".wav,.mp3,.m4a,.opus,audio/wav,audio/mpeg,audio/mp4,audio/ogg"><span id="voice-sample-name" class="field-help">Nenhum arquivo selecionado.</span></div>
            <div class="voice-source-card"><span class="voice-source-label">Gravar agora</span><p>Use o microfone do dispositivo · até 60 s</p><div class="recording-controls"><button class="button secondary" type="button" data-action="start-voice-recording">Gravar</button><button class="button secondary" type="button" data-action="stop-voice-recording" hidden>Parar</button><span id="voice-record-status" class="field-help" role="status">A gravação será convertida para WAV.</span></div></div>
          </div>
          <audio id="voice-sample-preview" controls hidden></audio>
          <div class="voice-consent form-field full"><label><input id="voice-clone-consent" type="checkbox" required><span>Confirmo que esta voz é minha ou tenho autorização para cloná-la e autorizo o envio da gravação ao Fish Audio.</span></label></div>
          <div class="voice-clone-submit form-field full"><p>O Fish Audio informa que mantém os arquivos temporários por até 7 dias. A clonagem pelo MCP não gera custo, segundo a documentação do serviço.</p><div><button class="button primary" type="submit">Criar voz</button><div id="voice-clone-status" class="danger-note" role="status" aria-live="polite"></div></div></div>
        </form>
      </section>
      <section class="voice-library-section">
        <header class="voice-list-heading"><div><span class="eyebrow">SUA COLEÇÃO</span><h2>Vozes registradas</h2><p>Vozes disponíveis para usar nos episódios.</p></div><span class="voice-count">${voices.length} ${voices.length === 1 ? "voz" : "vozes"}</span></header>
        ${cards ? `<div class="voice-grid">${cards}</div>` : `<div class="empty-state voice-empty-state"><span class="voice-empty-mark" aria-hidden="true">◉</span><h2>Sua biblioteca está vazia</h2><p>Crie uma voz acima ou registre um ID Fish Audio que você já possui.</p></div>`}
      </section>
      <details id="register" class="panel voice-manual-panel"><summary><span>Registrar um ID Fish Audio existente</span><span class="voice-manual-hint">Já tem uma voz? Adicione os metadados localmente.</span></summary><p class="muted">Esse registro salva apenas os metadados localmente e não valida a voz.</p><div class="registration-layout"><form id="voice-form" class="registration-form" novalidate>
        <div class="form-field"><label for="voice-name">Nome para exibição *</label><input id="voice-name" required maxlength="200" placeholder="Ex.: Lia — narração principal"></div>
        <div class="form-field"><label for="voice-id">Identificador da voz *</label><input id="voice-id" required maxlength="300" placeholder="Cole o identificador fornecido"></div>
        <div class="form-field"><label for="voice-language">Idioma *</label><select id="voice-language" required><option value="pt">Português (Brasil)</option><option value="en">English</option></select></div>
        <div class="form-field"><label for="voice-type">Tipo de voz</label><select id="voice-type"><option value="external">Externa</option><option value="own">Própria</option><option value="other">Outra</option></select></div>
        <div class="form-field"><label for="voice-availability">Disponibilidade declarada</label><select id="voice-availability"><option value="unknown">Desconhecida</option><option value="available">Disponível</option><option value="unavailable">Indisponível</option></select></div>
        <div class="form-field full"><label for="voice-description">Descrição</label><textarea id="voice-description" rows="3" maxlength="5000" placeholder="Timbre, ritmo ou notas editoriais — sem dados sensíveis."></textarea></div>
        <div class="form-field full"><button class="button" type="submit">Salvar metadados localmente</button></div><div id="voice-form-error" class="danger-note" role="alert"></div>
      </form><aside class="helper-card"><span class="eyebrow">Registro manual</span><h3>Sem verificação externa</h3><p>Insira um identificador de voz que você já possui. A disponibilidade é uma anotação local.</p></aside></div></details>`;
    voiceSampleFile = null;
    document.getElementById("voice-clone-language").value = "pt";
    if (activeJobId) pollVoiceCloneJob(activeJobId);
  }

  async function saveEpisode() {
    const title = document.getElementById("episode-title").value.trim();
    const description = document.getElementById("episode-description").value;
    const language = document.getElementById("episode-language").value;
    const original = document.getElementById("original-article").value;
    const route = currentRoute.slice(1).split("/");
    let episode = null;
    const button = document.querySelector('[data-action="save-episode"]');
    const saveState = document.getElementById("episode-save-state");
    if (!title) { document.getElementById("episode-title").focus(); document.getElementById("episode-title").setCustomValidity("Informe o título do episódio."); document.getElementById("episode-title").reportValidity(); document.getElementById("episode-title").setCustomValidity(""); return; }
    button.disabled = true;
    if (saveState) saveState.textContent = "Salvando localmente…";
    try {
      if (route[1] === "new") {
        episode = await api.createEpisode({ title, description, language, original_article: original });
        go(`#episode/${encodeURIComponent(episode.id)}`);
        showNotice("Rascunho criado e salvo localmente.");
        return;
      }
      const id = route[1];
      episode = await api.episode(id);
      const patch = { title, description, language, status: document.getElementById("episode-status").value, selected_voice_id: document.getElementById("episode-voice").value || null };
      await api.updateEpisode(id, patch);
      if (original !== episode.original_article) {
        if (!originalUnlocked) throw new Error("Antes de alterar o original, escolha “Editar artigo original” para confirmar sua intenção.");
        if (!window.confirm("Confirmar alteração do ARTIGO ORIGINAL? A versão atual será preservada no histórico de revisões.")) {
          if (saveState) saveState.textContent = "Metadados salvos; o artigo original não foi alterado.";
          showNotice("Metadados salvos. O artigo original permaneceu inalterado.");
          return;
        }
        await api.saveOriginal(id, original, true);
      }
      showNotice("Episódio salvo localmente.");
      if (saveState) saveState.textContent = "● Salvo localmente";
    } catch (error) {
      showNotice(error.message, "error");
      if (saveState) saveState.textContent = "Não foi possível salvar.";
    } finally { button.disabled = false; }
  }

  async function saveScripts() {
    if (!scriptReview) return;
    const review = scriptReview;
    if (review.saving) return;
    captureScriptEditors();
    review.saving = true;
    const { id, strings } = review;
    const state = document.getElementById("scripts-save-state");
    const buttons = document.querySelectorAll('[data-action="save-scripts"], [data-action="review-stage"], #interface-language');
    buttons.forEach((button) => { button.disabled = true; });
    if (state) state.textContent = review.language === "en" ? "Saving locally…" : "Salvando localmente…";
    try {
      let episode = await api.episode(id);
      const narration = review.narrationDraft;
      const fish = review.fishDraft;
      if (review.stage === "narration" && narration !== episode.narration_script) episode = await api.saveScript(id, "narration", narration);
      if (review.stage === "fish" && fish !== episode.fish_audio_script) episode = await api.saveScript(id, "fishAudio", fish);
      const voice = document.getElementById("script-voice");
      if (voice && voice.value !== (episode.selected_voice_id || "")) episode = await api.updateEpisode(id, { selected_voice_id: voice.value || null });
      if (scriptReview !== review) return;
      captureScriptEditors();
      review.episode = episode;
      review.saving = false;
      paintScriptReview();
      showNotice(strings.saveOk);
      document.getElementById("scripts-save-state").textContent = `● ${strings.saved}`;
    } catch (_error) {
      if (scriptReview !== review) return;
      showNotice(review.language === "en" ? "Could not save your scripts. Your original article is unchanged." : "Não foi possível salvar os roteiros. O artigo original permanece inalterado.", "error");
      if (state) state.textContent = review.language === "en" ? "Save failed." : "Não foi possível salvar.";
    } finally { review.saving = false; buttons.forEach((button) => { button.disabled = false; }); }
  }

  async function registerVoice(event) {
    event.preventDefault();
    const form = document.getElementById("voice-form");
    const errorBox = document.getElementById("voice-form-error");
    if (!form.reportValidity()) return;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    errorBox.textContent = "";
    try {
      await api.registerVoice({ display_name: document.getElementById("voice-name").value, fish_audio_id: document.getElementById("voice-id").value, language: document.getElementById("voice-language").value, voice_type: document.getElementById("voice-type").value, availability: document.getElementById("voice-availability").value, description: document.getElementById("voice-description").value });
      await loadRoute();
      showNotice("Metadados da voz registrados neste dispositivo.");
    } catch (error) { errorBox.textContent = error.message; }
    finally { submit.disabled = false; }
  }

  function setVoiceSample(file) {
    voiceSampleFile = file;
    const name = document.getElementById("voice-sample-name");
    const preview = document.getElementById("voice-sample-preview");
    if (voiceSamplePreviewUrl) URL.revokeObjectURL(voiceSamplePreviewUrl);
    voiceSamplePreviewUrl = file ? URL.createObjectURL(file) : "";
    if (name) name.textContent = file ? `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MiB` : "Nenhum arquivo selecionado.";
    if (preview) {
      preview.hidden = !file;
      if (file) preview.src = voiceSamplePreviewUrl;
      else preview.removeAttribute("src");
    }
  }

  function encodeVoiceSampleWav(audioBuffer) {
    const targetRate = 16000;
    const outputLength = Math.ceil(audioBuffer.length * targetRate / audioBuffer.sampleRate);
    const output = new ArrayBuffer(44 + outputLength * 2);
    const view = new DataView(output);
    const writeString = (offset, value) => {
      for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
    };
    writeString(0, "RIFF");
    view.setUint32(4, 36 + outputLength * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, outputLength * 2, true);
    const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) => audioBuffer.getChannelData(index));
    for (let index = 0; index < outputLength; index += 1) {
      const sourcePosition = index * audioBuffer.sampleRate / targetRate;
      const lower = Math.floor(sourcePosition);
      const upper = Math.min(lower + 1, audioBuffer.length - 1);
      const fraction = sourcePosition - lower;
      let sample = 0;
      channels.forEach((channel) => {
        sample += channel[lower] * (1 - fraction) + channel[upper] * fraction;
      });
      sample = Math.max(-1, Math.min(1, sample / channels.length));
      view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return new Blob([output], { type: "audio/wav" });
  }

  async function startVoiceRecording() {
    const status = document.getElementById("voice-record-status");
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
        throw new Error("Este navegador não oferece gravação de áudio compatível.");
      }
      voiceRecorderStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (currentRoute !== "#voices") {
        voiceRecorderStream.getTracks().forEach((track) => track.stop());
        voiceRecorderStream = null;
        return;
      }
      const mimeType = typeof window.MediaRecorder.isTypeSupported === "function"
        ? ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]
          .find((type) => window.MediaRecorder.isTypeSupported(type))
        : "";
      voiceRecorder = new window.MediaRecorder(voiceRecorderStream, mimeType ? { mimeType } : undefined);
      voiceRecorderChunks = [];
      voiceRecorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size) voiceRecorderChunks.push(event.data);
      });
      voiceRecorderStopHandler = async () => {
        voiceRecorderStopHandler = null;
        clearInterval(voiceRecorderTimer);
        voiceRecorderTimer = null;
        voiceRecorderStream.getTracks().forEach((track) => track.stop());
        voiceRecorderStream = null;
        const recorded = new Blob(voiceRecorderChunks, { type: voiceRecorder.mimeType });
        voiceRecorder = null;
        let context = null;
        try {
          if (!window.AudioContext) throw new Error("Audio decoding is unavailable.");
          context = new window.AudioContext();
          const decoded = await context.decodeAudioData(await recorded.arrayBuffer());
          const wav = encodeVoiceSampleWav(decoded);
          setVoiceSample(new window.File([wav], "voice-sample.wav", { type: "audio/wav" }));
          if (status) status.textContent = "Gravação pronta como WAV mono. Revise e envie quando estiver satisfeito.";
        } catch (_error) {
          if (status) status.textContent = "Não foi possível converter a gravação. Tente gravar novamente ou envie um arquivo compatível.";
        } finally {
          if (context) await context.close();
          const recordButton = document.querySelector('[data-action="start-voice-recording"]');
          if (recordButton) recordButton.disabled = false;
        }
      };
      voiceRecorder.addEventListener("stop", voiceRecorderStopHandler, { once: true });
      voiceRecorder.start(250);
      let elapsed = 0;
      const start = document.querySelector('[data-action="start-voice-recording"]');
      const stop = document.querySelector('[data-action="stop-voice-recording"]');
      if (start) start.hidden = true;
      if (stop) stop.hidden = false;
      if (status) status.textContent = "Gravando… máximo de 60 segundos.";
      voiceRecorderTimer = setInterval(() => {
        elapsed += 1;
        if (status) status.textContent = `Gravando… ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")} / 1:00`;
        if (elapsed >= 60) stopVoiceRecording();
      }, 1000);
    } catch (error) {
      if (voiceRecorderStream) voiceRecorderStream.getTracks().forEach((track) => track.stop());
      voiceRecorderStream = null;
      if (status) status.textContent = error.name === "NotAllowedError"
        ? "Permita o acesso ao microfone para gravar."
        : error.message;
    }
  }

  function stopVoiceRecording() {
    if (voiceRecorder && voiceRecorder.state !== "inactive") voiceRecorder.stop();
    const start = document.querySelector('[data-action="start-voice-recording"]');
    const stop = document.querySelector('[data-action="stop-voice-recording"]');
    if (start) {
      start.hidden = false;
      start.disabled = true;
    }
    if (stop) stop.hidden = true;
  }

  function discardVoiceRecording() {
    clearInterval(voiceRecorderTimer);
    voiceRecorderTimer = null;
    if (voiceRecorder) {
      if (voiceRecorderStopHandler) voiceRecorder.removeEventListener("stop", voiceRecorderStopHandler);
      if (voiceRecorder.state !== "inactive") voiceRecorder.stop();
    }
    if (voiceRecorderStream) voiceRecorderStream.getTracks().forEach((track) => track.stop());
    voiceRecorder = null;
    voiceRecorderStream = null;
    voiceRecorderChunks = [];
    voiceRecorderStopHandler = null;
  }

  async function pollVoiceCloneJob(jobId) {
    clearTimeout(voiceClonePollTimer);
    const status = document.getElementById("voice-clone-status");
    const submit = document.querySelector('#voice-clone-form button[type="submit"]');
    if (submit) submit.disabled = true;
    if (!status || currentRoute !== "#voices") return;
    try {
      const { job } = await api.voiceCloneJob(jobId);
      if (job.status === "completed") {
        window.sessionStorage.removeItem("voiceCloneJobId");
        const visibility = job.visibility === "private" ? "privada" : `visibilidade ${job.visibility || "não informada"}`;
        if (currentRoute === "#voices") {
          await loadRoute();
          showNotice(`Voz criada e registrada localmente (ID ${job.fish_audio_id}; ${visibility}).`);
        }
        return;
      }
      if (job.status === "failed") {
        window.sessionStorage.removeItem("voiceCloneJobId");
        status.textContent = job.error_message || "Não foi possível criar a voz.";
        if (submit) submit.disabled = false;
        return;
      }
      status.textContent = job.status === "queued" ? "Aguardando o Codex e o Fish Audio…" : "Criando a voz no Fish Audio…";
      voiceClonePollTimer = setTimeout(() => pollVoiceCloneJob(jobId), 2000);
    } catch (error) {
      window.sessionStorage.removeItem("voiceCloneJobId");
      status.textContent = error.message;
      if (submit) submit.disabled = false;
    }
  }

  async function cloneVoiceFromSample(event) {
    event.preventDefault();
    const form = document.getElementById("voice-clone-form");
    const status = document.getElementById("voice-clone-status");
    const submit = form.querySelector('button[type="submit"]');
    if (!form.reportValidity()) return;
    if (!voiceSampleFile) {
      status.textContent = "Escolha um arquivo de áudio ou grave um clipe no microfone.";
      return;
    }
    submit.disabled = true;
    status.textContent = "Enviando a amostra ao Fish Audio…";
    try {
      const result = await api.cloneVoice(voiceSampleFile, {
        display_name: document.getElementById("voice-clone-name").value,
        language: document.getElementById("voice-clone-language").value,
        visibility: document.getElementById("voice-clone-visibility").value,
        description: "",
      }, document.getElementById("voice-clone-consent").checked);
      window.sessionStorage.setItem("voiceCloneJobId", result.job.id);
      pollVoiceCloneJob(result.job.id);
    } catch (error) {
      status.textContent = error.message;
      submit.disabled = false;
    }
  }

  view.addEventListener("input", (event) => {
    if (event.target.id === "original-article") {
      const stats = document.getElementById("article-stats");
      if (stats) stats.textContent = articleStats(event.target.value);
    }
    if (event.target.id === "episode-search") {
      listFilters.search = event.target.value;
      renderEpisodeList(true);
    }
    if (event.target.id === "fish-script" && scriptReview) renderFishApprovalState();
    if (event.target.id === "narration-script") {
      const comparison = view.querySelectorAll(".content-versions textarea")[1];
      if (comparison) comparison.value = event.target.value;
    }
    if (event.target.id === "fish-script") {
      const comparison = view.querySelectorAll(".content-versions textarea")[2];
      if (comparison) comparison.value = event.target.value;
    }
  });
  view.addEventListener("change", (event) => {
    if (event.target.id === "voice-sample-file") {
      const file = event.target.files && event.target.files[0];
      const status = document.getElementById("voice-record-status");
      if (file) {
        const extension = file.name.split(".").pop().toLowerCase();
        if (!["wav", "mp3", "m4a", "opus"].includes(extension)) {
          event.target.value = "";
          setVoiceSample(null);
          if (status) status.textContent = "Formato não aceito. Use WAV, MP3, M4A ou OPUS.";
        } else if (file.size > 50 * 1024 * 1024) {
          event.target.value = "";
          setVoiceSample(null);
          if (status) status.textContent = "O arquivo excede o limite de 50 MiB.";
        } else {
          setVoiceSample(file);
          if (status) status.textContent = "Arquivo selecionado. Confira a transcrição e confirme o envio.";
        }
      } else {
        setVoiceSample(null);
      }
    }
    if (event.target.id === "voice-clone-language") {
      const script = document.getElementById("voice-clone-script");
      const previousLanguage = event.target.dataset.scriptLanguage || "pt";
      if (script && script.value === VOICE_SAMPLE_SCRIPTS[previousLanguage]) {
        script.value = VOICE_SAMPLE_SCRIPTS[event.target.value];
      }
      event.target.dataset.scriptLanguage = event.target.value;
    }
    if (event.target.id === "interface-language" && scriptReview) {
      captureScriptEditors();
      interfaceLanguage = event.target.value;
      scriptReview.language = interfaceLanguage;
      hideNotice();
      paintScriptReview();
      document.getElementById("interface-language").focus();
    }
    if (event.target.id === "transistor-language" && currentRoute.startsWith("#transistor/")) {
      interfaceLanguage = event.target.value;
      loadRoute();
    }
    if (event.target.id === "transistor-file") {
      const player = view.querySelector(".transistor-audio audio");
      const option = event.target.selectedOptions[0];
      if (player) {
        player.src = `/api/files/${encodeURIComponent(event.target.value)}`;
        player.setAttribute("aria-label", `${document.documentElement.lang === "en" ? "Approved audio" : "Áudio aprovado"} · ${option.textContent}`);
      }
      ["upload-recap", "transistor-upload-recap"].forEach((id) => {
        const recap = document.getElementById(id);
        const fileSummary = recap && recap.querySelector("[data-recap-file]");
        if (fileSummary) fileSummary.textContent = `${option.dataset.filename} · ${option.dataset.size}`;
      });
    }
    if (event.target.id === "transistor-show") {
      const option = event.target.selectedOptions[0];
      if (option) view.querySelector("#upload-recap [data-recap-show]").textContent = `${option.textContent} · Transistor`;
    }
    if (event.target.id === "transistor-upload-consent") {
      const confirm = view.querySelector('[data-action="confirm-transistor-upload"]');
      if (confirm) confirm.disabled = !event.target.checked;
    }
    if (event.target.id === "transistor-publish-consent") {
      const confirm = view.querySelector('[data-action="confirm-transistor-publish"]');
      if (confirm) confirm.disabled = !event.target.checked;
    }
    if (event.target.name === "transistor-action") {
      const date = document.getElementById("transistor-published-at");
      if (date) date.disabled = event.target.value !== "scheduled" || !confirmedTransistorDrafts.has(view.dataset.transistorEpisode);
      const action = view.querySelector('[data-action="open-transistor-publish"]');
      if (action) action.textContent = event.target.value === "scheduled" ? (document.documentElement.lang === "en" ? "Review schedule confirmation" : "Revisar confirmação de agendamento") : (document.documentElement.lang === "en" ? "Review publication confirmation" : "Revisar confirmação de publicação");
    }
    if (event.target.id === "generation-language" && currentRoute.startsWith("#generation/")) {
      generationLanguage = event.target.value;
      interfaceLanguage = generationLanguage;
      loadRoute();
    }
    if (event.target.id === "generation-voice") {
      const save = view.querySelector('[data-action="save-generation-voice"]');
      if (save) save.disabled = !event.target.value;
      const voice = currentVoices.find((item) => item.id === event.target.value);
      const summary = document.getElementById("generation-voice-summary");
      if (summary) summary.textContent = voice ? `${voice.display_name} · ${voice.fish_audio_id} · ${voice.availability}` : (document.documentElement.lang === "en" ? "No voice selected" : "Nenhuma voz selecionada");
      const prepare = view.querySelector('[data-action="prepare-handoff"]');
      if (prepare) prepare.disabled = prepare.dataset.scriptReady !== "true" || !voice || voice.availability !== "available" || voice.language !== prepare.dataset.episodeLanguage;
    }
    if (event.target.name === "suggestion-scope" && scriptReview) scriptReview.scope = event.target.value;
    if (event.target.id === "suggestion-history" && scriptReview) {
      captureScriptEditors();
      scriptReview.selectedSuggestion = scriptReview.suggestions.find((item) => item.id === event.target.value) || null;
      renderSuggestionReview();
    }
    if (event.target.id === "status-filter") listFilters.status = event.target.value;
    if (event.target.id === "language-filter") listFilters.language = event.target.value;
    if (["status-filter", "language-filter"].includes(event.target.id)) renderEpisodeList(true);
    if (event.target.id === "episode-language" && currentRoute.startsWith("#episode/")) {
      const newLanguage = event.target.value;
      const voice = document.getElementById("episode-voice");
      if (voice) {
        const matchingVoices = currentVoices.filter((item) => item.language === newLanguage);
        voice.innerHTML = `<option value="">Sem voz selecionada</option>${matchingVoices.map((item) => `<option value="${h(item.id)}">${h(item.display_name)} · ${langShort(item.language)}</option>`).join("")}`;
        voice.value = "";
        const help = voice.parentElement.querySelector(".field-help");
        if (help) help.textContent = `Idioma do conteúdo: ${langName(newLanguage)}. As vozes disponíveis são filtradas por idioma.`;
      }
    }
  });
  view.addEventListener("submit", (event) => {
    if (event.target.id === "voice-form") registerVoice(event);
    if (event.target.id === "voice-clone-form") cloneVoiceFromSample(event);
  });
  view.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "start-voice-recording") await startVoiceRecording();
    if (action === "stop-voice-recording") stopVoiceRecording();
    if (action === "review-stage" && scriptReview && !scriptReview.saving) {
      captureScriptEditors();
      scriptReview.stage = button.dataset.stage;
      hideNotice();
      paintScriptReview(true);
    }
    if (action === "save-episode") await saveEpisode();
    if (action === "save-scripts") await saveScripts();
    if (action === "request-suggestion") await requestSuggestion();
    if (action === "retry-suggestion") await requestSuggestion(scriptReview.request.scope, scriptReview.request.paragraphIndex);
    if (action === "select-paragraph") {
      scriptReview.selectedIndex = Number(button.dataset.index);
      scriptReview.scope = "paragraph";
      const radio = view.querySelector('input[name="suggestion-scope"][value="paragraph"]');
      if (radio) radio.checked = true;
      view.querySelectorAll(".source-paragraph").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    }
    if (action === "use-suggestion") applySuggestion();
    if (action === "keep-suggestion") {
      scriptReview.selectedSuggestion = null;
      renderSuggestionReview();
    }
    if (action === "open-approval") {
      renderFishApprovalState();
      const dialog = document.getElementById("approval-dialog");
      if (dialog && !button.disabled) dialog.showModal();
    }
    if (action === "confirm-approval") {
      event.preventDefault();
      await approveFishScript();
    }
    if (action === "import-article") importInput.click();
    if (action === "unlock-original") {
      if (window.confirm("Você deseja editar o artigo ORIGINAL? Esta ação é separada das versões de roteiro.")) {
        originalUnlocked = true;
        const field = document.getElementById("original-article");
        field.readOnly = false;
        field.focus();
        showNotice("Edição explícita do original habilitada. Ao salvar, uma confirmação final será solicitada.");
      }
    }
    if (action === "register-scroll") {
      const target = document.getElementById("register");
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (action === "retry") go(button.dataset.hash || "#dashboard");
    if (action === "save-generation-voice") {
      const select = document.getElementById("generation-voice");
      if (!select || !select.value) return;
      button.disabled = true;
      try {
        const route = currentRoute.slice(1).split("/");
        await api.updateEpisode(route[1], { selected_voice_id: select.value });
        await loadRoute();
        showNotice(document.documentElement.lang === "en" ? "Registered voice selection saved locally." : "Seleção de voz registrada salva localmente.");
      } catch (_error) {
        showNotice(document.documentElement.lang === "en" ? "Could not save this voice selection. No audio was generated." : "Não foi possível salvar esta seleção de voz. Nenhum áudio foi gerado.", "error");
        button.disabled = false;
      }
    }
    if (action === "save-transistor-metadata") {
      const route = currentRoute.slice(1).split("/");
      const button = view.querySelector('[data-action="save-transistor-metadata"]');
      const state = document.getElementById("transistor-save-state");
      button.disabled = true;
      if (state) state.textContent = document.documentElement.lang === "en" ? "Saving locally…" : "Salvando localmente…";
      try {
        await api.updateEpisode(route[1], { title: document.getElementById("transistor-title").value.trim(), description: document.getElementById("transistor-description").value });
        await loadRoute();
        showNotice(document.documentElement.lang === "en" ? "Metadata saved locally." : "Metadados salvos localmente.");
      } catch (error) {
        if (state) state.textContent = error.message;
        button.disabled = false;
      }
    }
    if (action === "open-transistor-upload") {
      const dialog = document.getElementById("transistor-upload-dialog");
      const option = document.getElementById("transistor-show")?.selectedOptions[0];
      if (dialog && !dialog.open && !button.disabled && option?.value) {
        dialog.dataset.showId = option.value;
        dialog.querySelector("[data-recap-show]").textContent = `${option.textContent} · Transistor`;
        dialog.showModal();
      }
    }
    if (action === "confirm-transistor-upload") {
      event.preventDefault();
      const dialog = document.getElementById("transistor-upload-dialog");
      const showId = dialog?.dataset.showId;
      const consent = document.getElementById("transistor-upload-consent");
      if (!dialog?.open || !showId || !consent?.checked || button.disabled) return;
      button.disabled = true;
      button.textContent = document.documentElement.lang === "en" ? "Uploading…" : "Enviando…";
      document.getElementById("transistor-upload-progress").textContent = document.documentElement.lang === "en" ? "Uploading the approved file and creating a draft. Publishing is not part of this request." : "Enviando o arquivo aprovado e criando um rascunho. Esta solicitação não publica o episódio.";
      const route = currentRoute.slice(1).split("/");
      try {
        await api.createTransistorDraft(route[1], {
          show_id: showId,
          file_id: document.getElementById("transistor-file").value,
          summary: document.getElementById("transistor-summary").value,
          keywords: document.getElementById("transistor-keywords").value,
        }, true);
        if (dialog) dialog.close();
        await loadRoute();
        showNotice(document.documentElement.lang === "en" ? "Transistor draft created. It has not been published." : "Rascunho criado no Transistor. Ainda não foi publicado.");
      } catch (error) {
        if (dialog) dialog.close();
        await loadRoute();
        showNotice(error.message, "error");
      }
    }
    if (action === "refresh-transistor") {
      button.disabled = true;
      button.textContent = document.documentElement.lang === "en" ? "Checking status…" : "Consultando status…";
      const route = currentRoute.slice(1).split("/");
      confirmedTransistorDrafts.delete(route[1]);
      try {
        const result = await api.refreshTransistorPublication(route[1]);
        if (result.publication && result.publication.status === "draft") confirmedTransistorDrafts.add(route[1]);
        else confirmedTransistorDrafts.delete(route[1]);
        await loadRoute();
        showNotice(document.documentElement.lang === "en" ? "Transistor status read back and refreshed." : "Status lido novamente e atualizado do Transistor.");
      } catch (error) {
        await loadRoute();
        showNotice(`${document.documentElement.lang === "en" ? "Status refresh failed. " : "Falha ao atualizar o status. "}${error.message}`, "error");
      }
    }
    if (action === "open-transistor-publish") {
      if (button.disabled) return;
      const selectedAction = view.querySelector('input[name="transistor-action"]:checked');
      const isSchedule = selectedAction && selectedAction.value === "scheduled";
      const date = document.getElementById("transistor-published-at");
      if (isSchedule && (!date.value || !date.reportValidity())) { date.focus(); return; }
      const dialog = document.getElementById("transistor-publish-dialog");
      const title = document.getElementById("transistor-publish-title");
      const confirmButton = dialog.querySelector('[data-action="confirm-transistor-publish"]');
      title.textContent = isSchedule ? (document.documentElement.lang === "en" ? "Confirm episode schedule" : "Confirme o agendamento") : (document.documentElement.lang === "en" ? "Confirm publish now" : "Confirme a publicação agora");
      confirmButton.textContent = isSchedule ? (document.documentElement.lang === "en" ? "Confirm schedule" : "Confirmar agendamento") : (document.documentElement.lang === "en" ? "Publish now" : "Publicar agora");
      const recap = document.getElementById("transistor-publish-recap");
      if (recap) recap.textContent = isSchedule ? `${date.value} · ${document.querySelector(".timezone-note").textContent}` : (document.documentElement.lang === "en" ? "This will change the remote episode status to Published." : "O status do episódio remoto será alterado para Publicado.");
      dialog.showModal();
    }
    if (action === "confirm-transistor-publish") {
      event.preventDefault();
      const consent = document.getElementById("transistor-publish-consent");
      if (!consent || !consent.checked || button.disabled) return;
      const selectedAction = view.querySelector('input[name="transistor-action"]:checked');
      const status = selectedAction ? selectedAction.value : "published";
      const time = document.getElementById("transistor-published-at");
      const dialog = document.getElementById("transistor-publish-dialog");
      const route = currentRoute.slice(1).split("/");
      button.disabled = true;
      button.textContent = document.documentElement.lang === "en" ? "Submitting…" : "Enviando…";
      document.getElementById("transistor-publish-progress").textContent = document.documentElement.lang === "en" ? "Sending the confirmed publication request. Do not retry until status is refreshed." : "Enviando a solicitação confirmada. Não tente novamente antes de atualizar o status.";
      try {
        await api.publishTransistorEpisode(route[1], status, status === "scheduled" ? time.value : "", true);
        confirmedTransistorDrafts.delete(route[1]);
        if (dialog) dialog.close();
        await loadRoute();
        showNotice(status === "scheduled" ? (document.documentElement.lang === "en" ? "Episode scheduled on Transistor. It is not marked published." : "Episódio agendado no Transistor. Ainda não está marcado como publicado.") : (document.documentElement.lang === "en" ? "Episode published on Transistor." : "Episódio publicado no Transistor."));
      } catch (error) {
        confirmedTransistorDrafts.delete(route[1]);
        if (dialog) dialog.close();
        await loadRoute();
        showNotice(`${document.documentElement.lang === "en" ? "Publication action failed. " : "Falha na ação de publicação. "}${error.message}`, "error");
      }
    }
    if (action === "prepare-handoff") {
      if (button.disabled) return;
      const dialog = document.getElementById("handoff-confirm-dialog");
      if (dialog) dialog.showModal();
    }
    if (action === "confirm-handoff") {
      event.preventDefault();
      button.disabled = true;
      const dialog = document.getElementById("handoff-confirm-dialog");
      const errorBox = document.getElementById("generation-error");
      try {
        const route = currentRoute.slice(1).split("/");
        await api.prepareGenerationHandoff(route[1], true);
        await loadRoute();
      } catch (_error) {
        if (dialog) dialog.close();
        if (errorBox) errorBox.textContent = document.documentElement.lang === "en" ? "Could not prepare the generation request. Verify the approved script and available voice." : "Não foi possível preparar a solicitação de geração. Confira o script aprovado e a voz disponível.";
        button.disabled = false;
      }
    }
    if (action === "quote-generation") {
      button.disabled = true;
      try {
        const route = currentRoute.slice(1).split("/");
        await api.quoteGeneration(route[1], button.dataset.id, true);
        await loadRoute();
      } catch (error) {
        const errorBox = document.querySelector(`[data-handoff-error="${CSS.escape(button.dataset.id)}"]`);
        if (errorBox) errorBox.textContent = error.message;
        button.disabled = false;
      }
    }
    if (action === "generate-audio") {
      const dialog = document.getElementById("generation-confirm-dialog");
      const cost = document.getElementById("generation-confirm-cost");
      const confirmButton = dialog && dialog.querySelector('[data-action="confirm-audio-generation"]');
      if (confirmButton) {
        confirmButton.dataset.id = button.dataset.id;
        confirmButton.dataset.credits = button.dataset.credits;
      }
      if (cost) {
        const number = Number(button.dataset.credits).toLocaleString(document.documentElement.lang === "en" ? "en-US" : "pt-BR");
        cost.textContent = document.documentElement.lang === "en"
          ? `Fish Audio quoted approximately ${number} credits. The final charge may change before generation.`
          : `O Fish Audio cotou aproximadamente ${number} créditos. O valor final pode mudar antes da geração.`;
      }
      if (dialog) dialog.showModal();
    }
    if (action === "confirm-audio-generation") {
      event.preventDefault();
      button.disabled = true;
      const dialog = document.getElementById("generation-confirm-dialog");
      try {
        const route = currentRoute.slice(1).split("/");
        await api.generateAudio(route[1], button.dataset.id, true);
        if (dialog) dialog.close();
        await loadRoute();
      } catch (error) {
        if (dialog) dialog.close();
        showNotice(`${document.documentElement.lang === "en" ? "Could not start generation. " : "Não foi possível iniciar a geração. "}${error.message}`, "error");
        button.disabled = false;
      }
    }
    if (action === "record-handoff-failure") {
      const handoffId = button.dataset.id;
      const errorBox = document.querySelector(`[data-handoff-error="${CSS.escape(handoffId)}"]`);
      if (!window.confirm(document.documentElement.lang === "en" ? "Record this handoff as failed? This does not retry or call Fish Audio." : "Registrar este handoff como falha? Isso não tenta novamente nem chama o Fish Audio.")) return;
      button.disabled = true;
      try {
        const route = currentRoute.slice(1).split("/");
        const select = document.querySelector(`[data-handoff-failure="${CSS.escape(handoffId)}"]`);
        await api.failGenerationHandoff(route[1], handoffId, select.value);
        await loadRoute();
      } catch (error) {
        if (errorBox) errorBox.textContent = error.message;
        button.disabled = false;
      }
    }
    if (action === "review-audio") {
      pendingAudioReview = { id: button.dataset.id, status: button.dataset.status };
      const dialog = document.getElementById("audio-review-dialog");
      const prompt = document.getElementById("audio-review-prompt");
      const labels = document.documentElement.lang === "en" ? {
        approve: "Approve this audio version?", reject: "Reject this audio version? The local file will remain preserved.", confirm: "Confirm review",
      } : {
        approve: "Aprovar esta versão de áudio?", reject: "Rejeitar esta versão de áudio? O arquivo local será preservado.", confirm: "Confirmar revisão",
      };
      if (prompt) {
        const card = button.closest(".audio-version");
        const version = card && card.querySelector(".audio-version-heading") ? card.querySelector(".audio-version-heading").textContent : "";
        prompt.textContent = `${pendingAudioReview.status === "approved" ? labels.approve : labels.reject} ${version}`.trim();
      }
      const confirmButton = dialog && dialog.querySelector('[data-action="confirm-audio-review"]');
      if (confirmButton) confirmButton.textContent = labels.confirm;
      if (dialog) dialog.showModal();
    }
    if (action === "cancel-audio-review") pendingAudioReview = null;
    if (action === "confirm-audio-review") {
      event.preventDefault();
      if (!pendingAudioReview) return;
      button.disabled = true;
      const review = pendingAudioReview;
      try {
        await api.reviewAudioFile(review.id, review.status, true);
        pendingAudioReview = null;
        await loadRoute();
        showNotice(document.documentElement.lang === "en" ? "Audio review saved. The local recording was preserved." : "Revisão de áudio salva. A gravação local foi preservada.");
      } catch (_error) {
        const dialog = document.getElementById("audio-review-dialog");
        if (dialog) dialog.close();
        pendingAudioReview = null;
        showNotice(document.documentElement.lang === "en" ? "Could not save this review. The audio file was not changed." : "Não foi possível salvar esta revisão. O arquivo de áudio não foi alterado.", "error");
      } finally { button.disabled = false; }
    }
  });
  view.addEventListener("change", async (event) => {
    const input = event.target.closest("[data-generation-file]");
    const file = input && input.files && input.files[0];
    if (!file) return;
    try {
      const route = currentRoute.slice(1).split("/");
      await api.importGeneration(route[1], input.dataset.generationFile, file);
      await loadRoute();
      showNotice(document.documentElement.lang === "en" ? "Audio imported as a new local version. No previous file was changed." : "Áudio importado como uma nova versão local. Nenhum arquivo anterior foi alterado.");
    } catch (error) {
      const handoffError = document.querySelector(`[data-handoff-error="${CSS.escape(input.dataset.generationFile)}"]`);
      if (handoffError) handoffError.textContent = error.message;
      input.value = "";
    }
  });
  importInput.addEventListener("change", async () => {
    const file = importInput.files && importInput.files[0];
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("O arquivo excede o limite recomendado de 2 MiB para conteúdo de texto.");
      const text = await file.text();
      if (text.length > 100000) throw new Error("O arquivo excede o limite de 100.000 caracteres para conteúdo de artigo.");
      const editor = document.getElementById("original-article");
      if (!editor) return;
      if (editor.readOnly) {
        showNotice("Para substituir o original de um episódio existente, confirme primeiro a edição do artigo.", "error");
        return;
      }
      editor.value = text;
      document.getElementById("article-stats").textContent = articleStats(text);
      showNotice("Texto importado localmente. Salve para persistir as alterações.");
    } catch (error) { showNotice(error.message, "error"); }
    finally { importInput.value = ""; }
  });
  window.addEventListener("hashchange", loadRoute);
  loadRoute();
})();
