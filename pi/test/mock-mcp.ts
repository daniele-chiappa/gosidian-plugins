// A fake of gosidian's MCP for the tests: Streamable HTTP, stateless, one
// tool (memory_get) that answers with the note's path. It records the
// Authorization header and the method of every request, and answers 401
// to every one when told to.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface MockMCP {
  url: string;
  seen: { auth: string; method: string; tool?: string }[];
  close(): Promise<void>;
}

export async function mockMCP(opts: { status?: number; host?: string; port?: number } = {}): Promise<MockMCP> {
  const seen: MockMCP["seen"] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    seen.push({ auth: String(req.headers.authorization ?? ""), method: body?.method ?? req.method ?? "", ...(body?.params?.name ? { tool: body.params.name } : {}) });
    if (opts.status) return void res.writeHead(opts.status, { "content-type": "application/json" }).end('{"error":"invalid token"}');
    if (req.method !== "POST") return void res.writeHead(405).end();
    const s = new Server({ name: "mock-gosidian", version: "0" }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "memory_get", description: "Read a note of the project", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } }],
    }));
    s.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: "text", text: `the note ${String(r.params.arguments?.path)}: hello` }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void t.close();
      void s.close();
    });
    await s.connect(t);
    await t.handleRequest(req, res, body);
  });
  await new Promise<void>((ok) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${!opts.host || opts.host === "0.0.0.0" ? "127.0.0.1" : opts.host}:${port}/mcp`,
    seen,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}
