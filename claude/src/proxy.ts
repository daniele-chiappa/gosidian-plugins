// The API Claude Code talks to: a proxy on 127.0.0.1 (ANTHROPIC_BASE_URL)
// that forwards a step's requests to the endpoint of its model. Claude Code
// holds only a key of its step (ANTHROPIC_API_KEY, sent as x-api-key), so
// the subscription's token, or an endpoint's key, never enters its process
// (whose tools can read files and /proc). The proxy puts the endpoint's
// credential in place of the step's key, keeps a step within its token
// budget, counts its usage, notes the effort and the model of each request,
// and hands the subscription's rate-limit headers to whoever keeps them. An
// endpoint other than Anthropic's gets the step's model in every message,
// and the proxy answers the token count and the list of models itself; a
// model without effort gets none. It logs methods, paths and statuses,
// never a header.
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { rateLimitHeaderNames } from "./subscription.ts";
import { isAnthropic, type Auth, type Preset } from "./preset.ts";

export interface Upstream {
  // name is the preset's name of the endpoint.
  name: string;
  url: string;
  auth: Auth;
  // credential is the endpoint's key; "" with auth none.
  credential: string;
  headers?: Record<string, string>;
  // models are the preset's models on the endpoint: the proxy lists them
  // for an endpoint other than Anthropic's.
  models?: { name: string; id: string }[];
}

// upstreamsOf are the preset's endpoints with their keys, by name.
export function upstreamsOf(p: Preset, keys: Record<string, string>): Upstream[] {
  return Object.values(p.endpoints).map((e) => ({
    name: e.name,
    url: e.url,
    auth: e.auth,
    credential: keys[e.name] ?? "",
    headers: e.headers,
    models: p.models.filter((m) => m.endpoint === e.name).map((m) => ({ name: m.name, id: m.id })),
  }));
}

// OAUTH_BETA is the beta the API asks of a request with a subscription's
// token.
export const OAUTH_BETA = "oauth-2025-04-20";

// Tokens are the usage of an answer, by kind.
export interface Tokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface Grant {
  // endpoint is the name of the step's endpoint.
  endpoint: string;
  // model is the step's model as a compatible endpoint knows it: every
  // message goes to it, whatever model Claude Code names (a background
  // task's, say).
  model?: string;
  // noEffort: the model takes no effort level, and Claude Code sends one
  // all the same (2.1.304, to a model it does not know): the proxy drops it.
  noEffort?: boolean;
  // left is the tokens the step may still use.
  left(): number;
  usage(total: number, tokens: Tokens): void;
  // seen notes a message request: its model and its effort (null: none).
  seen?(model: string, effort: string | null): void;
}

export interface ProxyOptions {
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  // onHeaders gets the headers of every answer of a subscription's
  // endpoint (auth oauth).
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
  private upstreams = new Map<string, Upstream>();
  private opts: ProxyOptions;
  private namesLogged = false;

