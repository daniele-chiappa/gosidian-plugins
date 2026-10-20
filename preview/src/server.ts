// gosidian-preview: a gosidian plugin that serves the static build of a
// branch (a zip, as exec makes it) at an address no one guesses, until it
// expires, each preview in an opaque origin of its own; and tries it with a
// Playwright server. Two ports: MCP at /mcp (Streamable HTTP, stateless,
// the bearer of gosidian) and GET /health on PORT (8000); the previews at
// /p/<id>/ and /health on PREVIEW_HTTP_PORT (8080), for the browsers. The
// plugin runs nothing of a zip: it unpacks files and serves them.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { formatDuration, hostOf, loadPreset, type Preset } from "./preset.ts";
import { Store } from "./store.ts";
import { listen } from "./http.ts";
import { check, Gate, inputSchemas, list, NodeError, outputSchemas, publish, unpublish, type Env, type Result } from "./nodes.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
// VERSION is the plugin's: the image's, else package.json's.
export const VERSION: string = process.env.PLUGIN_VERSION || pkg.version;

const MAX_REQUEST = 4 << 20;
const SWEEP_EVERY = 3600_000;

export function log(msg: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(JSON.stringify({ time: new Date().toISOString(), msg, ...fields }) + "\n");
}

function int(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name}: ${v} is not a whole number`);
  return n;
}

const DESCRIPTIONS: Record<string, (p: Preset) => string> = {
  publish: (p) =>
    `Serves the static build in a zip (its files at the root, index.html among them) at an address of its own under ${p.public_url || "the plugin's public_url"}/p/, until it expires (default ${formatDuration(p.limits.ttl)}, at most ${formatDuration(p.limits.max_ttl)}); whoever has the address opens it. A zip with links, paths outside it or types the preset does not serve is refused`,
  check: () =>
    "Opens a preview of the project in a browser (a Playwright server) and does what a person would: goto, click, fill, select, press, wait_for, expect_text, expect_count, screenshot. It gives back each step's result, the page's console errors and warnings, the failed requests and the screenshots",
  unpublish: () => "Removes a preview of the project before it expires",
  list: () => "The live previews of the project, with their addresses and expiries",
};

export function manifest(p: Preset): Record<string, unknown> {
  const inputs = inputSchemas(p);
  return {
    name: p.name,
    version: VERSION,
    gosidian: 1,
    description: p.description,
    nodes: (["publish", "check", "unpublish", "list"] as const).map((n) => ({
      name: n,
      tool: n,
      description: DESCRIPTIONS[n](p),
      ...(n === "publish" ? { files: ["site"], file_refs: true } : {}),
      input_schema: inputs[n],
      output_schema: outputSchemas[n],
    })),
    permissions: { files: true, network: ["gosidian", ...(p.playwright.ws_endpoint ? [hostOf(p.playwright.ws_endpoint)] : [])] },
  };
}

export interface App {
  mcp: http.Server;
  http: http.Server;
  store: Store;
  sweep(): void;
  close(): Promise<void>;
}

export interface StartOptions {
  preset: Preset;
  token: string;
  port: number;
  httpPort: number;
  maxChecks?: number;
  now?: () => number;
  // sweepEvery: 0, no sweep but at start (the tests sweep by hand).
  sweepEvery?: number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

const NODES: Record<string, (env: Env, args: Record<string, unknown>, meta: Record<string, unknown>, signal: AbortSignal) => Promise<Result>> = {
  publish,
  check,
  unpublish: (env, a, m) => unpublish(env, a, m),
  list: (env, a, m) => list(env, a, m),
};

export async function start(o: StartOptions): Promise<App> {
  const preset = o.preset;
  const lg = o.log ?? log;
  const store = new Store(preset.store_dir, { now: o.now, log: lg });
  store.open();
  const sweep = () => {
    try {
      store.sweep();
    } catch (e) {
      lg("sweep failed", { error: (e as Error).message });
    }
  };
  sweep();
  const env: Env = { preset, store, log: lg, checks: new Gate(o.maxChecks ?? 2) };
  const man = manifest(preset);
  const tools = (man.nodes as any[]).map((n) => {
    const schema = structuredClone(n.input_schema);
    // gosidian hands a reference in site's place.
    if (n.name === "publish") schema.properties.site = {};
    return { name: n.tool, description: n.description, inputSchema: schema };
  });

  const mcp = () => {
    const s = new Server({ name: "gosidian-preview", version: VERSION }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "gosidian_manifest", description: "The plugin's manifest, for gosidian", inputSchema: { type: "object", properties: {} } }, ...tools],
    }));
    s.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const name = req.params.name;
      if (name === "gosidian_manifest") return { content: [{ type: "text", text: JSON.stringify(man) }], structuredContent: man };
      const node = Object.hasOwn(NODES, name) ? NODES[name] : undefined;
      if (!node) return { isError: true, content: [{ type: "text", text: `no tool ${name}` }] };
      const meta = (req.params._meta ?? {}) as Record<string, unknown>;
      const t0 = Date.now();
      try {
        const r = await node(env, (req.params.arguments ?? {}) as Record<string, unknown>, meta, extra.signal);
        return {
          structuredContent: r.output,
          content: [
            { type: "text" as const, text: r.text },
            ...(r.files ?? []).map((f) => ({
              type: "resource" as const,
              resource: { uri: `file:///${encodeURIComponent(f.name)}`, mimeType: f.mime, blob: f.data.toString("base64") },
            })),
          ],
        };
      } catch (e) {
        const msg = (e as Error).message;
        lg(e instanceof NodeError ? `${name} refused` : `${name} error`, { project: meta["gosidian/project"] ?? null, run: meta["gosidian/run"] ?? null, error: msg, seconds: (Date.now() - t0) / 1000 });
        return { isError: true, content: [{ type: "text", text: e instanceof NodeError ? msg : `internal error: ${msg}` }] };
      }
    });
    return s;
  };

  const mcpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", plugin: "preview", name: preset.name, version: VERSION, previews: store.count }));
        return;
      }
      if (url.pathname !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      if (o.token) {
        const got = Buffer.from(req.headers.authorization ?? "");
        const want = Buffer.from(`Bearer ${o.token}`);
        if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
          res.writeHead(401).end("unauthorized");
          return;
        }
      }
      let body: unknown;
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        let n = 0;
        for await (const c of req) {
          n += c.length;
          if (n > MAX_REQUEST) {
            res.writeHead(413).end("too large");
            return;
          }
          chunks.push(c);
        }
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const s = mcp();
      res.on("close", () => {
        void transport.close();
        void s.close();
      });
      await s.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(400, { "content-type": "text/plain" }).end(`bad request: ${(e as Error).message}`);
    }
  });
  // A check may take minutes, a publish fetches a zip.
  mcpServer.requestTimeout = 15 * 60_000;
  await new Promise<void>((ok) => mcpServer.listen(o.port, ok));
  const httpServer = await listen({ store, preset }, o.httpPort);
  const every = o.sweepEvery ?? SWEEP_EVERY;
  const timer = every > 0 ? setInterval(sweep, every) : undefined;
  timer?.unref();
  const closeServer = (s: http.Server) =>
    new Promise<void>((ok) => {
      s.close(() => ok());
      s.closeAllConnections();
    });
  return {
    mcp: mcpServer,
    http: httpServer,
    store,
    sweep,
    close: async () => {
      if (timer) clearInterval(timer);
      await Promise.all([closeServer(mcpServer), closeServer(httpServer)]);
    },
  };
}

