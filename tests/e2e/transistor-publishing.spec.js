const { test, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

let server;
let dataDir;
const origin = "http://127.0.0.1:8127";

test.beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "codigo-transistor-ui-"));
  server = spawn("python", ["app.py"], {
    cwd: process.cwd(),
    env: { ...process.env, STUDIO_HOST: "127.0.0.1", STUDIO_PORT: "8127", STUDIO_DATA_DIR: dataDir, TRANSISTOR_API_KEY: "" },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch (_error) { /* wait for local server startup */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("local UI server did not become ready");
});

test.afterAll(() => {
  if (server) server.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("Transistor screen is responsive and each remote operation is separately user-confirmed", async ({ page }) => {
  const calls = [];
  let publication = null;
  const episode = { id: "episode-1", title: "Local episode", description: "Episode summary", language: "en" };
  const files = [
    { id: "file-approved", filename: "approved.mp3", size_bytes: 4096, created_at: "2026-11-18T00:31:00Z", approval_status: "approved" },
    { id: "file-unapproved", filename: "pending.mp3", size_bytes: 512, created_at: "2026-11-18T00:32:00Z", approval_status: "pending" },
  ];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    calls.push(key);
    if (url.pathname === "/api/episodes/episode-1" && request.method() === "GET") return route.fulfill({ json: episode });
    if (url.pathname === "/api/episodes/episode-1" && request.method() === "PATCH") {
      Object.assign(episode, request.postDataJSON());
      return route.fulfill({ json: episode });
    }
    if (url.pathname === "/api/episodes/episode-1/files") return route.fulfill({ json: { files } });
    if (url.pathname === "/api/episodes/episode-1/transistor" && request.method() === "GET") return route.fulfill({ json: { publication } });
    if (url.pathname === "/api/transistor/shows") return route.fulfill({ json: { shows: [
      { id: "show-1", title: "Código & Cicatriz", time_zone: "America/Sao_Paulo" },
      { id: "show-2", title: "Second podcast & guests", time_zone: "America/Sao_Paulo" },
    ] } });
    if (url.pathname.endsWith("/transistor/draft")) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const body = request.postDataJSON();
      publication = { episode_id: "episode-1", file_id: body.file_id, show_id: body.show_id, remote_episode_id: "remote-1", status: "draft", show_title: "Second podcast & guests", title: episode.title, description: episode.description, summary: body.summary, keywords: body.keywords, show_time_zone: "America/Sao_Paulo", show_time_zone_supported: true };
      return route.fulfill({ json: { publication }, status: 201 });
    }
    if (url.pathname.endsWith("/transistor/refresh")) return route.fulfill({ json: { publication } });
    if (url.pathname.endsWith("/transistor/publish")) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const body = request.postDataJSON();
      publication = { ...publication, status: body.status, published_at: body.published_at || null };
      return route.fulfill({ json: { publication } });
    }
    if (url.pathname.startsWith("/api/files/")) return route.fulfill({ status: 200, contentType: "audio/mpeg", body: Buffer.from("mock audio") });
    return route.fulfill({ json: { error: { code: "unexpected", message: "Unexpected mocked route" } }, status: 500 });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/#transistor/episode-1`);
  await expect(page.getByRole("heading", { name: /Seu rascunho está pronto/ })).toBeVisible();
  await expect(page.locator("#transistor-file option")).toHaveCount(1);
  await expect(page.locator(".transistor-audio audio")).toHaveAttribute("src", "/api/files/file-approved");
  await expect(page.getByRole("button", { name: /Revisar confirmação de envio/ })).toBeEnabled();
  expect(calls.some((call) => /transistor\/(draft|publish)$/.test(call))).toBe(false);

  await page.locator("#transistor-language").selectOption("en");
  await expect(page.getByRole("heading", { name: "Your draft is ready. Publishing is not." })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.locator("#transistor-show").selectOption("show-2");
  await expect(page.locator("#upload-recap [data-recap-show]")).toHaveText("Second podcast & guests · Transistor");
  await page.getByRole("button", { name: "Review upload confirmation" }).click();
  await expect(page.getByRole("dialog", { name: "Before uploading audio" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Yes, upload audio" })).toBeDisabled();
  await expect(page.locator("#transistor-upload-recap")).toContainText("approved.mp3");
  await expect(page.locator("#transistor-upload-recap [data-recap-show]")).toHaveText("Second podcast & guests · Transistor");
  expect(calls.some((call) => call.endsWith("/transistor/draft"))).toBe(false);
  await page.getByLabel(/I confirm sending this approved audio/).check();
  const [uploadRequest] = await Promise.all([
    page.waitForRequest((request) => request.url().endsWith("/transistor/draft")),
    page.getByRole("button", { name: "Yes, upload audio" }).click(),
  ]);
  expect(uploadRequest.postDataJSON()).toMatchObject({ show_id: "show-2", confirm_upload: true });
  await expect(page.locator("#transistor-upload-progress")).toContainText("Uploading the approved file");
  await expect(page.getByRole("heading", { name: /Draft · not published/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Review publication confirmation/ })).toBeDisabled();
  expect(calls.some((call) => call.endsWith("/transistor/publish"))).toBe(false);

  await page.getByRole("button", { name: /Refresh status/ }).click();
  await expect(page.getByRole("button", { name: /Review publication confirmation/ })).toBeEnabled();
  await page.getByRole("button", { name: /Review publication confirmation/ }).click();
  await page.getByLabel(/I confirm this separate change/).check();
  await page.getByRole("button", { name: "Publish now" }).click();
  await expect(page.locator("#transistor-publish-progress")).toContainText("Sending the confirmed publication request");
  await expect(page.getByRole("heading", { name: "Published on Transistor" })).toBeVisible();
  expect(calls.filter((call) => call.endsWith("/transistor/draft")).length).toBe(1);
  expect(calls.filter((call) => call.endsWith("/transistor/refresh")).length).toBe(1);
  expect(calls.filter((call) => call.endsWith("/transistor/publish")).length).toBe(1);
});
