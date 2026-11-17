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

  async function loadRoute() {
    const requestId = ++pageRequest;
    currentRoute = window.location.hash || "#dashboard";
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
    const [episode, voicesResult] = await Promise.all([api.episode(id), api.voices()]);
    if (requestId !== pageRequest) return;
    const selectedVoice = (voicesResult.voices || []).find((voice) => voice.id === episode.selected_voice_id);
    const countWords = (text) => text.trim() ? text.trim().split(/\s+/).length : 0;
    view.innerHTML = `<div class="editor-top"><div>${heading("Roteiros do episódio", `${episode.title} · ${langShort(episode.language)}`)}</div><button class="button" data-action="save-scripts">Salvar alterações</button></div>
      <section class="panel"><div class="voice-select-row"><div class="form-field"><label for="script-voice">Voz selecionada para referência</label><select id="script-voice"><option value="">Sem voz selecionada</option>${(voicesResult.voices || []).filter((voice) => voice.language === episode.language).map((voice) => `<option value="${h(voice.id)}" ${episode.selected_voice_id === voice.id ? "selected" : ""}>${h(voice.display_name)} · ${langShort(voice.language)}</option>`).join("")}</select></div><span class="muted">${selectedVoice ? `ID local: ${h(selectedVoice.fish_audio_id)}` : "Selecione uma voz registrada, ou deixe em branco."}</span></div></section>
      <div class="compare-label"><span>COMPARAÇÃO LADO A LADO · VERSÕES INDEPENDENTES</span><span>Os painéis editáveis são salvos em rotas separadas.</span></div>
      <div class="content-versions"><section class="version-card original"><header class="version-header"><span class="eyebrow">01 · Fonte preservada</span><h3>Artigo original</h3></header><div class="version-body"><textarea maxlength="100000" aria-label="Artigo original para comparação" readonly>${h(episode.original_article)}</textarea></div><footer class="version-footer">Versão original · edição deliberada na tela Artigo</footer></section>
      <section class="version-card narration"><header class="version-header"><span class="eyebrow">02 · Texto de leitura</span><h3>Roteiro de narração</h3></header><div class="version-body"><textarea id="narration-script" maxlength="100000" aria-label="Roteiro de narração editável" placeholder="Escreva manualmente a versão para narração…">${h(episode.narration_script)}</textarea></div><footer class="version-footer">Rascunho manual · ${countWords(episode.narration_script)} palavras</footer></section>
      <section class="version-card fish"><header class="version-header"><span class="eyebrow">03 · Formatação manual</span><h3>Script Fish Audio</h3></header><div class="version-body"><textarea id="fish-script" maxlength="100000" aria-label="Script Fish Audio editável" placeholder="Escreva manualmente o script e suas etiquetas…">${h(episode.fish_audio_script)}</textarea></div><footer class="version-footer">Sintaxe não validada · somente texto salvo</footer></section></div>
      <div class="info-strip">Este núcleo não faz sugestões por IA, não verifica etiquetas com Fish Audio e não gera áudio. O artigo, o roteiro de narração e o script Fish são armazenados separadamente.</div>
      <div class="save-row"><a class="button secondary" href="#episode/${encodeURIComponent(episode.id)}">Voltar ao artigo</a><button class="button" data-action="save-scripts">Salvar roteiros</button><span id="scripts-save-state" class="save-state" aria-live="polite"></span></div>`;
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
    const route = currentRoute.slice(1).split("/");
    const id = route[1];
    const state = document.getElementById("scripts-save-state");
    const button = document.querySelector('[data-action="save-scripts"]');
    button.disabled = true;
    if (state) state.textContent = "Salvando localmente…";
    try {
      const tasks = [api.updateEpisode(id, { selected_voice_id: document.getElementById("script-voice").value || null })];
      const narration = document.getElementById("narration-script").value;
      const fish = document.getElementById("fish-script").value;
      const episode = await api.episode(id);
      if (narration !== episode.narration_script) tasks.push(api.saveScript(id, "narration", narration));
      if (fish !== episode.fish_audio_script) tasks.push(api.saveScript(id, "fishAudio", fish));
      await Promise.all(tasks);
      showNotice("Roteiros salvos em versões independentes.");
      if (state) state.textContent = "● Salvo localmente";
    } catch (error) {
      showNotice(error.message, "error");
      if (state) state.textContent = "Não foi possível salvar.";
    } finally { button.disabled = false; }
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
  });
  view.addEventListener("change", (event) => {
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
    if (action === "save-episode") await saveEpisode();
    if (action === "save-scripts") await saveScripts();
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
