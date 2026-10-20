// gosidian-notify: a gosidian plugin that notifies the people and rooms of
// its preset (a Telegram chat or a topic of a group, an ntfy topic, an
// email address) from a pipeline, and takes their answer to a question
// back to the run. Two ports: MCP at /mcp (Streamable HTTP, stateless, the
// bearer of gosidian) and GET /health on PORT (8000); the reply page at
// /r/<token> and /health on NOTIFY_HTTP_PORT (8080), for the people's
// browsers. A ticker sends the digests of the quiet hours and the counts of
// the grouped keys, expires the questions and tries again the answers
// gosidian has not taken yet.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { formatDuration, hostsOfPreset, loadPreset, type ChannelName, type Preset } from "./preset.ts";
import { loadSecrets, redact, redactAll, type Secrets } from "./secrets.ts";
import { Store } from "./store.ts";
import { closeGroups, release, type Env } from "./dispatch.ts";
import { onCallback, questionOutgoing, sweep } from "./questions.ts";
import { ask, cancel, configured, inputSchemas, NodeError, outputSchemas, send, type Result } from "./nodes.ts";
import { listen } from "./page.ts";
import type { Channel } from "./channels/channel.ts";
import { Telegram } from "./channels/telegram.ts";
import { Ntfy } from "./channels/ntfy.ts";
import { Email } from "./channels/email.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
// VERSION is the plugin's: the image's, else package.json's.
export const VERSION: string = process.env.PLUGIN_VERSION || pkg.version;

const MAX_REQUEST = 1 << 20;
const TICK_EVERY = 15_000;

// log writes a line of JSON on stderr, every secret taken out.
export function log(msg: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(JSON.stringify({ time: new Date().toISOString(), msg: redact(msg), ...redactAll(fields) }) + "\n");
}

function int(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name}: ${v} is not a whole number`);
  return n;
}

const DESCRIPTIONS: Record<string, (p: Preset) => string> = {
  send: (p) =>
    `Notifies people, groups and rooms of the preset on their channels (${configured(p).join(", ")}): plain text, cut to each channel's length. In quiet hours low and normal wait for one digest; the same key within ${formatDuration(p.limits.group_window)} is counted, not sent again`,
  ask: (p) =>
    `Asks a choice of 2 to 4 (the first the positive one) and POSTs the first valid answer to the run's resume_url, for a wait.call: Telegram's buttons, or a link to the plugin's reply page on ntfy and email. Only the people of to, or the approvers, answer; it waits ${formatDuration(p.limits.expires)} by default`,
  cancel: () => "Withdraws an open question of the project (decided elsewhere): its links stop working, its buttons say so",
};

export function manifest(p: Preset): Record<string, unknown> {
  const inputs = inputSchemas(p);
  return {
    name: p.name,
    version: VERSION,
    gosidian: 1,
    description: p.description,
    nodes: (["send", "ask", "cancel"] as const).map((n) => ({
      name: n,
      tool: n,
      description: DESCRIPTIONS[n](p),
      input_schema: inputs[n],
      output_schema: outputSchemas[n],
    })),
    permissions: { files: false, network: hostsOfPreset(p) },
  };
}

export interface App {
  mcp: http.Server;
  http: http.Server;
  env: Env;
  // tick does at once what the ticker does.
  tick(): Promise<void>;
  close(): Promise<void>;
}

