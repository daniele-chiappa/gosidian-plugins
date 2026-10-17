// The API Claude Code talks to: a proxy on 127.0.0.1 (ANTHROPIC_BASE_URL)
// that forwards a step's requests to the preset's upstream. Claude Code
// holds only a key of its step (ANTHROPIC_API_KEY, sent as x-api-key), so
// the subscription's token, or the API key, never enters its process
// (whose tools can read files and /proc). The proxy puts the credential in
// place of the step's key, keeps a step within its token budget, counts
// its usage, notes the effort and the model of each request, and hands the
// subscription's rate-limit headers to whoever keeps them. It logs methods,
// paths and statuses, never a header.
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { rateLimitHeaderNames } from "./subscription.ts";

export interface Upstream {
  baseUrl: string;
  kind: "oauth" | "api_key";
  credential: string;
}

// OAUTH_BETA is the beta the API asks of a request with a subscription's
// token.
export const OAUTH_BETA = "oauth-2025-04-20";

export interface Grant {
  // left is the tokens the step may still use.
  left(): number;
  usage(total: number): void;
  // seen notes a message request: its model and its effort (null: none).
  seen?(model: string, effort: string | null): void;
}

export interface ProxyOptions {
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  // onHeaders gets the headers of every answer of the upstream.
  onHeaders?: (h: Headers) => void;
}

const MAX_BODY = 32 << 20;

// The requests a step may make: messages (and their token count), and the
// list of models. Anything else (the account's endpoints, say) is refused.
const ALLOWED: [string, RegExp][] = [
  ["POST", /^\/v1\/messages$/],
  ["POST", /^\/v1\/messages\/count_tokens$/],
  ["GET", /^\/v1\/models$/],
  ["GET", /^\/v1\/models\/[A-Za-z0-9._:@-]+$/],
];

const DROP_REQUEST = new Set([
  "host", "connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer",
  "transfer-encoding", "upgrade", "content-length", "x-api-key", "authorization", "cookie", "accept-encoding",
]);
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "set-cookie"]);

// mergeBeta adds a beta to an anthropic-beta header's list, once.
export function mergeBeta(header: string | string[] | undefined, beta: string): string {
  const list = (Array.isArray(header) ? header.join(",") : header ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.includes(beta)) list.push(beta);
  return list.join(",");
}

export class AnthropicProxy {
  url = "";
  private server: http.Server;
  private grants = new Map<string, Grant>();
  private upstream: Upstream;
  private opts: ProxyOptions;
  private namesLogged = false;

