// The check node against a real browser: a Playwright server of the same
// version as playwright-core (PREVIEW_TEST_PLAYWRIGHT_WS), which reaches
// the test's HTTP server at PREVIEW_TEST_HOST. scripts/test.sh starts one
// in a container; without it these tests are skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileServer, preset, publishSite, startApp, type TestApp, type ZEntry } from "./helpers.ts";

const WS = process.env.PREVIEW_TEST_PLAYWRIGHT_WS ?? "";
const HOST = process.env.PREVIEW_TEST_HOST || "127.0.0.1";
const skip = WS ? false : "no Playwright server: set PREVIEW_TEST_PLAYWRIGHT_WS (scripts/test.sh does)";

const app: ZEntry[] = [
  {
    name: "index.html",
    data: `<!doctype html><meta charset="utf-8"><title>Piano</title>
<link rel="stylesheet" href="style.css">
<h1>Il piano</h1>
<p id="dati">…</p>
<form id="f"><input id="name" placeholder="nome">
<select id="giorni"><option value="1">uno</option><option value="2">due</option><option value="3">tre</option></select>
<button id="go" type="submit">Mostra</button></form>
<div id="out"></div>
<a id="about" href="about.html">About</a>
<script type="module" src="app.mjs"></script>`,
  },
  { name: "style.css", data: "body { font-family: sans-serif; } .giorno { border: 1px solid #888; margin: 4px; padding: 4px; }" },
  {
    name: "app.mjs",
    data: `import { card } from "./card.mjs";
const r = await fetch("assets/data.json");
const d = await r.json();
document.getElementById("dati").textContent = "dati: " + d.giorni;
document.getElementById("f").addEventListener("submit", (e) => {
  e.preventDefault();
  const n = Number(document.getElementById("giorni").value);
  const out = document.getElementById("out");
  out.innerHTML = "<h2>Ciao " + document.getElementById("name").value + "</h2>";
  for (let i = 1; i <= n; i++) out.insertAdjacentHTML("beforeend", card(i));
});
`,
  },
  { name: "card.mjs", data: `export const card = (i) => '<div class="giorno">Giorno ' + i + '</div>';\n` },
  { name: "assets/data.json", data: '{"giorni": 3}' },
  { name: "about.html", data: `<!doctype html><meta charset="utf-8"><title>About</title><h1>About this app</h1>` },
  {
    name: "broken.html",
    data: `<!doctype html><meta charset="utf-8"><title>Broken</title><p>broken</p>
<script>console.error("boom"); console.warn("careful"); console.log("fine");
fetch("missing.json").catch(() => {});
setTimeout(() => { throw new Error("uncaught kaboom"); }, 0);</script>`,
  },
];

async function withApp(extra: string, fn: (t: TestApp, url: string, call: (args: Record<string, unknown>, project?: string) => Promise<any>) => Promise<void>, entries = app): Promise<void> {
  const t = await startApp(preset(`playwright: {ws_endpoint: "${WS}", timeout: 60}\n${extra}`), HOST);
  const files = await fileServer();
  try {
    const c = await t.client();
    const { url } = await publishSite(t, c, files, entries, { title: "check" });
    await fn(t, url, (args, project = "demo") => t.call(c, "check", args, project));
  } finally {
    await files.close();
    await t.close();
  }
}

