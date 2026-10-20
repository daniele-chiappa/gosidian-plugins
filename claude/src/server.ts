// gosidian-claude: a gosidian plugin whose nodes run Claude Code headless
// on the files a pipeline hands it, and keep its version. One container is
// one agent: its preset names the endpoints (Anthropic's, with a
// subscription's token or an API key, and others that speak the Messages
// API: OpenRouter, Ollama, vLLM), the models on each, the effort levels,
// the tools it may allow and the limits of a step. Claude Code is not in
// the image: the plugin installs it from npm into its volume. MCP at /mcp
// (Streamable HTTP, stateless), GET /health.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  aliasesOf, isAnthropic, loadPreset, readSecrets, runOutputOf, runSchema, updateOutput, updateSchema, usageOutput, usageSchema, versionOutput, versionSchema,
  type Preset,
} from "./preset.ts";
import { CONTRACT, META } from "./kit/contract.ts";
import { hostsOf } from "./kit/repos.ts";
import { AnthropicProxy, upstreamsOf } from "./proxy.ts";
import { ClaudeProber, runStep, StepError, VERSION, type Env } from "./run.ts";
import { Subscription } from "./subscription.ts";
import { origin, StepLog, stepOf } from "./steps.ts";
import { Versions, type Installer, type Registry } from "./versions.ts";
import { NPM_REGISTRY, NpmInstaller, NpmRegistry } from "./npm.ts";

export { VERSION };

const MAX_REQUEST = 16 << 20;
// The system prompt of the plugin's own requests with a subscription's
// token (a ping for the limits), as Claude Code's.
const PING_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

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

interface Operation {
  name: string;
  access: "read" | "write";
  description: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  files?: boolean;
  // contract is the common contract the node keeps.
  contract?: string;
  // mcp: the node takes gosidian's MCP for a call (its setting mcp).
  mcp?: boolean;
}

export function operations(p: Preset): Operation[] {
  return [
    {
      name: "run",
      access: "write",
      description: `Runs Claude Code (${p.name}) headless on a task and the files it names, on a model of the preset: it answers with text or JSON, and gives back the files it writes`,
      input: runSchema(p),
      output: runOutputOf(p),
      files: true,
      contract: CONTRACT,
      ...(p.mcp.length ? { mcp: true } : {}),
    },
    {
      name: "version",
      access: "read",
      description: "The version of Claude Code in use, the newest on npm, whether an update is available, the models its aliases resolve to, and the API's models",
      input: versionSchema,
      output: versionOutput,
    },
    {
      name: "update",
      access: "write",
      description: "Installs a version of Claude Code aside (the newest by default), probes each alias of the preset with a prompt of one word, and with switch makes it the version in use: the steps running end first",
      input: updateSchema,
      output: updateOutput,
    },
    {
      name: "usage",
      access: "read",
      description: "How much of the subscription's session (5 hours) and week is used and left, and when each resets (not applicable without one); and the last steps run, each with its model, endpoint, tokens and cost",
      input: usageSchema,
      output: usageOutput,
    },
  ];
}

export function manifest(p: Preset, registry = NPM_REGISTRY): Record<string, unknown> {
  const ops = operations(p);
  const files = (o: Operation) => (o.files ? { files: ["files"], file_refs: true } : {});
  return {
    name: p.name,
    version: VERSION,
    gosidian: 1,
    description: p.description,
    nodes: ops.map((o) => ({ name: o.name, tool: o.name, description: o.description, ...(o.contract ? { contract: o.contract } : {}), ...(o.mcp ? { mcp: true } : {}), ...files(o), input_schema: o.input, output_schema: o.output })),
    tools: ops.map((o) => ({ name: o.name, access: o.access, description: o.description, ...files(o), input_schema: o.input, output_schema: o.output })),
    permissions: {
      files: true,
      network: [...new Set(["gosidian", ...Object.values(p.endpoints).map((e) => new URL(e.url).host), ...hostsOf(p.repos), new URL(registry).host])],
      ...(p.mcp.length ? { mcp: p.mcp } : {}),
    },
  };
}