  constructor(upstream: Upstream, opts: ProxyOptions = {}) {
    this.upstream = upstream;
    this.opts = opts;
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.log("the proxy failed", { method: req.method, path: pathOf(req.url), error: (e as Error).message });
        if (!res.headersSent) apiError(res, 502, "api_error", "the proxy could not reach the API");
        else res.destroy();
      });
    });
  }

  private log(msg: string, fields: Record<string, unknown> = {}): void {
    this.opts.log?.(msg, fields);
  }

  async listen(): Promise<void> {
    await new Promise<void>((ok) => this.server.listen(0, "127.0.0.1", ok));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close(): Promise<void> {
    this.server.closeAllConnections?.();
    return new Promise((ok) => this.server.close(() => ok()));
  }

  // grant opens the proxy to one step: its key, and how to revoke it.
  grant(g: Grant): { key: string; revoke(): void } {
    const key = "sk-step-" + crypto.randomBytes(24).toString("base64url");
    this.grants.set(key, g);
    return { key, revoke: () => this.grants.delete(key) };
  }

  // headers are the request's headers for the upstream, with the
  // credential in place of the step's key.
  private headers(from: http.IncomingHttpHeaders | Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(from)) {
      if (v === undefined || DROP_REQUEST.has(k.toLowerCase())) continue;
      h[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    h["accept-encoding"] = "identity";
    if (this.upstream.kind === "oauth") {
      h.authorization = `Bearer ${this.upstream.credential}`;
      h["anthropic-beta"] = mergeBeta(h["anthropic-beta"], OAUTH_BETA);
    } else {
      h["x-api-key"] = this.upstream.credential;
    }
    return h;
  }

  private noteHeaders(h: Headers): void {
    if (!this.namesLogged) {
      const names = rateLimitHeaderNames(h);
      if (names.length) {
        this.namesLogged = true;
        this.log("the API's rate-limit headers", { names });
      }
    }
    this.opts.onHeaders?.(h);
  }

  // call is a request of the plugin's own (the models, a ping), with the
  // credential.
  async call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const r = await fetch(this.upstream.baseUrl + path, {
      method,
      headers: this.headers({ "anthropic-version": "2023-06-01", ...(body !== undefined ? { "content-type": "application/json" } : {}) }),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    this.noteHeaders(r.headers);
    return r;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = pathOf(req.url);
    // Claude Code's check of the connection: no credentials, no upstream.
    if (path === "/api/hello" && (req.method === "HEAD" || req.method === "GET")) {
      res.writeHead(200, { "content-type": "application/json" }).end(req.method === "GET" ? "{}" : undefined);
      return;
    }
    const auth = req.headers.authorization ?? "";
    const key = String(req.headers["x-api-key"] ?? (auth.startsWith("Bearer ") ? auth.slice(7) : ""));
    const g = key ? this.grants.get(key) : undefined;
    if (!g) return apiError(res, 401, "authentication_error", "not a key of a running step");
    if (!ALLOWED.some(([m, re]) => m === req.method && re.test(path))) {
      this.log("the proxy refused a request", { method: req.method, path });
      return apiError(res, 404, "not_found_error", `the plugin's proxy does not forward ${req.method} ${path}`);
    }
    const raw = req.method === "POST" ? await readBody(req) : undefined;
    const messages = path === "/v1/messages";
    if (messages) {
      let body: any = {};
      try {
        body = raw && raw.length ? JSON.parse(raw.toString("utf8")) : {};
      } catch {
        return apiError(res, 400, "invalid_request_error", "the request is not JSON");
      }
      // 400, not 429: Claude Code retries a 429, and the budget will not come back.
      if (g.left() <= 0) return apiError(res, 400, "invalid_request_error", "the step used its token budget (the run's max_llm_tokens)");
      const effort = body?.output_config?.effort;
      g.seen?.(String(body?.model ?? ""), typeof effort === "string" ? effort : null);
    }
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    const up = await fetch(this.upstream.baseUrl + req.url, {
      method: req.method,
      headers: this.headers(req.headers),
      body: raw ? new Uint8Array(raw) : undefined,
      signal: ac.signal,
      redirect: "error",
    });
    this.noteHeaders(up.headers);
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => {
      if (!DROP_RESPONSE.has(k)) out[k] = v;
    });
    res.writeHead(up.status, out);
    const counter = messages ? new MessageUsage(up.headers.get("content-type") ?? "") : undefined;
    if (up.body) {
      for await (const chunk of up.body) {
        counter?.push(chunk);
        res.write(chunk);
      }
    }
    res.end();
    if (up.status >= 400) this.log("the API refused a request", { method: req.method, path, status: up.status });
    const total = counter?.total() ?? 0;
    if (total > 0) g.usage(total);
  }
}

function pathOf(url: string | undefined): string {
  return (url ?? "/").split("?")[0];
}

function apiError(res: http.ServerResponse, status: number, type: string, message: string): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type, message } }));
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > MAX_BODY) throw new Error("the request is too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// MessageUsage reads the usage of an answer to a message: message_start's
// and message_delta's of a stream, or the usage of a whole JSON body (8 MiB
// at most). The total counts the input read from the cache and written to
// it too.
export class MessageUsage {
  private text = "";
  private stream: boolean;
  private u = { input: 0, cache_read: 0, cache_write: 0, output: 0 };

  constructor(contentType: string) {
    this.stream = contentType.includes("text/event-stream");
  }

  push(chunk: Uint8Array): void {
    this.text += Buffer.from(chunk).toString("utf8");
    if (!this.stream) {
      if (this.text.length > 8 << 20) this.text = "";
      return;
    }
    let i: number;
    while ((i = this.text.indexOf("\n")) >= 0) {
      this.line(this.text.slice(0, i).trim());
      this.text = this.text.slice(i + 1);
    }
  }

  private line(l: string): void {
    if (!l.startsWith("data:")) return;
    try {
      const ev = JSON.parse(l.slice(5).trim());
      if (ev?.type === "message_start") this.take(ev.message?.usage);
      else if (ev?.type === "message_delta") this.take(ev.usage);
    } catch {
      // not JSON: nothing to count
    }
  }

  private take(u: any): void {
    if (!u || typeof u !== "object") return;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    this.u.input = n(u.input_tokens) ?? this.u.input;
    this.u.cache_read = n(u.cache_read_input_tokens) ?? this.u.cache_read;
    this.u.cache_write = n(u.cache_creation_input_tokens) ?? this.u.cache_write;
    this.u.output = n(u.output_tokens) ?? this.u.output;
  }

  total(): number {
    if (this.stream) this.line(this.text.trim());
    else {
      try {
        this.take(JSON.parse(this.text)?.usage);
      } catch {
        // not JSON
      }
    }
    return this.u.input + this.u.cache_read + this.u.cache_write + this.u.output;
  }
}
