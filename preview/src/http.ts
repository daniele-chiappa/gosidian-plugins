// The previews' HTTP server, on a port of its own: GET and HEAD of
// /p/<id>/<path>, and /health. Every answer, a 404 too, carries the same
// headers: a CSP sandbox without allow-same-origin, so each page runs in an
// opaque origin of its own (no cookies, no storage, no DOM of another page
// of this origin, a preview or not); nosniff; no referrer; no-store; CORS
// open, with no credentials, for the module scripts and the fetches of a
// page whose origin is "null". An id that is not live, a path that is not a
// file, a path that tries to leave the preview: the same 404.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { Preset } from "./preset.ts";
import { ID, type Store } from "./store.ts";
import { typeOf } from "./zip.ts";

const SANDBOX = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads";
// What a page loads (scripts, styles, images, fonts, frames): its origin,
// inline, data: and blob:. eval is allowed: the sandbox isolates, and
// builds that need it (template compilers, WebAssembly) would break.
const LOAD = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:";
const NOT_FOUND = "not found\n";
// A host as a CSP source takes it: a name or an IPv4 address, a port.
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})(?::\d{1,5})?$/;

// sources are the origins (and the path of public_url) the page was
// reached at: public_url's, and the request's Host. A CSP's 'self' in
// connect-src matches nothing in an opaque origin for WebKit, so a
// preview's own files are named by their address.
export function sources(p: Preset, req: http.IncomingMessage): string[] {
  const out = new Set<string>();
  if (p.public_url) out.add(p.public_url);
  const host = String(req.headers.host ?? "");
  if (HOST.test(host)) {
    const fwd = String(req.headers["x-forwarded-proto"] ?? "");
    let proto = fwd === "https" || fwd === "http" ? fwd : "http";
    if (!fwd && p.public_url) {
      const pub = new URL(p.public_url);
      if (pub.host === host.toLowerCase()) proto = pub.protocol.slice(0, -1);
    }
    out.add(`${proto}://${host.toLowerCase()}`);
  }
  return [...out];
}

// csp is the Content-Security-Policy of an answer. connect open: a page's
// scripts call any host; self: only the preview's own files (and so do its
// forms).
export function csp(p: Preset, req: http.IncomingMessage, id?: string): string {
  if (p.connect === "open") return `${SANDBOX}; ${LOAD}; connect-src * data: blob:`;
  const own = id ? sources(p, req).map((s) => `${s}/p/${id}/`).join(" ") : "";
  return `${SANDBOX}; ${LOAD}; connect-src ${own ? own + " " : "'none' "}data: blob:; form-action ${own || "'none'"}`;
}

export function headers(p: Preset, req: http.IncomingMessage, id?: string): Record<string, string> {
  return {
    "content-security-policy": csp(p, req, id),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "cross-origin-resource-policy": "cross-origin",
    "access-control-allow-origin": "*",
    "x-robots-tag": "noindex, nofollow",
  };
}

// segments decodes the path after /p/<id>/: each part decoded once, and
// refused when empty, . or .., or holding a slash, a backslash or a control
// character, encoded or not. The last part empty means a folder.
export function segments(rest: string): { parts: string[]; dir: boolean } | null {
  if (rest === "") return { parts: [], dir: true };
  const raw = rest.split("/");
  const dir = raw[raw.length - 1] === "";
  if (dir) raw.pop();
  const parts: string[] = [];
  for (const r of raw) {
    let s: string;
    try {
      s = decodeURIComponent(r);
    } catch {
      return null;
    }
    if (s === "" || s === "." || s === ".." || /[/\\\x00-\x1f\x7f]/.test(s)) return null;
    parts.push(s);
  }
  return { parts, dir };
}

export interface ServeOptions {
  store: Store;
  preset: Preset;
}

// openFile opens a regular file of the preview, not through a link, and
// only inside its folder.
function openFile(root: string, rel: string): { fd: number; size: number } | null {
  const full = path.join(root, rel);
  const r = path.relative(root, full);
  if (!r || r.startsWith("..") || path.isAbsolute(r)) return null;
  let fd: number;
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    const real = fs.realpathSync(full);
    if (!st.isFile() || !real.startsWith(fs.realpathSync(root) + path.sep)) {
      fs.closeSync(fd);
      return null;
    }
    return { fd, size: st.size };
  } catch {
    fs.closeSync(fd);
    return null;
  }
}

// kind is what a path of the preview is, not through a link.
function kind(root: string, rel: string): "dir" | "file" | "" {
  try {
    const st = fs.lstatSync(path.join(root, rel));
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : "";
  } catch {
    return "";
  }
}

export function handler(o: ServeOptions): http.RequestListener {
  const { store, preset } = o;
  return (req, res) => {
    const raw = req.url ?? "/";
    const q = raw.search(/[?#]/);
    const p = q >= 0 ? raw.slice(0, q) : raw;
    const m = /^\/p\/([^/]*)(\/.*)?$/.exec(p);
    const id = m && ID.test(m[1]) ? m[1] : undefined;
    const h = headers(preset, req, id);
    const send = (status: number, body: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, { ...h, "content-type": "text/plain; charset=utf-8", "content-length": String(Buffer.byteLength(body)), ...extra });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "method not allowed\n", { allow: "GET, HEAD" });
    if (p === "/health") {
      const body = JSON.stringify({ status: "ok" });
      res.writeHead(200, { ...h, "content-type": "application/json", "content-length": String(body.length) });
      return void res.end(req.method === "HEAD" ? undefined : body);
    }
    if (!m || !id) return send(404, NOT_FOUND);
    // /p/<id> without its slash: the preview's root, whatever the id; the
    // answer says nothing of whether it lives.
    if (m[2] === undefined) return send(301, "", { location: `${id}/` });
    const meta = store.get(id);
    const seg = segments(m[2].slice(1));
    if (!meta || !seg) return send(404, NOT_FOUND);
    const root = store.siteDir(id);
    let rel = seg.parts.length === 0 ? meta.index : seg.parts.join("/") + (seg.dir ? "/index.html" : "");
    if (!seg.dir && seg.parts.length && kind(root, rel) === "dir" && kind(root, rel + "/index.html") === "file") {
      // A folder named without its slash: to it, so its page's relative
      // addresses resolve inside it.
      return send(301, "", { location: `${encodeURIComponent(seg.parts[seg.parts.length - 1])}/` });
    }
    let f = typeOf(rel, preset.types) ? openFile(root, rel) : null;
    if (!f && meta.spa && !path.posix.extname(seg.parts[seg.parts.length - 1] ?? "")) {
      // A client-side route: the app's page.
      rel = meta.index;
      f = openFile(root, rel);
    }
    if (!f) return send(404, NOT_FOUND);
    const { fd, size } = f;
    res.writeHead(200, { ...h, "content-type": typeOf(rel, preset.types), "content-length": String(size) });
    if (req.method === "HEAD") {
      fs.closeSync(fd);
      return void res.end();
    }
    const s = fs.createReadStream("", { fd });
    s.on("error", () => res.destroy());
    s.pipe(res);
  };
}

export async function listen(o: ServeOptions, port: number, host?: string): Promise<http.Server> {
  const server = http.createServer(handler(o));
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  await new Promise<void>((ok) => (host ? server.listen(port, host, ok) : server.listen(port, ok)));
  return server;
}
