// The previews' HTTP server: the headers on every answer (a 404 and a 405
// too), the types, the index and the SPA fallback, the attempts to leave a
// preview, the methods, the expiry, and no way to list or tell the ids.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ID, newId } from "../src/store.ts";
import { fileServer, preset, publishSite, raw, site, startApp, type Raw } from "./helpers.ts";

const SANDBOX = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads";

function secure(r: Raw, what: string): void {
  assert.match(String(r.headers["content-security-policy"]), new RegExp(`^${SANDBOX}; default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; `), `${what}: CSP ${r.headers["content-security-policy"]}`);
  assert.doesNotMatch(String(r.headers["content-security-policy"]), /allow-same-origin|allow-top-navigation|allow-popups-to-escape-sandbox/, what);
  assert.equal(r.headers["x-content-type-options"], "nosniff", what);
  assert.equal(r.headers["referrer-policy"], "no-referrer", what);
  assert.equal(r.headers["cache-control"], "no-store", what);
  assert.equal(r.headers["cross-origin-resource-policy"], "cross-origin", what);
  assert.equal(r.headers["access-control-allow-origin"], "*", what);
  assert.equal(r.headers["access-control-allow-credentials"], undefined, what);
  assert.equal(r.headers["set-cookie"], undefined, what);
}

test("serving: types, index, folders, headers on every answer", async () => {
  const t = await startApp(preset());
  const files = await fileServer();
  try {
    const c = await t.client();
    const out = await publishSite(t, c, files, site([
      { name: "docs/", mode: 0o040755 },
      { name: "docs/index.html", data: "<p>docs</p>" },
      { name: "img.svg", data: "<svg xmlns='http://www.w3.org/2000/svg'/>" },
      { name: "mod.mjs", data: "export const x = 1;" },
    ]), { title: "App" });
    assert.match(out.id, ID);
    assert.equal(out.url, `${t.preset.public_url}/p/${out.id}/`);
    const p = `/p/${out.id}/`;
    const cases: [string, number, string | undefined][] = [
      [p, 200, "text/html; charset=utf-8"],
      [`${p}index.html`, 200, "text/html; charset=utf-8"],
      [`${p}app.js`, 200, "text/javascript; charset=utf-8"],
      [`${p}mod.mjs`, 200, "text/javascript; charset=utf-8"],
      [`${p}assets/data.json`, 200, "application/json; charset=utf-8"],
      [`${p}img.svg`, 200, "image/svg+xml"],
      [`${p}docs/`, 200, "text/html; charset=utf-8"],
      [`${p}assets/`, 404, undefined],
      [`${p}missing.js`, 404, undefined],
      [`${p}about`, 404, undefined],
      ["/", 404, undefined],
      ["/p/", 404, undefined],
      ["/health", 200, "application/json"],
    ];
    for (const [u, status, type] of cases) {
      const r = await raw(t.httpURL, u);
      assert.equal(r.status, status, u);
      if (type) assert.equal(r.headers["content-type"], type, u);
      secure(r, u);
    }
    assert.equal((await raw(t.httpURL, `${p}assets/data.json`)).body, '{"giorni": 3}\n');
    // A folder without its slash: to it; the preview without its slash: to it.
    const docs = await raw(t.httpURL, `${p}docs`);
    assert.equal(docs.status, 301);
    assert.equal(docs.headers.location, "docs/");
    secure(docs, "redirect");
    const bare = await raw(t.httpURL, `/p/${out.id}`);
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.location, `${out.id}/`);
    // HEAD: the headers, no body.
    const head = await raw(t.httpURL, `${p}app.js`, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.headers["content-length"], String("document.title = 'App ok';\n".length));
    assert.equal(head.body, "");
    secure(head, "HEAD");
    // The query does not change the file.
    assert.equal((await raw(t.httpURL, `${p}app.js?v=2#x`)).status, 200);
  } finally {
    await files.close();
    await t.close();
  }
});

test("only GET and HEAD", async () => {
  const t = await startApp(preset());
  const files = await fileServer();
  try {
    const c = await t.client();
    const { id } = await publishSite(t, c, files, site());
    for (const m of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE"]) {
      const r = await raw(t.httpURL, `/p/${id}/index.html`, m);
      assert.equal(r.status, 405, m);
      assert.equal(r.headers.allow, "GET, HEAD");
      secure(r, m);
    }
    assert.equal((await raw(t.httpURL, "/health", "POST")).status, 405);
  } finally {
    await files.close();
    await t.close();
  }
});

test("the SPA fallback: paths without an extension get the index", async () => {
  const t = await startApp(preset());
  const files = await fileServer();
  try {
    const c = await t.client();
    const spa = await publishSite(t, c, files, site(), { spa: true });
    const plain = await publishSite(t, c, files, site());
    const index = (await raw(t.httpURL, `/p/${spa.id}/`)).body;
    for (const u of ["about", "users/42", "users/42/", "a/b/c"]) {
      const r = await raw(t.httpURL, `/p/${spa.id}/${u}`);
      assert.equal(r.status, 200, u);
      assert.equal(r.body, index, u);
      assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
      assert.equal((await raw(t.httpURL, `/p/${plain.id}/${u}`)).status, 404, u);
    }
    // A missing file with an extension stays a 404, SPA or not.
    assert.equal((await raw(t.httpURL, `/p/${spa.id}/assets/missing.js`)).status, 404);
    assert.equal((await raw(t.httpURL, `/p/${spa.id}/../x`)).status, 404);
  } finally {
    await files.close();
    await t.close();
  }
});