// Slots runs the steps a few at a time (CLAUDE_WORKERS), in arrival order.
export class Slots {
  private busy = 0;
  private queue: (() => void)[] = [];
  private free: number[] = [];
  private n: number;
  constructor(n: number) {
    this.n = n;
  }
  // take waits for a slot: its index, and how to give it back.
  async take(signal?: AbortSignal): Promise<{ slot: number; release: () => void }> {
    if (this.busy >= this.n) {
      await new Promise<void>((ok, fail) => {
        const go = () => ok();
        this.queue.push(go);
        signal?.addEventListener("abort", () => {
          this.queue = this.queue.filter((q) => q !== go);
          fail(new StepError("the call was canceled while waiting for a free slot"));
        }, { once: true });
      });
    }
    this.busy++;
    const slot = this.free.length ? this.free.pop()! : this.busy - 1;
    return {
      slot,
      release: () => {
        this.free.push(slot);
        this.busy--;
        this.queue.shift()?.();
      },
    };
  }
  async with<T>(fn: (slot: number) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const s = await this.take(signal);
    try {
      return await fn(s.slot);
    } finally {
      s.release();
    }
  }
  get running(): number {
    return this.busy;
  }
}

export interface App {
  server: http.Server;
  proxy: AnthropicProxy;
  versions: Versions;
  subscription: Subscription;
  steps: StepLog;
  close(): Promise<void>;
}

export interface StartOptions {
  preset: Preset;
  // credentials are the endpoints' keys, by name.
  credentials: Record<string, string>;
  token: string;
  port: number;
  workers: number;
  versionsDir: string;
  keepVersions?: number;
  // keepSteps is how many of the last steps usage gives (CLAUDE_KEEP_STEPS).
  keepSteps?: number;
  installer?: Installer;
  registry?: Registry;
  registryUrl?: string;
  env: Omit<Env, "preset" | "proxy" | "versions" | "subscription">;
}