test("a check that passes: the steps a person takes, a screenshot, a clean console", { skip }, async () => {
  await withApp("", async (_t, url, call) => {
    const r = await call({
      url,
      viewport: { width: 800, height: 600 },
      steps: [
        { action: "wait_for", text: "dati: 3" },
        { action: "fill", selector: "#name", value: "Ada" },
        { action: "select", selector: "#giorni", value: "3" },
        { action: "click", selector: "#go" },
        { action: "expect_text", selector: "#out h2", text: "Ciao Ada" },
        { action: "expect_count", selector: ".giorno", count: 3 },
        { action: "screenshot", name: "piano tre giorni", full_page: true },
        { action: "press", selector: "#name", key: "End" },
        { action: "click", selector: "#about" },
        { action: "expect_text", text: "About this app" },
        { action: "goto" },
        { action: "expect_text", selector: "#dati", text: "dati: 3" },
      ],
    });
    assert.ok(!r.isError, r.content?.[0]?.text);
    const o = r.structuredContent;
    assert.equal(o.ok, true, JSON.stringify(o, null, 1));
    assert.deepEqual(o.steps.map((s: any) => [s.action, s.ok]), [
      ["wait_for", true], ["fill", true], ["select", true], ["click", true], ["expect_text", true], ["expect_count", true],
      ["screenshot", true], ["press", true], ["click", true], ["expect_text", true], ["goto", true], ["expect_text", true],
    ]);
    assert.equal(o.steps[6].screenshot, "07-piano-tre-giorni.png");
    assert.deepEqual(o.screenshots, ["07-piano-tre-giorni.png"]);
    assert.deepEqual(o.console, []);
    assert.deepEqual(o.failed_requests, []);
    assert.equal(o.url, url);
    assert.match(o.browser, /^chromium \d+/);
    assert.match(r.content[0].text, /^ok: 12 steps passed in [\d.]+ s$/);
    const shot = r.content.find((x: any) => x.type === "resource");
    assert.equal(shot.resource.uri, "file:///07-piano-tre-giorni.png");
    assert.equal(shot.resource.mimeType, "image/png");
    assert.deepEqual([...Buffer.from(shot.resource.blob, "base64").subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    // Without steps: the index loads, its module and its data with it.
    const plain = await call({ url });
    assert.equal(plain.structuredContent.ok, true, JSON.stringify(plain.structuredContent));
    assert.deepEqual(plain.structuredContent.steps, []);
    assert.match(plain.content[0].text, /^ok: the page loaded with no errors/);
  });
});

test("a failing step: why, a screenshot, the rest not run", { skip }, async () => {
  await withApp("", async (_t, url, call) => {
    const r = await call({
      url,
      steps: [
        { action: "select", selector: "#giorni", value: "2" },
        { action: "click", selector: "#go" },
        { action: "expect_count", selector: ".giorno", count: 4, timeout: 1 },
        { action: "screenshot" },
        { action: "click", selector: "#about" },
      ],
    });
    assert.ok(!r.isError, r.content?.[0]?.text);
    const o = r.structuredContent;
    assert.equal(o.ok, false);
    assert.deepEqual(o.steps.map((s: any) => [s.action, s.ok, s.not_run ?? false]), [
      ["select", true, false], ["click", true, false], ["expect_count", false, false], ["screenshot", false, true], ["click", false, true],
    ]);
    assert.equal(o.steps[2].error, ".giorno: 2 elements, not 4");
    assert.equal(o.steps[2].screenshot, "03-failed.png");
    assert.ok(o.steps[2].ms >= 900 && o.steps[2].ms < 5000, String(o.steps[2].ms));
    assert.deepEqual(o.screenshots, ["03-failed.png"]);
    assert.equal(r.content.filter((x: any) => x.type === "resource").length, 1);
    assert.equal(r.content[0].text, "not ok: step 3 (expect_count): .giorno: 2 elements, not 4");

    // A selector that matches nothing: the step's timeout, Playwright's words.
    const missing = await call({ url, steps: [{ action: "click", selector: "#nope", timeout: 1 }] });
    assert.equal(missing.structuredContent.ok, false);
    assert.match(missing.structuredContent.steps[0].error, /Timeout 1000ms exceeded/);
    // A text that is not there.
    const text = await call({ url, steps: [{ action: "expect_text", selector: "h1", text: "Addio", timeout: 0.5 }] });
    assert.equal(text.structuredContent.steps[0].error, '"Addio" is not in h1, which reads "Il piano"');
    // goto out of the preview fails the step, and goes nowhere.
    const out = await call({ url, steps: [{ action: "goto", path: "../../health" }] });
    assert.match(out.structuredContent.steps[0].error, /goto \.\.\/\.\.\/health: outside the preview/);
  });
});

test("the console's errors and warnings, uncaught exceptions, failed requests", { skip }, async () => {
  await withApp("", async (_t, url, call) => {
    const r = await call({ url: `${url}broken.html` });
    assert.ok(!r.isError, r.content?.[0]?.text);
    const o = r.structuredContent;
    assert.equal(o.ok, false);
    assert.deepEqual(o.console.filter((x: any) => x.type !== "error" || !/404/.test(x.text)), [
      { type: "error", text: "boom" },
      { type: "warning", text: "careful" },
      { type: "pageerror", text: "uncaught kaboom" },
    ]);
    assert.deepEqual(o.failed_requests, [{ url: `${url}missing.json`, status: 404 }]);
    assert.match(r.content[0].text, /^not ok: \d errors in the console, 1 failed requests$/);
    // A page that is not there: the error, no step run.
    const nf = await call({ url: `${url}nothing.html`, steps: [{ action: "screenshot" }] });
    assert.equal(nf.structuredContent.ok, false);
    assert.match(nf.structuredContent.error, /nothing\.html answered 404/);
    assert.deepEqual(nf.structuredContent.steps, [{ action: "screenshot", ok: false, ms: 0, not_run: true }]);
  });
});

test("a check never opens what is not a live preview of its project", { skip }, async () => {
  await withApp("", async (t, url, call) => {
    for (const u of [`${t.preset.public_url}/health`, "http://example.com/", url.replace("/p/", "/q/")]) {
      const r = await call({ url: u });
      assert.equal(r.isError, true, u);
      assert.match(r.content[0].text, /not an address of a preview/);
    }
    const other = await call({ url }, "another-project");
    assert.match(other.content[0].text, /no live preview [a-z2-7]{26} in this project/);
  });
});

test("connect self: the browser reaches nothing outside the preview", { skip }, async () => {
  // A server outside the preview, which the page links to and fetches.
  let hits = 0;
  const outside = http.createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/plain" }).end("outside");
  });
  await new Promise<void>((ok) => outside.listen(0, ok));
  const there = `http://${HOST}:${(outside.address() as AddressInfo).port}/`;
  const entries: ZEntry[] = [
    {
      name: "index.html",
      data: `<!doctype html><meta charset="utf-8"><p id="r">…</p><a id="away" href="${there}page">away</a>
<script>fetch("${there}api").then((r) => r.text()).then((t) => { document.getElementById("r").textContent = "fetched " + t; }, () => { document.getElementById("r").textContent = "blocked"; });</script>`,
    },
  ];
  try {
    await withApp("connect: self\n", async (_t, url, call) => {
      const r = await call({ url, steps: [{ action: "expect_text", selector: "#r", text: "blocked" }, { action: "click", selector: "#away" }] });
      const o = r.structuredContent;
      assert.equal(o.steps[0].ok, true, JSON.stringify(o));
      // The fetch: stopped by the page's CSP, in the console.
      assert.ok(o.console.some((x: any) => x.type === "error" && /Content Security Policy/.test(x.text)), JSON.stringify(o.console));
      // The navigation: stopped by the check's browser.
      assert.ok(o.failed_requests.some((x: any) => x.url === `${there}page` && /connect is self/.test(x.error)), JSON.stringify(o.failed_requests));
      assert.equal(hits, 0);
    }, entries);
    // Open, the same page reaches it.
    await withApp("", async (_t, url, call) => {
      const r = await call({ url, steps: [{ action: "expect_text", selector: "#r", text: "fetched outside" }] });
      assert.equal(r.structuredContent.ok, true, JSON.stringify(r.structuredContent));
      assert.equal(hits, 1);
    }, entries);
  } finally {
    outside.close();
  }
});
