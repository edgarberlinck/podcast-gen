(function () {
  "use strict";

  const api = window.StudioApi.createApi();
  const view = document.getElementById("view");
  const notice = document.getElementById("notice");
  const importInput = document.getElementById("article-import");
  const statuses = ["Draft", "Preparing Script", "Script Review", "Ready for Generation", "Generating Audio", "Audio Review", "Approved", "Publishing", "Published", "Failed"];
  let pageRequest = 0;
  let currentRoute = "";
  let originalUnlocked = false;
  let currentVoices = [];
  let episodeCache = [];
  let listFilters = { search: "", status: "", language: "" };
  let scriptReview = null;
  let interfaceLanguage = null;

  const h = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const langName = (code) => code === "en" ? "English" : "Português (Brasil)";
  const langShort = (code) => code === "en" ? "EN" : "PT-BR";
  const languageSelect = (selected) => `<select id="episode-language" aria-label="Idioma do conteúdo" required><option value="pt" ${selected === "pt" ? "selected" : ""}>Português (Brasil)</option><option value="en" ${selected === "en" ? "selected" : ""}>English</option></select>`;
  const statusOptions = (selected, includeAll = false) => `${includeAll ? '<option value="">Todos os status</option>' : ""}${statuses.map((status) => `<option value="${h(status)}" ${status === selected ? "selected" : ""}>${h(status)}</option>`).join("")}`;
  const dateLabel = (stamp) => {
    if (!stamp) return "";
    const date = new Date(stamp);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(date);
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
    currentRoute = window.location.hash || "#dashboard";
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
      <div class="fish-review-layout"><section class="fish-review"><header><span class="eyebrow">03 · ${h(strings.manual)}</span><h2>${h(strings.fish)}</h2></header><label for="script-voice">${h(strings.voiceReference)}</label><select id="script-voice"><option value="">${english ? "No voice selected" : "Sem voz selecionada"}</option>${voices.filter((voice) => voice.language === episode.language).map((voice) => `<option value="${h(voice.id)}" ${scriptReview.voiceId === voice.id ? "selected" : ""}>${h(voice.display_name)} · ${langShort(voice.language)}</option>`).join("")}</select><label for="fish-script">${h(strings.fish)}</label><textarea lang="${h(episode.language)}" id="fish-script" maxlength="100000" aria-label="${english ? "Editable Fish Audio script" : "Script Fish Audio editável"}" placeholder="${h(strings.fish)}…">${h(scriptReview.fishDraft)}</textarea><div class="fish-approval-state" id="fish-approval-state" aria-live="polite"></div><p class="muted">${selectedVoice ? `${h(strings.voiceReference)} · ${h(selectedVoice.display_name)} · ${h(selectedVoice.fish_audio_id)}` : h(strings.noVoice)}</p><p class="muted">${h(strings.approvalCopy)}</p><button class="button primary" data-action="open-approval">${h(strings.approve)}</button></section>
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
      status.textContent = busy ? strings.loading : "";
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

  async function renderVoices(requestId) {
    setNav("voices", "Biblioteca de vozes");
    const result = await api.voices();
    if (requestId !== pageRequest) return;
    const voices = result.voices || [];
    currentVoices = voices;
    const cards = voices.map((voice) => `<article class="voice-card"><div class="voice-card-head"><span class="voice-initial" aria-hidden="true">${h((voice.display_name || "?").slice(0, 1).toLocaleUpperCase())}</span><div><h3>${h(voice.display_name)}</h3><div class="voice-card-meta"><span class="tag">${langShort(voice.language)}</span><span>Tipo: ${h({ external: "externa", own: "própria", other: "outra" }[voice.voice_type] || voice.voice_type)}</span><span>Status: ${h({ available: "disponível", unavailable: "indisponível", unknown: "desconhecido" }[voice.availability] || voice.availability)}</span></div></div></div><p>${h(voice.description || "Sem descrição adicionada.")}</p><span class="voice-id">ID · ${h(voice.fish_audio_id)}</span><p class="muted">Registrada localmente · ${h(dateLabel(voice.registered_at))}</p></article>`).join("");
    view.innerHTML = `${heading("Biblioteca de vozes", "Guarde identificadores e metadados informados por você — sem conectar ao Fish Audio.", '<button class="button primary" data-action="register-scroll">+ Registrar voz</button>')}
      <div class="info-strip" style="background:#eaf1e9;color:#4e6659"><strong>CATÁLOGO LOCAL</strong><br>Clonagem, pesquisa remota e teste de áudio não fazem parte deste núcleo. Status descreve seus metadados locais, não uma verificação externa.</div>
      ${cards ? `<div class="voice-grid">${cards}</div>` : `<div class="empty-state"><h2>Nenhuma voz registrada</h2><p>Adicione localmente um identificador Fish Audio e seus metadados para selecioná-lo em um episódio.</p></div>`}
      <section id="register" class="panel"><h2>Registrar uma voz</h2><p class="muted">Identificador, idioma e descrição são informados por você e salvos neste dispositivo.</p><div class="registration-layout"><form id="voice-form" class="registration-form" novalidate>
        <div class="form-field"><label for="voice-name">Nome para exibição *</label><input id="voice-name" required maxlength="200" placeholder="Ex.: Lia — narração principal"></div>
        <div class="form-field"><label for="voice-id">Identificador da voz *</label><input id="voice-id" required maxlength="300" placeholder="Cole o identificador fornecido"></div>
        <div class="form-field"><label for="voice-language">Idioma *</label><select id="voice-language" required><option value="pt">Português (Brasil)</option><option value="en">English</option></select></div>
        <div class="form-field"><label for="voice-type">Tipo de voz</label><select id="voice-type"><option value="external">Externa</option><option value="own">Própria</option><option value="other">Outra</option></select></div>
        <div class="form-field"><label for="voice-availability">Disponibilidade declarada</label><select id="voice-availability"><option value="unknown">Desconhecida</option><option value="available">Disponível</option><option value="unavailable">Indisponível</option></select></div>
        <div class="form-field full"><label for="voice-description">Descrição</label><textarea id="voice-description" rows="3" maxlength="5000" placeholder="Timbre, ritmo ou notas editoriais — sem dados sensíveis."></textarea></div>
        <div class="form-field full"><button class="button" type="submit">Salvar metadados localmente</button></div><div id="voice-form-error" class="danger-note" role="alert"></div>
      </form><aside class="helper-card"><span class="eyebrow">Importante</span><h3>Registro não é verificação</h3><p>O estúdio não se conecta ao Fish Audio nem valida a voz. Insira um identificador que você já possui. A disponibilidade é uma anotação local.</p></aside></div></section>`;
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
    if (event.target.id === "interface-language" && scriptReview) {
      captureScriptEditors();
      interfaceLanguage = event.target.value;
      scriptReview.language = interfaceLanguage;
      hideNotice();
      paintScriptReview();
      document.getElementById("interface-language").focus();
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
  view.addEventListener("submit", (event) => { if (event.target.id === "voice-form") registerVoice(event); });
  view.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
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
