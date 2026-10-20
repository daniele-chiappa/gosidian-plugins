// The plugin as gosidian sees it: the bearer, the manifest, publish with a
// file by reference, the project of every call (list, unpublish and check
// see only the call's project), the refusals, the store's room, the sweep.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/store.ts";
import { fileServer, preset, publishSite, raw, site, startApp, zip } from "./helpers.ts";

test("gosidian's view: bearer, health, manifest, tools", async () => {
  const t = await startApp(preset("playwright: {ws_endpoint: 'ws://pw.example:3000/'}\n"));
  try {
    assert.equal((await fetch(t.mcpURL, { method: "POST", body: "{}" })).status, 401);
    const health = await (await fetch(t.mcpURL.replace(/\/mcp$/, "/health"))).json();
    assert.deepEqual({ ...health, version: "-" }, { status: "ok", plugin: "preview", name: "preview-test", version: "-", previews: 0 });
    // The previews' port answers its own health, and nothing about the plugin.
    assert.deepEqual(JSON.parse((await raw(t.httpURL, "/health")).body), { status: "ok" });
    // The MCP endpoint is not on the previews' port.
    assert.equal((await raw(t.httpURL, "/mcp")).status, 404);
    const c = await t.client();
    assert.deepEqual((await c.listTools()).tools.map((x) => x.name), ["gosidian_manifest", "publish", "check", "unpublish", "list"]);
    const man: any = (await c.callTool({ name: "gosidian_manifest", arguments: {} })).structuredContent;
    assert.equal(man.name, "preview-test");
    assert.equal(man.gosidian, 1);
    assert.deepEqual(man.nodes.map((n: any) => [n.name, n.tool, n.files ?? null, n.file_refs ?? null]), [
      ["publish", "publish", ["site"], true],
      ["check", "check", null, null],
      ["unpublish", "unpublish", null, null],
      ["list", "list", null, null],
    ]);
    assert.deepEqual(man.permissions, { files: true, network: ["gosidian", "pw.example:3000"] });
    assert.equal(man.nodes[1].input_schema.properties.steps.maxItems, 50);
    assert.deepEqual(man.nodes[1].input_schema.properties.steps.items.properties.action.enum, ["goto", "click", "fill", "select", "press", "wait_for", "expect_text", "expect_count", "screenshot"]);
  } finally {
    await t.close();
  }
});

