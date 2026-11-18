const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");

const html = fs.readFileSync("static/index.html", "utf8");
const css = fs.readFileSync("static/refresh.css", "utf8");

test("studio loads the approved black, red and off-white visual system", () => {
  assert.match(html, /\/static\/refresh\.css/);
  assert.match(html, /name="theme-color" content="#111111"/);
  assert.match(css, /--green:\s*#111111/i);
  assert.match(css, /--coral:\s*#B51222/i);
  assert.match(css, /--paper:\s*#F5F4F2/i);
  assert.match(css, /background:\s*#FFF0F1/i);
  assert.match(css, /\.sidebar\s*\{[^}]*background:\s*#111111/is);
});

test("visual refresh retains narrow-screen layouts and visible keyboard focus", () => {
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /:focus-visible[^}]*outline:\s*3px solid #B51222/is);
});

test("editorial safety and approval states remain visually distinct", () => {
  assert.match(css, /\.editorial-safety\s*\{[^}]*background:\s*#FFF0F1/is);
  assert.match(css, /\.fish-approval-state\.pending, \.model-caveat, \.timezone-note \{ background: #FFF2D8; color: #704A0C; \}/);
  assert.match(css, /\.fish-approval-state\.approved, \.notice\.success, \.approved-lock \{ background: #E8F1EA; color: #315D48; \}/);
  assert.match(css, /\.transistor-status-chip\.published\s*\{[^}]*background:\s*#E8F1EA/is);
});