export async function start(opts: StartOptions): Promise<App> {
  const { preset } = opts;
  const elog = opts.env.log;
  const endpoints = Object.values(preset.endpoints);
  // The subscription's endpoint, and the one of Anthropic's the plugin asks
  // for the API's models.
  const oauth = endpoints.find((e) => e.auth === "oauth");
  const anthropic = oauth ?? endpoints.find(isAnthropic);
  let subscription: Subscription | undefined;
  const proxy = new AnthropicProxy(upstreamsOf(preset, opts.credentials), { log: elog, onHeaders: (h) => subscription?.note(h) });
  await proxy.listen();
  const slots = new Slots(opts.workers);
  const steps = new StepLog({ file: path.join(opts.versionsDir, "steps.json"), keep: opts.keepSteps, log: elog });
  // env is filled in below: the prober runs steps with it.
  const env = { ...opts.env, preset, proxy } as Env;
  const versions = new Versions({
    dir: opts.versionsDir,
    installer: opts.installer ?? new NpmInstaller({ registry: opts.registryUrl, checkUser: opts.env.agentUid !== undefined ? { uid: 65534, gid: 65534 } : undefined, log: elog }),
    prober: new ClaudeProber(env, (fn) => slots.with(fn)),
    registry: opts.registry ?? new NpmRegistry(opts.registryUrl),
    channel: preset.version,
    aliases: aliasesOf(preset),
    ...(anthropic ? {} : { noProbe: "the preset has no Anthropic endpoint (auth oauth or api_key): no alias to probe, and no list of the API's models" }),
    keep: opts.keepVersions,
    log: elog,
  });

  const listModels = async (endpoint: string): Promise<{ id: string; display_name?: string; effort: string[] }[]> => {
    const r = await proxy.call(endpoint, "GET", "/v1/models?limit=100");
    if (!r.ok) throw new Error(`the API answered ${r.status}`);
    const body: any = await r.json();
    return (Array.isArray(body?.data) ? body.data : []).map((m: any) => {
      const e = m?.capabilities?.effort;
      const levels = e?.supported ? Object.keys(e).filter((k) => k !== "supported" && e[k]?.supported) : [];
      return { id: String(m.id), ...(m.display_name ? { display_name: String(m.display_name) } : {}), effort: levels };
    });
  };
  // pingModel is the cheapest model the plugin knows: haiku as the version
  // in use resolves it, else the API's.
  const pingModel = async (endpoint: string): Promise<string> => {
    const cur = versions.current();
    const aliases = Object.values((cur && versions.meta(cur)?.probe?.aliases) || {});
    const known = aliases.find((m) => m.includes("haiku")) ?? aliases[0];
    if (known) return known;
    const ids = (await listModels(endpoint)).map((m) => m.id);
    const id = ids.find((m) => m.includes("haiku")) ?? ids[0];
    if (!id) throw new Error("the API lists no model");
    return id;
  };
  subscription = new Subscription({
    kind: oauth ? "oauth" : anthropic ? "api_key" : "none",
    usage: async () => {
      const r = await proxy.call(oauth!.name, "GET", "/api/oauth/usage");
      let body: unknown = null;
      try {
        body = await r.json();
      } catch {
        // no JSON
      }
      return { status: r.status, body };
    },
    ping: async () => {
      const r = await proxy.call(oauth!.name, "POST", "/v1/messages", { model: await pingModel(oauth!.name), max_tokens: 1, system: PING_SYSTEM, messages: [{ role: "user", content: "ok" }] });
      await r.arrayBuffer();
      if (!r.ok) throw new Error(`the API answered ${r.status}`);
    },
    log: elog,
  });
  env.versions = versions;
  env.subscription = subscription;

  const man = manifest(preset, opts.registryUrl);
  const ops = operations(preset);
  const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
  const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
  const check = (o: Operation, args: Record<string, unknown>) => {
    let v = compiled.get(o.name);
    if (!v) compiled.set(o.name, (v = ajv.compile(o.input)));
    const s = structuredClone(args);
    if (!v(s)) throw new StepError(ajv.errorsText(v.errors, { dataVar: "with" }));
    return s as any;
  };
  const toolSchema = (o: Operation): any => {
    const s: any = structuredClone(o.input);
    // gosidian hands the files by reference: the tool takes what it gets.
    if (o.files) s.properties.files = {};
    return s;
  };

  const handlers: Record<string, (args: Record<string, unknown>, meta: Record<string, unknown> | undefined, signal: AbortSignal) => Promise<{ output: any; files?: { name: string; mime: string; data: Buffer }[] }>> = {
    run: async (args, meta, signal) => {
      const left = meta?.[META.tokensLeft];
      const t0 = Date.now();
      let res: Awaited<ReturnType<typeof runStep>>;
      try {
        res = await slots.with((slot) => runStep(env, args, typeof left === "number" ? left : undefined, signal, slot, meta), signal);
      } catch (e) {
        const model = typeof args.model === "string" ? args.model : undefined;
        const endpoint = preset.models.find((m) => m.name === model)?.endpoint;
        const repo = (args.repo as { name?: unknown } | undefined)?.name;
        steps.add({ at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 100) / 10, ...origin(meta), ...(model ? { model } : {}), ...(endpoint ? { endpoint } : {}), ...(typeof repo === "string" ? { repo: { name: repo } } : {}), error: (e as Error).message.slice(0, 300) });
        throw e;
      }
      const o: any = res.output;
      steps.add(stepOf(o, meta, t0, Date.now()));
      elog("step done", { model: o.model?.id, endpoint: o.model?.endpoint, effort: o.effort?.applied, turns: o.turns, tokens: o.usage.total_tokens, cost: o.cost, files: res.files.length, ...(o.repo ? { repo: o.repo.name, commit: o.repo.commit ?? null } : {}), ...(o.mcp ? { mcp: o.mcp.level } : {}), seconds: (Date.now() - t0) / 1000 });
      return res;
    },
    version: async (args) => {
      check(ops[1], args);
      const info: Record<string, unknown> = await versions.info();
      info.models = [];
      if (anthropic) {
        try {
          info.models = await listModels(anthropic.name);
        } catch (e) {
          info.models_error = (e as Error).message;
        }
      }
      return { output: info };
    },
    update: async (args) => {
      const s = check(ops[2], args);
      return { output: await versions.update(s.version, s.switch) };
    },
    usage: async (args) => {
      const s = check(ops[3], args);
      if (s.since !== undefined && Number.isNaN(Date.parse(s.since))) throw new StepError(`since ${JSON.stringify(s.since)} is not a time (2026-10-16T07:00:00Z)`);
      const info = await subscription!.read(s.max_age * 1000);
      return { output: { ...info, min_left_percent: preset.limits.min_left_percent, steps: steps.list(s.steps, s.since) } };
    },
  };

  const mcp = () => {
    const s = new Server({ name: "gosidian-claude", version: VERSION }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: "gosidian_manifest", description: "The plugin's manifest, for gosidian", inputSchema: { type: "object", properties: {} } },
        ...ops.map((o) => ({ name: o.name, description: o.description, inputSchema: toolSchema(o) })),
      ],
    }));
    s.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const name = req.params.name;
      if (name === "gosidian_manifest") {
        return { content: [{ type: "text", text: JSON.stringify(man) }], structuredContent: man };
      }
      const h = handlers[name];
      if (!h) return { isError: true, content: [{ type: "text", text: `no tool ${name}` }] };
      const t0 = Date.now();
      try {
        const res = await h((req.params.arguments ?? {}) as Record<string, unknown>, req.params._meta as Record<string, unknown> | undefined, extra.signal);
        const files = res.files ?? [];
        return {
          structuredContent: res.output,
          content: [
            { type: "text", text: name === "run" ? String(res.output.text ?? "") : JSON.stringify(res.output) },
            ...files.map((f) => ({
              type: "resource" as const,
              resource: { uri: `file:///${encodeURIComponent(f.name)}`, mimeType: f.mime, blob: f.data.toString("base64") },
            })),
          ],
        };
      } catch (e) {
        const msg = (e as Error).message;
        elog(e instanceof StepError ? `${name} failed` : `${name} error`, { error: msg, seconds: (Date.now() - t0) / 1000 });
        return { isError: true, content: [{ type: "text", text: e instanceof StepError ? msg : `internal error: ${msg}` }] };
      }
    });
    return s;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          status: "ok", plugin: "claude", agent: preset.name, version: VERSION,
          claude_code: versions.current(), state: versions.phase, ...(versions.error ? { error: versions.error } : {}),
          running: slots.running,
        }));
        return;
      }
      if (url.pathname !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      if (opts.token) {
        const got = Buffer.from(req.headers.authorization ?? "");
        const want = Buffer.from(`Bearer ${opts.token}`);
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
  // An update installs and probes for minutes: the request may last.
  server.requestTimeout = 0;
  await new Promise<void>((ok) => server.listen(opts.port, ok));
  return {
    server,
    proxy,
    versions,
    subscription,
    steps,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((ok) => server.close(() => ok(undefined)));
      await proxy.close();
    },
  };
}