test("publish: the output, meta.json, and what it refuses", async () => {
  const t = await startApp(preset("limits: {max_ttl: 10d, max_bytes: 1MiB, max_total_bytes: 3MiB}\n"));
  const files = await fileServer();
  try {
    const c = await t.client();
    const r = await t.call(c, "publish", { site: files.ref("site.zip", zip(site())), ttl: "3d", title: "Piano di 3 giorni" });
    assert.ok(!r.isError, r.content?.[0]?.text);
    const o = r.structuredContent;
    assert.deepEqual(Object.keys(o).sort(), ["bytes", "expires_at", "files", "id", "title", "url"]);
    assert.equal(o.files, 3);
    assert.equal(Date.parse(o.expires_at) - t.clock.now, 3 * 86400_000);
    assert.match(r.content[0].text, /^published 3 files \(\d+ bytes\) at http:\/\/127\.0\.0\.1:\d+\/p\/[a-z2-7]{26}\/, until /);
    const meta = JSON.parse(fs.readFileSync(path.join(t.preset.store_dir, o.id, "meta.json"), "utf8"));
    assert.deepEqual({ ...meta, created: "-", expires: "-" }, { id: o.id, project: "demo", run: "r1", title: "Piano di 3 giorni", created: "-", expires: "-", bytes: o.bytes, files: 3, index: "index.html", spa: false });
    // The zip and the work folder are gone.
    assert.deepEqual(fs.readdirSync(t.preset.store_dir), [o.id]);

    const refuse = async (args: Record<string, unknown>, why: RegExp, project: string | null = "demo") => {
      const x = await t.call(c, "publish", args, project);
      assert.equal(x.isError, true, JSON.stringify(x.structuredContent));
      assert.match(x.content[0].text, why);
    };
    const good = () => files.ref("site.zip", zip(site()));
    await refuse({ site: good() }, /names no project/, null);
    await refuse({ site: good(), ttl: "11d" }, /with\.ttl 11d: more than the preset's 10d/);
    await refuse({ site: good(), ttl: "soon" }, /not a duration/);
    await refuse({ site: good(), index: "../x.html" }, /with\.index "\.\.\/x\.html": a \.\. in the path/);
    await refuse({ site: good(), index: "app.js" }, /not a page/);
    await refuse({ site: good(), extra: 1 }, /must NOT have additional properties/);
    await refuse({ site: "notes/site.zip" }, /not a file gosidian handed by reference/);
    await refuse({ site: [good(), good()] }, /one zip, not 2 files/);
    await refuse({ site: files.ref("site.zip", zip(site()), { sha256: "0".repeat(64) }) }, /its SHA-256 differs/);
    await refuse({ site: files.ref("site.zip", zip(site()), { size: 10 }) }, /bytes came, gosidian said 10/);
    await refuse({ site: files.ref("site.zip", zip(site([{ name: "../evil.js", data: "x" }]))) }, /^site: the zip has an entry outside its folder/);
    await refuse({ site: files.ref("site.zip", zip(site([{ name: "l.txt", data: "/etc/passwd", mode: 0o120777 }]))) }, /^site: l\.txt: a symbolic link/);
    // Nothing of the refused ones is left.
    assert.deepEqual(fs.readdirSync(t.preset.store_dir), [o.id]);

    // Without public_url, nothing is published.
    const url = t.preset.public_url;
    t.preset.public_url = "";
    await refuse({ site: good() }, /set PREVIEW_PUBLIC_URL/);
    t.preset.public_url = url;
  } finally {
    await files.close();
    await t.close();
  }
});

test("the store's room: refused when full, room again when the expired go", async () => {
  const t = await startApp(preset("limits: {max_bytes: 1MiB, max_total_bytes: 2MiB, max_ratio: 2000}\n"));
  const files = await fileServer();
  try {
    const c = await t.client();
    const big = (n: number) => site([{ name: "big.txt", data: Buffer.alloc(n, 120) }]);
    const a = await publishSite(t, c, files, big(900 << 10), { ttl: "1h" });
    await publishSite(t, c, files, big(900 << 10));
    const r = await t.call(c, "publish", { site: files.ref("site.zip", zip(big(900 << 10))) });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /the store has [\d.]+ KiB left, the zip unpacks to [\d.]+ KiB \(limits\.max_total_bytes\)/);
    t.clock.now += 3600_001;
    // The expired one is swept before the room is counted.
    await publishSite(t, c, files, big(900 << 10));
    assert.equal(fs.existsSync(path.join(t.preset.store_dir, a.id)), false);
  } finally {
    await files.close();
    await t.close();
  }
});