export interface StartOptions {
  preset: Preset;
  secrets?: Secrets;
  token: string;
  port: number;
  httpPort: number;
  now?: () => number;
  // tickEvery: 0, no ticker (the tests tick by hand).
  tickEvery?: number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

type Node = (env: Env, args: Record<string, unknown>, meta: Record<string, unknown>, signal: AbortSignal) => Promise<Result>;
const NODES: Record<string, Node> = { send, ask, cancel: (env, a, m) => cancel(env, a, m) };

export async function start(o: StartOptions): Promise<App> {
  const preset = o.preset;
  const raw = o.log ?? log;
  const lg = (m: string, f: Record<string, unknown> = {}) => raw(redact(m), redactAll(f));
  const secrets = o.secrets ?? loadSecrets(preset);
  const store = new Store(preset.store_dir, lg);
  store.open();
  const channels: Partial<Record<ChannelName, Channel>> = {};
  const env: Env = { preset, store, channels, log: lg, now: o.now ?? Date.now };
  if (preset.channels.telegram) {
    env.telegram = new Telegram({ preset, token: secrets.telegram_token, store, log: lg, onCallback: (cq) => onCallback(env, cq) });
    channels.telegram = env.telegram;
  }
  if (preset.channels.ntfy) channels.ntfy = new Ntfy(preset, secrets.ntfy_token);
  if (preset.channels.email) channels.email = new Email(preset, secrets.smtp_user, secrets.smtp_password);

  const man = manifest(preset);
  const tools = (man.nodes as any[]).map((n) => ({ name: n.tool, description: n.description, inputSchema: n.input_schema }));

  const mcp = () => {
    const s = new Server({ name: "gosidian-notify", version: VERSION }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "gosidian_manifest", description: "The plugin's manifest, for gosidian", inputSchema: { type: "object", properties: {} } }, ...tools],
    }));
    s.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const name = req.params.name;
      if (name === "gosidian_manifest") return { content: [{ type: "text", text: JSON.stringify(man) }], structuredContent: man };
      const node = Object.hasOwn(NODES, name) ? NODES[name] : undefined;
      if (!node) return { isError: true, content: [{ type: "text", text: `no tool ${name}` }] };
      const meta = (req.params._meta ?? {}) as Record<string, unknown>;
      try {
        const r = await node(env, (req.params.arguments ?? {}) as Record<string, unknown>, meta, extra.signal);
        const output = redactAll(r.output);
        return { structuredContent: output, content: [{ type: "text" as const, text: redact(r.text) }] };
      } catch (e) {
        const msg = redact((e as Error).message);
        lg(e instanceof NodeError ? `${name} refused` : `${name} error`, { project: meta["gosidian/project"] ?? null, run: meta["gosidian/run"] ?? null, error: msg });
        return { isError: true, content: [{ type: "text", text: e instanceof NodeError ? msg : `internal error: ${msg}` }] };
      }
    });
    return s;
  };

  const mcpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/health") {
        const d = store.data;
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ status: "ok", plugin: "notify", name: preset.name, version: VERSION, channels: configured(preset), open_questions: Object.values(d.questions).filter((q) => q.status === "open").length, held: d.held.length }),
        );
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
      if (!res.headersSent) res.writeHead(400, { "content-type": "text/plain" }).end(`bad request: ${redact((e as Error).message)}`);
    }
  });
  mcpServer.requestTimeout = 5 * 60_000;
  await new Promise<void>((ok) => mcpServer.listen(o.port, ok));
  const httpServer = await listen(env, o.httpPort);

  let ticking: Promise<void> | undefined;
  const tick = () => {
    ticking ??= (async () => {
      for (const [what, fn] of [
        ["release", () => release(env, (q, d) => questionOutgoing(env, q, d))],
        ["groups", () => closeGroups(env)],
        ["questions", () => sweep(env)],
      ] as const) {
        try {
          await fn();
        } catch (e) {
          lg(`tick: ${what} failed`, { error: (e as Error).message });
        }
      }
    })().finally(() => {
      ticking = undefined;
    });
    return ticking;
  };
  // The first tick (what was held while the plugin was down) does not hold
  // up the start.
  void tick();
  const every = o.tickEvery ?? TICK_EVERY;
  const timer = every > 0 ? setInterval(() => void tick(), every) : undefined;
  timer?.unref();
  env.telegram?.start();
  const closeServer = (s: http.Server) =>
    new Promise<void>((ok) => {
      s.close(() => ok());
      s.closeAllConnections();
    });
  return {
    mcp: mcpServer,
    http: httpServer,
    env,
    tick,
    close: async () => {
      if (timer) clearInterval(timer);
      await ticking;
      await env.telegram?.close();
      await Promise.allSettled([...(env.background ?? [])]);
      await Promise.all([closeServer(mcpServer), closeServer(httpServer), ...Object.values(channels).map((c) => c.close?.())]);
    },
  };
}

async function main(): Promise<void> {
  const file = process.env.NOTIFY_PRESET || "/etc/gosidian-notify/preset.yaml";
  const preset = loadPreset(file);
  const port = int("PORT", 8000);
  const httpPort = int("NOTIFY_HTTP_PORT", 8080);
  if (process.getuid?.() === 0) log("running as root: the plugin needs no privilege, run it as a user (the image's is node, 1000)", {});
  const app = await start({ preset, token: process.env.GOSIDIAN_PLUGIN_TOKEN ?? "", port, httpPort });
  log("gosidian-notify ready", {
    name: preset.name, version: VERSION, port, http_port: httpPort, public_url: preset.public_url || null, gosidian: preset.gosidian_api || null,
    store: preset.store_dir, channels: configured(preset), people: Object.keys(preset.people).length, rooms: Object.keys(preset.rooms).length,
    time_zone: preset.time_zone, telegram_updates: preset.channels.telegram ? preset.channels.telegram.poll : null, token: Boolean(process.env.GOSIDIAN_PLUGIN_TOKEN),
  });
  if (!preset.public_url) log("no NOTIFY_PUBLIC_URL (nor public_url in the preset): a question has no link, only Telegram's buttons", {});
  if (!preset.gosidian_api) log("no gosidian_url in the preset: ask is refused, and so is a note", {});
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
      log("gosidian-notify failed to start", { error: (e as Error).message });
      process.exit(1);
    });
  }
}
