// The endpoint pi talks to: a proxy on 127.0.0.1 that forwards a step's
// requests to the preset's endpoint. pi holds only a token of its step, so
// the endpoint's key never enters its process (whose tools can read files
// and /proc). The proxy adds the key and the preset's body (routing),
// keeps a request within the step's token budget, and counts the usage.
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

export interface Upstream {
  baseUrl: string;
  key?: string;
  // body is merged into every request; models, by the request's model,
  // over it.
  body: Record<string, unknown>;
  models?: Record<string, Record<string, unknown>>;
}

export interface Grant {
  // left is the tokens the step may still use.
  left(): number;
  usage(total: number): void;
}

const MAX_BODY = 32 << 20;

export class LLMProxy {
  url = "";
  private server: http.Server;
  private grants = new Map<string, Grant>();
  private upstream: Upstream;

  constructor(upstream: Upstream) {
    this.upstream = upstream;
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) send(res, 502, `the proxy failed: ${(e as Error).message}`);
        else res.destroy();
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((ok) => this.server.listen(0, "127.0.0.1", ok));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  close(): Promise<void> {
    return new Promise((ok) => this.server.close(() => ok()));
  }

  // grant opens the proxy to one step: its token, and how to revoke it.
  grant(g: Grant): { token: string; revoke(): void } {
    const token = crypto.randomBytes(24).toString("base64url");
    this.grants.set(token, g);
    return { token, revoke: () => this.grants.delete(token) };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const auth = req.headers.authorization ?? "";
    const g = this.grants.get(auth.replace(/^Bearer\s+/i, ""));
    if (!g) return send(res, 401, "no such step");
    if (req.method !== "POST" || !req.url?.startsWith("/v1/")) return send(res, 404, "only POST /v1/…");
    const raw = await readBody(req);
    let body: any;
    try {
      body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      return send(res, 400, "the request is not JSON");
    }
    const left = g.left();
    // 400, not 429: pi retries a 429, and the budget will not come back.
    if (left <= 0) return send(res, 400, "the step used its token budget (max_tokens)");
    Object.assign(body, structuredClone(this.upstream.body), structuredClone(this.upstream.models?.[body.model] ?? {}));
    for (const k of ["max_completion_tokens", "max_tokens"]) {
      if (typeof body[k] === "number" && body[k] > left) body[k] = left;
    }
    if (body.stream) body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    const up = await fetch(this.upstream.baseUrl + req.url.slice("/v1".length), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: String(req.headers.accept ?? "application/json, text/event-stream"),
        ...(this.upstream.key ? { authorization: `Bearer ${this.upstream.key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ac.signal,
      redirect: "error",
    });
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
    const counter = new UsageCounter(up.headers.get("content-type") ?? "");
    if (up.body) {
      for await (const chunk of up.body) {
        counter.push(chunk);
        res.write(chunk);
      }
    }
    res.end();
    const total = counter.total();
    if (total > 0) g.usage(total);
  }
}

function send(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message } }));
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

// UsageCounter reads the usage of an answer: the last data: line with a
// usage of a stream, or the usage of a whole JSON body (8 MiB at most).
class UsageCounter {
  private text = "";
  private last = 0;
  private stream: boolean;

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
    const d = l.slice(5).trim();
    if (d && d !== "[DONE]") this.read(d);
  }

  private read(json: string): void {
    try {
      const t = JSON.parse(json)?.usage?.total_tokens;
      if (typeof t === "number") this.last = t;
    } catch {
      // not JSON: nothing to count
    }
  }

  total(): number {
    if (this.stream) this.line(this.text.trim());
    else this.read(this.text);
    return this.last;
  }
}