// installLoop installs the preset's version when none is in use, and tries
// again after a failure: a minute later, then less often (30 minutes at most).
function installLoop(versions: Versions, delayMs = 60_000): void {
  versions.ensure().catch((e) => {
    log("installing Claude Code failed: trying again", { error: (e as Error).message, in_seconds: delayMs / 1000 });
    setTimeout(() => installLoop(versions, Math.min(delayMs * 2, 30 * 60_000)), delayMs).unref();
  });
}

async function main(): Promise<void> {
  const presetFile = process.env.CLAUDE_PRESET || "/etc/gosidian-claude/preset.yaml";
  const preset = loadPreset(presetFile);
  const credentials = readSecrets(preset);
  const root = process.getuid?.() === 0;
  if (!root) log("not root: Claude Code runs as the server's user, and its tools could read the credential and the server's environment", {});
  const workers = Math.max(1, int("CLAUDE_WORKERS", 1));
  // The image has a user per slot: 10001 to 10008.
  if (root && workers > 8) throw new Error(`CLAUDE_WORKERS ${workers}: at most 8, one user each`);
  const runsDir = process.env.CLAUDE_RUNS_DIR || "/tmp/gosidian-claude";
  fs.mkdirSync(runsDir, { recursive: true });
  fs.chmodSync(runsDir, 0o711);
  const versionsDir = process.env.CLAUDE_VERSIONS_DIR || "/var/lib/gosidian-claude";
  const port = int("PORT", 8000);
  const app = await start({
    preset,
    credentials,
    token: process.env.GOSIDIAN_PLUGIN_TOKEN ?? "",
    port,
    workers,
    versionsDir,
    keepVersions: int("CLAUDE_KEEP_VERSIONS", 3),
    keepSteps: int("CLAUDE_KEEP_STEPS", 200),
    registryUrl: process.env.CLAUDE_NPM_REGISTRY || NPM_REGISTRY,
    env: {
      runsDir,
      ...(root ? { agentUid: int("CLAUDE_UID", 10001), agentGid: int("CLAUDE_GID", 10001) } : {}),
      maxFilesBytes: int("CLAUDE_MAX_FILES_BYTES", 256 << 20),
      maxOutFiles: int("CLAUDE_MAX_OUT_FILES", 50),
      maxOutBytes: int("CLAUDE_MAX_OUT_BYTES", 50 << 20),
      log,
    },
  });
  log("gosidian-claude ready", {
    agent: preset.name, version: VERSION, port, endpoints: Object.values(preset.endpoints).map((e) => `${e.name} (${e.auth})`), models: preset.models.map((m) => m.name),
    tools: preset.tools.allowed, claude_code: app.versions.current(), channel: preset.version, separate_user: root,
    token: Boolean(process.env.GOSIDIAN_PLUGIN_TOKEN),
  });
  installLoop(app.versions);
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
      log("gosidian-claude failed to start", { error: (e as Error).message });
      process.exit(1);
    });
  }
}