test("projects: list, unpublish and check see only the call's project", async () => {
  const t = await startApp(preset("playwright: {ws_endpoint: 'ws://127.0.0.1:9/'}\n"));
  const files = await fileServer();
  try {
    const c = await t.client();
    const a1 = await publishSite(t, c, files, site(), { title: "uno" }, "alpha");
    t.clock.now += 1000;
    const a2 = await publishSite(t, c, files, site(), { title: "due", ttl: "1h" }, "alpha");
    const b1 = await publishSite(t, c, files, site(), { title: "beta" }, "beta");
    const listOf = async (p: string) => (await t.call(c, "list", {}, p)).structuredContent.previews;
    const la = await listOf("alpha");
    assert.deepEqual(la.map((x: any) => x.title), ["due", "uno"]);
    assert.deepEqual(Object.keys(la[0]).sort(), ["bytes", "created_at", "expires_at", "files", "id", "title", "url"]);
    assert.equal(la[1].url, a1.url);
    assert.deepEqual((await listOf("beta")).map((x: any) => x.id), [b1.id]);
    assert.deepEqual(await listOf("gamma"), []);
    const nolist = await t.call(c, "list", {}, null);
    assert.match(nolist.content[0].text, /names no project/);

    // Another project's preview: not removed, the same answer as none.
    const other = await t.call(c, "unpublish", { id: b1.id }, "alpha");
    assert.deepEqual(other.structuredContent, { removed: false });
    assert.equal((await raw(t.httpURL, `/p/${b1.id}/`)).status, 200);
    const none = await t.call(c, "unpublish", { id: "a".repeat(26) }, "alpha");
    assert.deepEqual(none.structuredContent, { removed: false });
    assert.equal(other.content[0].text.replace(b1.id, "X"), none.content[0].text.replace("a".repeat(26), "X"));
    assert.match((await t.call(c, "unpublish", { id: "../x" }, "alpha")).content[0].text, /must match pattern/);

    // check: another project's preview, an address outside the previews,
    // an address of another origin, a preview that does not live: refused
    // before any browser.
    const refused = async (args: Record<string, unknown>, why: RegExp, project = "alpha") => {
      const x = await t.call(c, "check", args, project);
      assert.equal(x.isError, true, JSON.stringify(x.structuredContent));
      assert.match(x.content[0].text, why);
    };
    await refused({ id: b1.id }, new RegExp(`no live preview ${b1.id} in this project`));
    await refused({ url: b1.url }, new RegExp(`no live preview ${b1.id} in this project`));
    await refused({ url: `${a1.url}../${b1.id}/index.html` }, new RegExp(`no live preview ${b1.id} in this project`));
    await refused({ url: "http://169.254.169.254/latest/meta-data/" }, /not an address of a preview/);
    await refused({ url: `${t.preset.public_url}/health` }, /not an address of a preview/);
    await refused({ url: `http://evil.example/p/${a1.id}/` }, /not an address of a preview/);
    await refused({ url: a1.url.replace("http://", "http://user:pw@") }, /not an address of a preview/);
    await refused({ url: "javascript:alert(1)" }, /not an address of a preview/);
    await refused({ id: a1.id, url: a2.url }, /name two previews/);
    await refused({}, /id or url/);
    await refused({ id: a1.id, steps: [{ action: "hover", selector: "a" }] }, /steps\[0\]: an action of goto, click/);
    await refused({ id: a1.id, steps: [{ action: "fill", selector: "#a" }] }, /steps\[0\] \(fill\): value, a text/);
    await refused({ id: a1.id, steps: [{ action: "wait_for" }] }, /steps\[0\] \(wait_for\): a selector or a text/);
    await refused({ id: a1.id, steps: Array.from({ length: 51 }, () => ({ action: "screenshot" })) }, /must NOT have more than 50 items/);
    t.clock.now += 3600_001;
    await refused({ id: a2.id }, new RegExp(`no live preview ${a2.id} in this project`));
    // A check of the project's own live preview gets as far as the browser.
    await refused({ id: a1.id }, /the Playwright server ws:\/\/127\.0\.0\.1:9\/ did not take the connection/);

    // The project's own preview: removed, then gone.
    const mine = await t.call(c, "unpublish", { id: a1.id }, "alpha");
    assert.deepEqual(mine.structuredContent, { removed: true });
    assert.equal((await raw(t.httpURL, `/p/${a1.id}/`)).status, 404);
    // The expired one, not swept yet, is removed too.
    assert.deepEqual((await t.call(c, "unpublish", { id: a2.id }, "alpha")).structuredContent, { removed: true });
    assert.deepEqual(fs.readdirSync(t.preset.store_dir).sort(), [b1.id]);
  } finally {
    await files.close();
    await t.close();
  }
});

test("the sweep at start: what a stopped publish left, previews without meta, the expired; the rest kept", async () => {
  const p = preset();
  const dir = p.store_dir;
  const t = await startApp(p);
  const files = await fileServer();
  let live: string;
  let old: string;
  try {
    const c = await t.client();
    live = (await publishSite(t, c, files, site())).id;
    old = (await publishSite(t, c, files, site(), { ttl: "60s" })).id;
  } finally {
    await files.close();
    await t.app.close();
  }
  const id = "b".repeat(26);
  fs.mkdirSync(path.join(dir, `${id}.tmp`, "site"), { recursive: true });
  fs.writeFileSync(path.join(dir, `${"c".repeat(26)}.zip`), "half");
  fs.mkdirSync(path.join(dir, "d".repeat(26)));
  fs.writeFileSync(path.join(dir, "not-ours.txt"), "kept");
  const logs: string[] = [];
  const s = new Store(dir, { now: () => Date.now() + 120_000, log: (m) => logs.push(m) });
  s.open();
  assert.equal(s.sweep(), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), [live, "not-ours.txt"].sort());
  assert.ok(s.get(live));
  assert.equal(s.get(old), undefined);
  assert.deepEqual(logs, ["a preview without a valid meta.json: removed", "preview expired: removed"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
