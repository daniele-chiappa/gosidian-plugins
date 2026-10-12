// A fake OpenAI-compatible chat endpoint for the tests: it answers with
// the scripted replies in order (text, tool calls, usage), streamed as
// server-sent events when asked, and records every request body.
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Reply {
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  usage?: { prompt: number; completion: number };
  // status answers the request with an HTTP error instead.
  status?: number;
  // delayMs waits before answering, for the timeout tests.
  delayMs?: number;
}

export interface MockLLM {
  url: string;
  requests: any[];
  close(): Promise<void>;
}

export async function mockLLM(script: Reply[] | ((n: number, body: any) => Reply), host = "127.0.0.1", port = 0): Promise<MockLLM> {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const body = raw ? JSON.parse(raw) : {};
      requests.push(body);
      const n = requests.length - 1;
      const r: Reply = typeof script === "function" ? script(n, body) : (script[n] ?? { text: "(no more replies)" });
      if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
      if (r.status) {
        res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "mock error" } }));
        return;
      }
      const usage = { prompt_tokens: r.usage?.prompt ?? 100, completion_tokens: r.usage?.completion ?? 10 };
      const u = { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens };
      const calls = (r.toolCalls ?? []).map((c, i) => ({
        index: i, id: `call_${n}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) },
      }));
      const finish = calls.length ? "tool_calls" : "stop";
      const base = { id: `cmpl-${n}`, object: "chat.completion.chunk", created: 0, model: body.model ?? "m" };
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          ...base, object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: r.text ?? null, tool_calls: calls.length ? calls : undefined }, finish_reason: finish }],
          usage: u,
        }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      if (r.text) send({ ...base, choices: [{ index: 0, delta: { content: r.text }, finish_reason: null }] });
      if (calls.length) send({ ...base, choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
      send({ ...base, choices: [], usage: u });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((ok) => server.listen(port, host, ok));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${addr.port}/v1`,
    requests,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}