test("no way out of a preview, nor into another", async () => {
  const t = await startApp(preset());
  const files = await fileServer();
  try {
    const c = await t.client();
    const a = await publishSite(t, c, files, site());
    const b = await publishSite(t, c, files, site([{ name: "secret.txt", data: "b's" }]));
    // Something beside the previews, which no path must reach.
    fs.writeFileSync(path.join(t.preset.store_dir, "outside.txt"), "outside");
    const nf = (await raw(t.httpURL, "/nothing")).body;
    const attempts = [
      `/p/${a.id}/../${b.id}/secret.txt`,
      `/p/${a.id}/%2e%2e/${b.id}/secret.txt`,
      `/p/${a.id}/%2E%2E/%2E%2E/outside.txt`,
      `/p/${a.id}/..%2f${b.id}%2fsecret.txt`,
      `/p/${a.id}/..%5c${b.id}%5csecret.txt`,
      `/p/${a.id}/%2e%2e%5c%2e%2e%5coutside.txt`,
      `/p/${a.id}/assets/%2e%2e/%2e%2e/meta.json`,
      `/p/${a.id}/../meta.json`,
      `/p/${a.id}/meta.json`,
      `/p/${a.id}/./index.html`,
      `/p/${a.id}//index.html`,
      `/p/${a.id}/index.html%00.txt`,
      `/p/${a.id}/%252e%252e/outside.txt`,
      `/p/${a.id}/\\..\\outside.txt`,
      `/p/${a.id}/%c0%ae%c0%ae/outside.txt`,
      `/p/${a.id}/%/x`,
      `/p/..%2f..%2fetc%2fpasswd/x`,
      `/p/${a.id.toUpperCase()}/index.html`,
    ];
    for (const u of attempts) {
      const r = await raw(t.httpURL, u);
      assert.equal(r.status, 404, u);
      assert.equal(r.body, nf, u);
      secure(r, u);
    }
    assert.equal((await raw(t.httpURL, `/p/${b.id}/secret.txt`)).body, "b's");
  } finally {
    await files.close();
    await t.close();
  }
});

test("expired, removed and unknown previews: the same 404; ids not enumerable", async () => {
  const t = await startApp(preset());
  const files = await fileServer();
  try {
    const c = await t.client();
    const short = await publishSite(t, c, files, site(), { ttl: "1h" });
    const long = await publishSite(t, c, files, site());
    const gone = await publishSite(t, c, files, site());
    assert.equal((await t.call(c, "unpublish", { id: gone.id })).structuredContent.removed, true);
    assert.equal((await raw(t.httpURL, `/p/${short.id}/`)).status, 200);
    t.clock.now += 3600_000 + 1;
    const nf = await raw(t.httpURL, "/p/aaaaaaaaaaaaaaaaaaaaaaaaaa/");
    assert.equal(nf.status, 404);
    for (const id of [short.id, gone.id, newId(), newId()]) {
      for (const u of [`/p/${id}/`, `/p/${id}/index.html`, `/p/${id}/app.js`]) {
        const r = await raw(t.httpURL, u);
        assert.equal(r.status, 404, u);
        assert.equal(r.body, nf.body);
        assert.deepEqual(Object.keys(r.headers).sort(), Object.keys(nf.headers).sort());
      }
      // Without the slash, any id is sent to its root: no oracle there either.
      assert.equal((await raw(t.httpURL, `/p/${id}`)).status, 301);
    }
    assert.equal((await raw(t.httpURL, `/p/${long.id}/`)).status, 200);
    // The expired one is still on disk until the sweep, which removes it.
    assert.ok(fs.existsSync(path.join(t.preset.store_dir, short.id)));
    t.app.sweep();
    assert.equal(fs.existsSync(path.join(t.preset.store_dir, short.id)), false);
    assert.ok(fs.existsSync(path.join(t.preset.store_dir, long.id)));
    // The ids: 26 characters of base32, all different, nothing in common.
    const ids = new Set(Array.from({ length: 2000 }, () => newId()));
    assert.equal(ids.size, 2000);
    for (const id of ids) assert.match(id, ID);
    const firsts = new Set([...ids].map((i) => i[0]));
    assert.equal(firsts.size, 32);
  } finally {
    await files.close();
    await t.close();
  }
});

test("connect: self names the preview's own folder, by its address and the request's host", async () => {
  const t = await startApp(preset("connect: self\n"));
  const files = await fileServer();
  try {
    const c = await t.client();
    const { id } = await publishSite(t, c, files, site());
    const port = new URL(t.preset.public_url).port;
    const r = await raw(t.httpURL, `/p/${id}/`, "GET", { host: `localhost:${port}` });
    assert.equal(r.status, 200);
    const own = `${t.preset.public_url}/p/${id}/ http://localhost:${port}/p/${id}/`;
    assert.equal(r.headers["content-security-policy"], `${SANDBOX}; default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src ${own} data: blob:; form-action ${own}`);
    // Behind a proxy that says https.
    const tls = await raw(t.httpURL, `/p/${id}/`, "GET", { host: "preview.example.com", "x-forwarded-proto": "https" });
    assert.match(String(tls.headers["content-security-policy"]), new RegExp(` https://preview\\.example\\.com/p/${id}/ data: blob:;`));
    // A host that would write into the policy is left out.
    const evil = await raw(t.httpURL, `/p/${id}/`, "GET", { host: "x; script-src *" });
    assert.equal(evil.headers["content-security-policy"], `${SANDBOX}; default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src ${t.preset.public_url}/p/${id}/ data: blob:; form-action ${t.preset.public_url}/p/${id}/`);
    // Without a preview, nothing to connect to.
    assert.match(String((await raw(t.httpURL, "/nothing")).headers["content-security-policy"]), /connect-src 'none' data: blob:; form-action 'none'$/);
  } finally {
    await files.close();
    await t.close();
  }
});