async function main(): Promise<void> {
  const file = process.env.PREVIEW_PRESET || "/etc/gosidian-preview/preset.yaml";
  const preset = loadPreset(file, Boolean(process.env.PREVIEW_PRESET));
  const port = int("PORT", 8000);
  const httpPort = int("PREVIEW_HTTP_PORT", 8080);
  if (process.getuid?.() === 0) log("running as root: the plugin needs no privilege, run it as a user (the image's is node, 1000)", {});
  const app = await start({
    preset,
    token: process.env.GOSIDIAN_PLUGIN_TOKEN ?? "",
    port,
    httpPort,
    maxChecks: Math.max(1, int("PREVIEW_MAX_CHECKS", 2)),
  });
  log("gosidian-preview ready", {
    name: preset.name, version: VERSION, port, http_port: httpPort, public_url: preset.public_url || null, store: preset.store_dir,
    previews: app.store.count, connect: preset.connect, playwright: preset.playwright.ws_endpoint || null, token: Boolean(process.env.GOSIDIAN_PLUGIN_TOKEN),
  });
  if (!preset.public_url) log("no PREVIEW_PUBLIC_URL (nor public_url in the preset): publish and check will fail", {});
  const stop = () => {
    void app.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv[2] === "healthcheck") {
    fetch(`http://127.0.0.1:${process.env.PORT || 8000}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1));
  } else {
    main().catch((e) => {
      log("gosidian-preview failed to start", { error: (e as Error).message });
      process.exit(1);
    });
  }
}