  constructor(upstreams: Upstream[], opts: ProxyOptions = {}) {
    for (const u of upstreams) this.upstreams.set(u.name, { ...u, url: u.url.replace(/\/+$/, "") });
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

  private upstream(name: string): Upstream {
    const u = this.upstreams.get(name);
    if (!u) throw new Error(`the proxy has no endpoint ${name}`);
    return u;
  }

  // grant opens the proxy to one step: its key, and how to revoke it.
  grant(g: Grant): { key: string; revoke(): void } {
    this.upstream(g.endpoint);
    const key = "sk-step-" + crypto.randomBytes(24).toString("base64url");
    this.grants.set(key, g);
    return { key, revoke: () => this.grants.delete(key) };
  }

  // headers are the request's headers for an endpoint: its own headers,
  // and its credential in place of the step's key.
  private headers(up: Upstream, from: http.IncomingHttpHeaders | Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(from)) {
      if (v === undefined || DROP_REQUEST.has(k.toLowerCase())) continue;
      h[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    h["accept-encoding"] = "identity";
    for (const [k, v] of Object.entries(up.headers ?? {})) h[k.toLowerCase()] = v;
    switch (up.auth) {
      case "oauth":
        h.authorization = `Bearer ${up.credential}`;
        h["anthropic-beta"] = mergeBeta(h["anthropic-beta"], OAUTH_BETA);
        break;
      case "api_key":
        h["x-api-key"] = up.credential;
        break;
      case "bearer":
        h.authorization = `Bearer ${up.credential}`;
        break;
    }
    return h;
  }

  // noteHeaders hands on the headers of a subscription's answers.
  private noteHeaders(up: Upstream, h: Headers): void {
    if (up.auth !== "oauth") return;
    if (!this.namesLogged) {
      const names = rateLimitHeaderNames(h);
      if (names.length) {
        this.namesLogged = true;
        this.log("the API's rate-limit headers", { names });
      }
    }
    this.opts.onHeaders?.(h);
  }

  // call is a request of the plugin's own to an endpoint (the models, a
  // ping), with its credential.
  async call(endpoint: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const up = this.upstream(endpoint);
    const r = await fetch(up.url + path, {
      method,
      headers: this.headers(up, { "anthropic-version": "2023-06-01", ...(body !== undefined ? { "content-type": "application/json" } : {}) }),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    this.noteHeaders(up, r.headers);
    return r;
  }

  // local answers what a compatible endpoint is not asked: the token count
  // (404: Claude Code then estimates) and the list of the preset's models.
  // false when the request goes on.
  private local(up: Upstream, method: string, path: string, res: http.ServerResponse): boolean {
    if (isAnthropic(up)) return false;
    if (path === "/v1/messages/count_tokens") {
      apiError(res, 404, "not_found_error", `the endpoint ${up.name} counts no tokens: estimate them`);
      return true;
    }
    if (method !== "GET" || !path.startsWith("/v1/models")) return false;
    const list = (up.models ?? []).map((m) => ({ type: "model", id: m.name, display_name: m.id, created_at: "1970-01-01T00:00:00Z" }));
    if (path === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: list, has_more: false, first_id: list[0]?.id ?? null, last_id: list.at(-1)?.id ?? null }));
      return true;
    }
    const one = list.find((m) => m.id === decodeURIComponent(path.slice("/v1/models/".length)));
    if (one) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(one));
    else apiError(res, 404, "not_found_error", "no such model");
    return true;
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
    const up = this.upstream(g.endpoint);
    if (this.local(up, req.method ?? "", path, res)) return;
    let raw = req.method === "POST" ? await readBody(req) : undefined;
    const messages = path === "/v1/messages";
    if (messages) {
      let body: any = {};
      try {
        body = raw && raw.length ? JSON.parse(raw.toString("utf8")) : {};
      } catch {
        return apiError(res, 400, "invalid_request_error", "the request is not JSON");
      }
      // 400, not 429: Claude Code retries a 429, and the budget will not come back.
      if (g.left() <= 0) return apiError(res, 400, "invalid_request_error", "the step used its token budget (its max_tokens, or the run's max_llm_tokens)");
      const asked = String(body?.model ?? "");
      let changed = false;
      if (g.model && body && typeof body === "object" && body.model !== g.model) {
        body.model = g.model;
        changed = true;
      }
      const oc = body?.output_config;
      if (g.noEffort && oc && typeof oc === "object" && "effort" in oc) {
        delete oc.effort;
        if (!Object.keys(oc).length) delete body.output_config;
        changed = true;
      }
      if (changed) raw = Buffer.from(JSON.stringify(body));
      const effort = body?.output_config?.effort;
      g.seen?.(asked, typeof effort === "string" ? effort : null);
    }
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    const upr = await fetch(up.url + req.url, {
      method: req.method,
      headers: this.headers(up, req.headers),
      body: raw ? new Uint8Array(raw) : undefined,
      signal: ac.signal,
      redirect: "error",
    });
    this.noteHeaders(up, upr.headers);
    const out: Record<string, string> = {};
    upr.headers.forEach((v, k) => {
      if (!DROP_RESPONSE.has(k)) out[k] = v;
    });
    res.writeHead(upr.status, out);
    const counter = messages ? new MessageUsage(upr.headers.get("content-type") ?? "") : undefined;
    if (upr.body) {
      for await (const chunk of upr.body) {
        counter?.push(chunk);
        res.write(chunk);
      }
    }
    res.end();
    if (upr.status >= 400) this.log("the API refused a request", { endpoint: up.name, method: req.method, path, status: upr.status });
    const total = counter?.total() ?? 0;
    if (total > 0) g.usage(total, counter!.tokens());
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

  // tokens are the usage by kind, once total has read the end.
  tokens(): Tokens {
    return { ...this.u };
  }
}
