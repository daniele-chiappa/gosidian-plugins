// The harness of separation-test.sh: a server of files by reference, calls
// of publish, check, list and unpublish through MCP to the two plugins
// (connect open and connect self), and a real browser (the Playwright
// server's Chromium, Firefox and WebKit) on the previews, looking for what a
// preview must not reach. It prints what each browser did, and exits
// non-zero if something leaked.
import http from "node:http";
import crypto from "node:crypto";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { zip, type ZEntry } from "../test/helpers.ts";

const TOKEN = "t0k-separation";
const WS = "ws://pw:3000/";
const fail: string[] = [];
const report = (line: string) => console.log(line);
const expect = (what: string, ok: boolean, got: unknown) => {
  if (!ok) fail.push(`${what}: ${JSON.stringify(got)}`);
};

// The zips, by reference, as gosidian hands them; and an outside host,
// with CORS open, for the pages to call.
const files = new Map<string, Buffer>();
const server = http.createServer((req, res) => {
  const u = req.url ?? "";
  if (u.startsWith("/f/")) {
    const f = files.get(decodeURIComponent(u.slice(3)));
    return void (f ? res.writeHead(200).end(f) : res.writeHead(404).end());
  }
  res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/plain" }).end("outside");
});
await new Promise<void>((ok) => server.listen(9000, "0.0.0.0", ok));
let n = 0;
const ref = (entries: ZEntry[]) => {
  const data = zip(entries);
  const key = `${++n}.zip`;
  files.set(key, data);
  return { name: "site.zip", mime: "application/zip", size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex"), url: `http://harness:9000/f/${key}` };
};
const page = (name: string) => `<!doctype html><meta charset="utf-8"><title>${name}</title><h1 id="who">preview ${name}</h1><p id="secret">${name}'s page</p>`;
const siteOf = (name: string, extra: ZEntry[] = []): ZEntry[] => [{ name: "index.html", data: page(name) }, { name: "data.json", data: JSON.stringify({ of: name }) }, ...extra];

async function plugin(host: string) {
  const base = `http://${host}:8000`;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const c = new Client({ name: "separation-test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  const call = async (name: string, args: Record<string, unknown>, project = "sep") =>
    (await c.callTool({ name, arguments: args, _meta: { "gosidian/project": project, "gosidian/run": "sep-1" } }, undefined, { timeout: 300_000 })) as any;
  return { c, call };
}

const open = await plugin("preview-open");
const closed = await plugin("preview-self");

// 1. Zips that must be refused; one whose code would write a file in /tmp
// if anything ran it (the script checks /tmp after).
const refused = async (what: string, entries: ZEntry[], why: RegExp) => {
  const r = await open.call("publish", { site: ref(entries) });
  report(`--- ${what}: ${r.isError ? "refused: " : "PUBLISHED "}${r.content?.[0]?.text}`);
  expect(what, Boolean(r.isError) && why.test(r.content?.[0]?.text ?? ""), r.content?.[0]?.text);
};
await refused("a link to /etc/passwd", siteOf("x", [{ name: "passwd.txt", data: "/etc/passwd", mode: 0o120777, method: 0 }]), /passwd\.txt: a symbolic link/);
await refused("a path out of the folder", siteOf("x", [{ name: "../../../../etc/cron.d/x.txt", data: "* * * * * root id" }]), /outside its folder/);
await refused("an absolute path", siteOf("x", [{ name: "/etc/profile.d/x.txt", data: "id" }]), /outside its folder/);
await refused("a shell script", siteOf("x", [{ name: "run.sh", data: "#!/bin/sh\ntouch /tmp/pwned-sh\n" }]), /run\.sh \(\.sh\)/);
const evil = await open.call("publish", {
  site: ref(siteOf("evil", [
    { name: "evil.js", data: "require('fs').writeFileSync('/tmp/pwned-js', 'x');\n" },
    { name: "evil.mjs", data: "import fs from 'node:fs'; fs.writeFileSync('/tmp/pwned-mjs', 'x');\n" },
    { name: "package.json", data: JSON.stringify({ name: "evil", scripts: { preinstall: "touch /tmp/pwned-npm", postinstall: "touch /tmp/pwned-npm" } }), mode: 0o100755 },
  ])),
});
expect("the zip with code", !evil.isError, evil.content?.[0]?.text);

// 2. Two previews of one project, one of another, on each plugin.
const A = (await open.call("publish", { site: ref(siteOf("A")), title: "A" })).structuredContent;
const B = (await open.call("publish", { site: ref(siteOf("B")), title: "B" })).structuredContent;
const C = (await open.call("publish", { site: ref(siteOf("C")) }, "other")).structuredContent;
const S = (await closed.call("publish", { site: ref(siteOf("S")) })).structuredContent;
const S2 = (await closed.call("publish", { site: ref(siteOf("S2")) })).structuredContent;
for (const [k, v] of Object.entries({ A, B, C, S, S2 })) expect(`publish ${k}`, /^http:\/\/preview-(open|self):8080\/p\/[a-z2-7]{26}\/$/.test(v?.url ?? ""), v);
report(`--- published: A ${A.url}, B ${B.url}, C (project other) ${C.url}; connect self: S ${S.url}, S2 ${S2.url}`);
const listed = (await open.call("list", {})).structuredContent.previews.map((p: any) => p.id).sort();
expect("list sees the project's previews only", JSON.stringify(listed) === JSON.stringify([A.id, B.id, evil.structuredContent.id].sort()), listed);
// The served code of the zip: text, not run.
const js = await fetch(`${evil.structuredContent.url}evil.js`);
expect("evil.js served as text", js.status === 200 && js.headers.get("content-type") === "text/javascript; charset=utf-8", js.status);

// 3. In each browser: what a page of A reaches.
async function probe(p: Page, url: string, other: string, outside: string): Promise<Record<string, string>> {
  return p.evaluate(async ({ other, outside }) => {
    const r: Record<string, string> = {};
    const t = (k: string, f: () => unknown) => {
      try {
        r[k] = `ok ${JSON.stringify(f())}`;
      } catch (e) {
        r[k] = `throws ${(e as Error).name}`;
      }
    };
    const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
    r.origin = String(self.origin);
    t("localStorage", () => {
      localStorage.setItem("leak", "A");
      return localStorage.getItem("leak");
    });
    t("sessionStorage", () => sessionStorage.getItem("x"));
    t("document.cookie read", () => document.cookie);
    t("document.cookie write", () => {
      document.cookie = "planted=1; path=/";
      return document.cookie;
    });
    t("indexedDB", () => indexedDB.open("x") && "opened");
    try {
      await navigator.serviceWorker.register("sw.js");
      r.serviceWorker = "registered";
    } catch (e) {
      r.serviceWorker = `refused ${(e as Error).name}`;
    }
    const f = async (k: string, u: string, init?: RequestInit) => {
      try {
        const x = await fetch(u, init);
        r[k] = `${x.status} ${(await x.text()).slice(0, 30)}`;
      } catch (e) {
        r[k] = `fails ${(e as Error).name}`;
      }
    };
    await f("fetch own data.json", "data.json");
    await f("fetch other preview's data.json", other + "data.json");
    await f("fetch other preview, credentials include", other + "data.json", { credentials: "include" });
    await f("fetch outside host", outside);
    // Another preview in a popup: its DOM out of reach.
    const w = window.open(other);
    await wait(1500);
    t("popup: other preview's DOM", () => w?.document.getElementById("secret")?.textContent);
    t("popup: its location", () => String(w?.location.href));
    w?.close();
    // In a frame: the same.
    const fr = document.createElement("iframe");
    fr.src = other;
    document.body.append(fr);
    await new Promise((ok) => {
      fr.onload = ok;
      setTimeout(ok, 3000);
    });
    t("iframe: other preview's DOM", () => fr.contentDocument?.getElementById("secret")?.textContent ?? "null contentDocument");
    t("iframe: contentWindow.document", () => fr.contentWindow?.document.title);
    // Its own page in a frame is another opaque origin too.
    const own = document.createElement("iframe");
    own.src = "index.html";
    document.body.append(own);
    await new Promise((ok) => {
      own.onload = ok;
      setTimeout(ok, 3000);
    });
    t("iframe: own page's DOM", () => own.contentDocument?.title ?? "null contentDocument");
    return r;
  }, { other, outside });
}

const browsers: [string, BrowserType][] = [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]];
for (const [bn, bt] of browsers) {
  const browser = await bt.connect(WS, { timeout: 60_000 });
  for (const [mode, X, Y] of [["open", A, B], ["self", S, S2]] as const) {
    const ctx = await browser.newContext();
    // A cookie of the previews' host, as gosidian's would be on the same
    // host: the pages must not read it, their requests must not carry it.
    const host = new URL(X.url).hostname;
    await ctx.addCookies([{ name: "host_session", value: "s3cret", url: `http://${host}:8080/`, sameSite: "Lax" }]);
    const sent: { url: string; cookie: boolean; kind: string }[] = [];
    ctx.on("request", (req) => {
      let kind = req.resourceType();
      if (req.isNavigationRequest()) {
        try {
          kind = req.frame().parentFrame() ? "frame" : "navigation";
        } catch {
          // A popup's first navigation: its page is not there yet.
          kind = "popup";
        }
      }
      req.allHeaders().then((h) => sent.push({ url: req.url(), cookie: Boolean(h.cookie), kind }), () => {});
    });
    const p = await ctx.newPage();
    await p.goto(X.url);
    const r = await probe(p, X.url, Y.url, "http://harness:9000/outside");
    await p.waitForTimeout(300);
    report(`--- ${bn}, connect ${mode}, page of ${X === A ? "A" : "S"}:`);
    for (const [k, v] of Object.entries(r)) report(`    ${k}: ${v}`);
    const carried = sent.filter((s) => s.cookie).map((s) => `${s.kind} ${s.url.replace(/\/p\/[a-z2-7]{26}\//, "/p/<id>/")}`);
    report(`    requests with the host's cookie: ${carried.join("; ") || "none"}`);
    const at = `${bn} ${mode}`;
    expect(`${at}: origin`, r.origin === "null", r.origin);
    for (const k of ["localStorage", "sessionStorage", "document.cookie read", "document.cookie write", "indexedDB"]) expect(`${at}: ${k}`, r[k].startsWith("throws"), r[k]);
    expect(`${at}: service worker`, r.serviceWorker.startsWith("refused"), r.serviceWorker);
    expect(`${at}: own data`, r["fetch own data.json"].startsWith("200"), r["fetch own data.json"]);
    if (mode === "open") {
      expect(`${at}: other preview's data, public`, r["fetch other preview's data.json"].startsWith("200"), r["fetch other preview's data.json"]);
      expect(`${at}: outside host`, r["fetch outside host"].startsWith("200"), r["fetch outside host"]);
    } else {
      expect(`${at}: other preview's data`, r["fetch other preview's data.json"].startsWith("fails"), r["fetch other preview's data.json"]);
      expect(`${at}: outside host`, r["fetch outside host"].startsWith("fails"), r["fetch outside host"]);
    }
    expect(`${at}: credentials include`, r["fetch other preview, credentials include"].startsWith("fails"), r["fetch other preview, credentials include"]);
    for (const k of ["popup: other preview's DOM", "popup: its location", "iframe: contentWindow.document"]) expect(`${at}: ${k}`, r[k].startsWith("throws"), r[k]);
    for (const k of ["iframe: other preview's DOM", "iframe: own page's DOM"]) expect(`${at}: ${k}`, r[k].startsWith("throws") || r[k] === 'ok "null contentDocument"', r[k]);
    // Only top-level navigations carry the host's cookies (SameSite=Lax):
    // what the person opens, and a popup a page opens, as any site's could;
    // nothing a page fetches or loads does.
    const bad = sent.filter((s) => s.cookie && s.kind !== "navigation" && s.kind !== "popup");
    expect(`${at}: a page's request carried the host's cookie`, bad.length === 0, bad);
    await ctx.close();
  }
  await browser.close();
}

// 4. check through MCP, from the container as in production: a pass on A,
// another project's preview refused, an address outside refused; with
// connect self, a page that calls outside fails the check.
const ok = await open.call("check", { id: A.id, steps: [{ action: "expect_text", selector: "#who", text: "preview A" }, { action: "screenshot", name: "a" }] });
report(`--- check of A: ${ok.content?.[0]?.text}`);
expect("check of A", ok.structuredContent?.ok === true && ok.content?.some((x: any) => x.type === "resource" && x.resource.mimeType === "image/png"), ok.structuredContent ?? ok.content);
const otherProject = await open.call("check", { id: C.id });
report(`--- check of C from project sep: ${otherProject.content?.[0]?.text}`);
expect("check of another project's preview", otherProject.isError && /no live preview/.test(otherProject.content?.[0]?.text), otherProject.content);
const away = await open.call("check", { url: "http://harness:9000/outside" });
report(`--- check of an address outside the previews: ${away.content?.[0]?.text}`);
expect("check outside", away.isError && /not an address of a preview/.test(away.content?.[0]?.text), away.content);
const caller = (await closed.call("publish", { site: ref([{ name: "index.html", data: `<!doctype html><p id="r">…</p><script>fetch("http://harness:9000/outside").then(() => r.textContent = "reached", () => r.textContent = "blocked")</script>` }]) })).structuredContent;
const blocked = await closed.call("check", { id: caller.id });
report(`--- connect self, a page that calls outside: ${blocked.content?.[0]?.text}; console: ${JSON.stringify(blocked.structuredContent?.console?.map((x: any) => x.text.slice(0, 90)))}`);
expect("connect self: the call outside fails the check", blocked.structuredContent?.ok === false, blocked.structuredContent);
const removed = await open.call("unpublish", { id: B.id }, "other");
expect("unpublish from another project", removed.structuredContent?.removed === false, removed.structuredContent);
expect("B still served", (await fetch(B.url)).status === 200, B.url);

await open.c.close();
await closed.c.close();
server.close();
if (fail.length) {
  console.error("FAIL:\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log("ok: each preview in an opaque origin in Chromium, Firefox and WebKit; nothing of the host's, nor of another preview, in reach; the bad zips refused");
