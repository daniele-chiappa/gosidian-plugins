// The reply page, on a port of its own: GET /r/<token> shows the question,
// who answers (the token's person) and the choices; only POST /r/<token>
// decides, since mail scanners and link previews open the links they find.
// Every answer is no-store, noindex, no-referrer (the token is in the
// address), and has a strict CSP: no script at all, the one style by its
// hash, forms only to the page itself, no frames. The texts are the
// preset's. Nothing else is served: no index, no listing.
import http from "node:http";
import crypto from "node:crypto";
import type { Env } from "./dispatch.ts";
import { close, decide, statusText } from "./questions.ts";
import type { Question } from "./store.ts";
import { escapeHTML, fill } from "./text.ts";

const STYLE =
  "body{font:17px/1.45 system-ui,sans-serif;margin:0;background:#f6f6f4;color:#1d1d1b}" +
  "main{max-width:34rem;margin:0 auto;padding:1.5rem 1rem}h1{font-size:1.3rem;margin:0 0 .75rem}" +
  ".text{white-space:pre-wrap;overflow-wrap:anywhere}.who{color:#5c5c58;font-size:.95rem}" +
  "form{display:flex;flex-wrap:wrap;gap:.6rem;margin:1.25rem 0}" +
  "button{flex:1 1 9rem;font:inherit;padding:.8rem 1rem;border-radius:.5rem;border:1px solid #8a8a85;background:#fff;color:inherit}" +
  "button.first{background:#1f5f3f;border-color:#1f5f3f;color:#fff}.status{font-weight:600}" +
  "a{color:#1b4f8a;overflow-wrap:anywhere}" +
  "@media (prefers-color-scheme:dark){body{background:#1b1b1a;color:#ececea}.who{color:#a8a8a3}button{background:#2a2a28;border-color:#6f6f6a}a{color:#8ab8f0}}";
const STYLE_HASH = crypto.createHash("sha256").update(STYLE).digest("base64");
const CSP = `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; img-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
const MAX_BODY = 1024;

export const HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

function page(env: Env, o: { title: string; q?: Question; person?: string; status?: string; buttons?: boolean }): string {
  const s = env.preset.strings;
  const q = o.q;
  const parts: string[] = [`<h1>${escapeHTML(o.title)}</h1>`];
  if (q?.text) parts.push(`<p class="text">${escapeHTML(q.text)}</p>`);
  if (q?.link) parts.push(`<p><a href="${escapeHTML(q.link)}" rel="noreferrer noopener" target="_blank">${escapeHTML(s.open_link)}</a></p>`);
  if (o.person) parts.push(`<p class="who">${escapeHTML(fill(s.answering_as, { person: o.person }))}</p>`);
  if (q && o.buttons) {
    parts.push(
      `<form method="post">${q.choices
        .map((c, i) => `<button type="submit" name="choice" value="${i}"${i === 0 ? ' class="first"' : ""}>${escapeHTML(c)}</button>`)
        .join("")}</form>`,
    );
  }
  if (o.status) parts.push(`<p class="status">${escapeHTML(o.status)}</p>`);
  return (
    `<!doctype html><html lang="${escapeHTML(s.lang)}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">` +
    `<meta name="referrer" content="no-referrer"><title>${escapeHTML(o.title)}</title><style>${STYLE}</style></head>` +
    `<body><main>${parts.join("")}</main></body></html>\n`
  );
}

async function readBody(req: http.IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > MAX_BODY) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function handler(env: Env): http.RequestListener {
  return async (req, res) => {
    const s = env.preset.strings;
    const send = (status: number, body: string, type = "text/html; charset=utf-8", extra: Record<string, string> = {}) => {
      res.writeHead(status, { ...HEADERS, "content-type": type, "content-length": String(Buffer.byteLength(body)), ...extra });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const raw = req.url ?? "/";
    const p = raw.split(/[?#]/)[0];
    if (p === "/health" && (req.method === "GET" || req.method === "HEAD")) return send(200, JSON.stringify({ status: "ok" }), "application/json");
    if (p === "/robots.txt" && (req.method === "GET" || req.method === "HEAD")) return send(200, "User-agent: *\nDisallow: /\n", "text/plain; charset=utf-8");
    const m = /^\/r\/([^/]+)$/.exec(p);
    if (!m) return send(404, page(env, { title: s.not_found }));
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") return send(405, page(env, { title: s.not_found }), undefined, { allow: "GET, HEAD, POST" });
    const found = env.store.byToken(m[1]);
    if (!found) return send(404, page(env, { title: s.not_found }));
    const { q, person } = found;
    if (q.status === "open" && q.expires <= env.now()) close(env, q, "expired");
    const closed = (status: number) => send(status, page(env, { title: q.title || s.page_title, q, status: statusText(env, q) }));
    if (q.status !== "open") return closed(q.status === "decided" ? (req.method === "POST" ? 409 : 200) : 410);
    if (req.method !== "POST") return send(200, page(env, { title: q.title || s.page_title, q, person, buttons: true }));
    const body = await readBody(req);
    const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    const choice = body !== null && type === "application/x-www-form-urlencoded" ? new URLSearchParams(body).get("choice") : null;
    const index = choice !== null && /^[0-3]$/.test(choice) ? Number(choice) : -1;
    if (index < 0 || index >= q.choices.length) return send(400, page(env, { title: q.title || s.page_title, q, person, buttons: true }));
    const r = decide(env, q, person, index, "page");
    if (!r.ok) return closed(r.status === "decided" ? 409 : r.status === "open" ? 403 : 410);
    send(200, page(env, { title: q.title || s.page_title, q, status: fill(s.recorded, { choice: r.choice }) }));
  };
}

export async function listen(env: Env, port: number, host?: string): Promise<http.Server> {
  const server = http.createServer(handler(env));
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  await new Promise<void>((ok) => (host ? server.listen(port, host, ok) : server.listen(port, ok)));
  return server;
}
