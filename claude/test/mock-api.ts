// A fake Anthropic API for the tests: messages (a stream or JSON) with the
// subscription's rate-limit headers, the list of models, and the usage
// endpoint (403 by default, as for a token of claude setup-token). It keeps
// every request it gets, headers included, for the tests to check. With a
// prefix it serves under it, as OpenRouter under /api.
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export interface MockOptions {
  // fiveHour and week are the utilization the headers give (fractions).
  fiveHour?: number;
  week?: number;
  usageStatus?: number;
  usageBody?: unknown;
  messageStatus?: number;
  // prefix is the path the API is under (/api): a request's path is kept
  // whole.
  prefix?: string;
}

// The usage of every answer: 100 + 1000 + 50 + 5 = 1155 tokens.
export const USAGE = { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 5 };
export const RESET_5H = 1792179600;
export const RESET_7D = 1792605600;

export async function mockAPI(o: MockOptions = {}, host = "127.0.0.1", port = 0): Promise<{ url: string; requests: Seen[]; opts: MockOptions; close(): Promise<void> }> {
  const requests: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: any = undefined;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const full = (req.url ?? "/").split("?")[0];
    const path = o.prefix && full.startsWith(o.prefix + "/") ? full.slice(o.prefix.length) : full;
    requests.push({ method: req.method ?? "", path: full, headers: req.headers, body });
    const limits = {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": String(o.fiveHour ?? 0.25),
      "anthropic-ratelimit-unified-5h-reset": String(RESET_5H),
      "anthropic-ratelimit-unified-7d-status": "allowed",
      "anthropic-ratelimit-unified-7d-utilization": String(o.week ?? 0.5),
      "anthropic-ratelimit-unified-7d-reset": String(RESET_7D),
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-reset": String(RESET_5H),
      "request-id": "req_test",
    };
    if (path === "/v1/messages" && req.method === "POST") {
      if (o.messageStatus && o.messageStatus !== 200) {
        res.writeHead(o.messageStatus, { "content-type": "application/json", ...limits });
        return void res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }));
      }
      const model = body?.model ?? "claude-test";
      if (!body?.stream) {
        res.writeHead(200, { "content-type": "application/json", ...limits });
        return void res.end(JSON.stringify({ id: "msg_x", type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: USAGE }));
      }
      res.writeHead(200, { "content-type": "text/event-stream", ...limits });
      const ev = (t: string, d: unknown) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
      ev("message_start", { type: "message_start", message: { id: "msg_x", type: "message", role: "assistant", model, content: [], usage: { ...USAGE, output_tokens: 1 } } });
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
      ev("content_block_stop", { type: "content_block_stop", index: 0 });
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: USAGE.output_tokens } });
      ev("message_stop", { type: "message_stop" });
      return void res.end();
    }
    if (path === "/v1/models" && req.method === "GET") {
      const effort = { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } };
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({
        data: [
          { type: "model", id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", capabilities: { effort } },
          { type: "model", id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", capabilities: { effort: { supported: false } } },
        ],
        has_more: false,
      }));
    }
    if (path === "/api/oauth/usage") {
      res.writeHead(o.usageStatus ?? 403, { "content-type": "application/json" });
      return void res.end(JSON.stringify(o.usageBody ?? { type: "error", error: { type: "permission_error", message: "OAuth token does not meet scope requirement user:profile" } }));
    }
    res.writeHead(404, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((ok) => server.listen(port, host, ok));
  return {
    url: `http://${host}:${(server.address() as AddressInfo).port}`,
    requests,
    opts: o,
    close: () => {
      server.closeAllConnections();
      return new Promise((ok) => server.close(() => ok()));
    },
  };
}
