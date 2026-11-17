const { test, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const net = require("node:net");

let server;
let dataDir;
let port;
let baseURL;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).on("error", reject));
  const { port: selected } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return selected;
}

function startServer() {
  server = spawn("python", ["app.py"], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, STUDIO_HOST: "127.0.0.1", STUDIO_PORT: String(port), STUDIO_DATA_DIR: dataDir },
    stdio: "ignore",
  });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const check = async () => {
      if (server.exitCode !== null) return reject(new Error(`Local app exited with code ${server.exitCode}`));
      try {
        const response = await fetch(`${baseURL}/health`);
        if (response.ok) return resolve();
      } catch { /* Wait for the local server to bind. */ }
      if (Date.now() > deadline) return reject(new Error("Local app did not become ready within 10 seconds"));
      setTimeout(check, 100);
    };
    check();
  });
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const child = server;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  server = null;
}

test.beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "codigo-cicatriz-e2e-"));
  port = await freePort();
  baseURL = `http://127.0.0.1:${port}`;
  await startServer();
});

test.afterAll(async () => {
  await stopServer();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("local app exposes loading, empty, retry/error, responsive and accessible states", async ({ page }) => {
  await page.route("**/api/dashboard", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });
  await page.goto(baseURL);
  await expect(page.getByRole("status")).toContainText("Carregando seu estúdio");
  await expect(page.getByRole("heading", { name: "Seu próximo episódio começa aqui" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Pular para o conteúdo/ })).toHaveAttribute("href", "#view");
  await expect(page.getByRole("navigation")).toBeVisible();

  await page.unroute("**/api/dashboard");
  await page.route("**/api/dashboard", (route) => route.abort());
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Não foi possível carregar esta página");
  await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible();
  await page.unroute("**/api/dashboard");
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(page.getByRole("heading", { name: "Seu próximo episódio começa aqui" })).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${baseURL}/#episodes`);
  await expect(page.getByRole("heading", { name: "Episódios", exact: true })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  await expect(page.getByRole("searchbox", { name: "Buscar título ou descrição" })).toBeVisible();
});

test("Portuguese and English drafts, voices and three text versions persist independently across restart", async ({ page }) => {
  const unexpectedExternalRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== baseURL || /generation|publish|fish-audio\.com|transistor\.fm/i.test(request.url())) {
      unexpectedExternalRequests.push(request.url());
    }
  });
  await page.goto(baseURL);
  await expect(page.getByRole("heading", { name: "Seu próximo episódio começa aqui" })).toBeVisible();

  // Register local voice metadata; this must not contact the provider.
  await page.goto(`${baseURL}/#voices`);
  await page.getByLabel("Nome para exibição *").fill("Lia editorial");
  await page.getByLabel("Identificador da voz *").fill("local-fish-id-123");
  await page.getByLabel("Idioma *").selectOption("pt");
  await page.getByLabel("Descrição").fill("Voz de teste local");
  await page.getByRole("button", { name: "Salvar metadados localmente" }).click();
  await expect(page.getByRole("heading", { name: "Lia editorial" })).toBeVisible();
  await expect(page.getByText("local-fish-id-123")).toBeVisible();

  // Create and save a Portuguese source article.
  await page.goto(`${baseURL}/#episode/new`);
  await page.getByRole("button", { name: "Salvar e continuar" }).click();
  await expect(page.getByLabel("Título do episódio")).toBeFocused();
  await expect(page).toHaveURL(/#episode\/new$/);
  await page.getByLabel("Título do episódio").fill("Rascunho em português");
  await page.getByLabel("Idioma do conteúdo").selectOption("pt");
  await page.getByLabel("Descrição do episódio").fill("Descrição PT para o fluxo local.");
  const portugueseOriginal = "O artigo original em português permanece intacto.";
  await page.getByLabel("Artigo original").fill(portugueseOriginal);
  await page.getByRole("button", { name: "Salvar e continuar" }).click();
  await expect(page).toHaveURL(/#episode\/[0-9a-f-]+$/);
  const portugueseUrl = page.url();
  const portugueseId = portugueseUrl.split("#episode/")[1];
  await expect(page.getByLabel("Artigo original — versão atual")).toHaveValue(portugueseOriginal);

  // Compare/edit only the derived fields and select the locally registered voice.
  await page.getByRole("link", { name: "Abrir e comparar roteiros" }).click();
  const narration = "Texto de narração independente.";
  const fishScript = "[pause] Script Fish Audio manual.";
  await page.getByLabel("Roteiro de narração editável").fill(narration);
  await page.getByLabel("Script Fish Audio editável").fill(fishScript);
  await page.getByLabel("Voz selecionada para referência").selectOption({ label: "Lia editorial · PT-BR" });
  await page.getByRole("button", { name: "Salvar roteiros" }).click();
  await expect(page.getByRole("status")).toContainText("Roteiros salvos em versões independentes");
  await page.getByRole("link", { name: "Voltar ao artigo" }).click();
  await expect(page.getByLabel("Artigo original — versão atual")).toHaveValue(portugueseOriginal);

  // Original stays read-only until explicit unlock; declining final confirmation preserves it.
  await expect(page.getByLabel("Artigo original — versão atual")).toHaveAttribute("readonly", "");
  await page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /Editar artigo original/ }).click();
  const changedOriginal = "Tentativa de alteração explícita.";
  await page.getByLabel("Artigo original — versão atual").fill(changedOriginal);
  await page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.getByRole("status")).toContainText("O artigo original permaneceu inalterado");
  await expect(page.getByLabel("Artigo original — versão atual")).toHaveValue(changedOriginal);
  await page.reload();
  await expect(page.getByLabel("Artigo original — versão atual")).toHaveValue(portugueseOriginal);

  // Create an English draft and verify language-aware listing/filtering.
  await page.goto(`${baseURL}/#episode/new`);
  await page.getByLabel("Título do episódio").fill("English local draft");
  await page.getByLabel("Idioma do conteúdo").selectOption("en");
  await page.getByLabel("Descrição do episódio").fill("English description for the local workflow.");
  const englishOriginal = "An English source article kept separate from scripts.";
  await page.getByLabel("Artigo original").fill(englishOriginal);
  await page.getByRole("button", { name: "Salvar e continuar" }).click();
  await expect(page).toHaveURL(/#episode\/[0-9a-f-]+$/);
  const englishId = page.url().split("#episode/")[1];
  await expect(page.getByLabel("Artigo original — versão atual")).toHaveValue(englishOriginal);
  await page.goto(`${baseURL}/#episodes`);
  await expect(page.getByRole("link", { name: "Rascunho em português", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "English local draft", exact: true })).toBeVisible();
  await page.getByLabel("Filtrar por idioma").selectOption("en");
  await expect(page.getByRole("link", { name: "English local draft", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Rascunho em português", exact: true })).toHaveCount(0);
  await page.getByLabel("Filtrar por idioma").selectOption("");
  await page.getByRole("link", { name: "Rascunho em português", exact: true }).click();
  await expect(page.getByLabel("Artigo original — versão atual")).toHaveValue(portugueseOriginal);
  await page.getByRole("link", { name: "Abrir e comparar roteiros" }).click();
  await expect(page.getByLabel("Artigo original para comparação")).toHaveValue(portugueseOriginal);
  await expect(page.getByLabel("Roteiro de narração editável")).toHaveValue(narration);
  await expect(page.getByLabel("Script Fish Audio editável")).toHaveValue(fishScript);
  await expect(page.getByLabel("Voz selecionada para referência")).toHaveValue(/.+/);
  const selectedVoiceId = await page.getByLabel("Voz selecionada para referência").inputValue();

  // Restart the actual local server with the same temporary data directory.
  await stopServer();
  await startServer();
  await page.reload();
  await expect(page.getByLabel("Artigo original para comparação")).toHaveValue(portugueseOriginal);
  await expect(page.getByLabel("Roteiro de narração editável")).toHaveValue(narration);
  await expect(page.getByLabel("Script Fish Audio editável")).toHaveValue(fishScript);
  await expect(page.getByLabel("Voz selecionada para referência")).toHaveValue(selectedVoiceId);
  await page.goto(`${baseURL}/#episode/${englishId}`);
  await expect(page.getByLabel("Artigo original — versão atual")).toHaveValue(englishOriginal);
  await page.goto(`${baseURL}/#voices`);
  await expect(page.getByRole("heading", { name: "Lia editorial" })).toBeVisible();
  expect(unexpectedExternalRequests).toEqual([]);

  // Explicit confirmed edits create a revision without conflating script fields.
  await page.goto(portugueseUrl);
  await page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /Editar artigo original/ }).click();
  const acceptedOriginal = "Nova versão editorial confirmada.";
  await page.getByLabel("Artigo original — versão atual").fill(acceptedOriginal);
  await page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.getByRole("status")).toContainText("Episódio salvo localmente");
  await expect(page.getByLabel("Artigo original — versão atual")).toHaveValue(acceptedOriginal);
  const apiEpisode = await page.request.get(`${baseURL}/api/episodes/${portugueseId}`);
  const saved = await apiEpisode.json();
  expect(saved.original_article).toBe(acceptedOriginal);
  expect(saved.narration_script).toBe(narration);
  expect(saved.fish_audio_script).toBe(fishScript);
  const revisionsResponse = await page.request.get(`${baseURL}/api/episodes/${portugueseId}/revisions`);
  expect((await revisionsResponse.json()).revisions[0].content).toBe(portugueseOriginal);
});
