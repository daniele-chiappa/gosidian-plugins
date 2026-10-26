// gosidian-pi: a gosidian plugin whose node runs a pi agent (pi.dev) on the
// files a pipeline hands it, and keeps agent-run/1, the contract of
// gosidian's agents. One container is one agent: its preset names the
// endpoint and its key, the models, the tools it may use, the limits of a
// step, the repositories a step may work on and the access to gosidian's
// MCP it may ask for. With repositories that have pull requests, the node
// pr merges or closes the one a step opened. MCP at /mcp (Streamable HTTP,
// stateless), GET /health.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CONTRACT, META } from "./kit/contract.ts";
import { RepoError } from "./kit/git.ts";
import { prDescription, prOutput, prSchema, pullRequest, type PRRequest } from "./kit/pulls.ts";
import { hostsOfPreset, loadPreset, nodeSchema, outputSchema, type Preset } from "./preset.ts";
import { LLMProxy } from "./proxy.ts";
import { PI_VERSION, runStep, StepError, VERSION, type Env } from "./run.ts";

export { VERSION };

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_REQUEST = 16 << 20;

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

export function manifest(p: Preset): Record<string, unknown> {
  return {
    name: p.name,
    version: VERSION,
    gosidian: 1,
    description: p.description,
    nodes: [
      {
        name: "run",
        tool: "run",
        contract: CONTRACT,
        ...(p.mcp.length ? { mcp: true } : {}),
        description: `Runs the agent ${p.name} (pi) on a task and the files it names${p.repos.length ? ", or a repository of its preset" : ""}: it answers with text or JSON, and gives back the files it writes${p.repos.length ? " and commits what it changed in the repository" : ""}`,
        files: ["files"],
        file_refs: true,
        input_schema: nodeSchema(p),
        output_schema: outputSchema,
      },
      ...(hasPulls(p) ? [{ name: "pr", tool: "pr", description: prDescription, input_schema: prSchema(p.repos), output_schema: prOutput }] : []),
    ],
    permissions: { files: true, network: hostsOfPreset(p), ...(p.mcp.length ? { mcp: p.mcp } : {}) },
  };
}

// hasPulls says whether the preset has the node pr: a repository with pull
// requests.
function hasPulls(p: Preset): boolean {
  return p.repos.some((r) => r.pr);
}

// Slots runs the steps a few at a time (PI_WORKERS), in arrival order.
class Slots {
  private busy = 0;
  private queue: (() => void)[] = [];
  private n: number;
  constructor(n: number) {
    this.n = n;
  }
  private free: number[] = [];
  // take waits for a slot: its index, and how to give it back.
  async take(signal: AbortSignal): Promise<{ slot: number; release: () => void }> {
    if (this.busy >= this.n) {
      await new Promise<void>((ok, fail) => {
        const go = () => ok();
        this.queue.push(go);
        signal.addEventListener("abort", () => {
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
  get running(): number {
    return this.busy;
  }
}

export interface App {
  server: http.Server;
  proxy: LLMProxy;
  close(): Promise<void>;
}

export async function start(opts: { preset: Preset; token: string; port: number; env: Omit<Env, "preset" | "proxy">; workers: number; key?: string }): Promise<App> {
  const { preset } = opts;
  const proxy = new LLMProxy({
    baseUrl: preset.endpoint.base_url,
    key: opts.key,
    body: preset.endpoint.body,
    models: Object.fromEntries(preset.models.map((m) => [m.id, m.body])),
  });
  await proxy.listen();
  const env: Env = { ...opts.env, preset, proxy };
  const slots = new Slots(opts.workers);
  const man = manifest(preset);
  const toolSchema: any = nodeSchema(preset);
  toolSchema.properties.files = {};
  const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
  const checkPR = hasPulls(preset) ? ajv.compile(prSchema(preset.repos)) : undefined;

  // pr merges or closes a pull request a step opened: no slot, no agent.
  const pr = async (args: Record<string, unknown>, signal: AbortSignal) => {
    const t0 = Date.now();
    try {
      const s = structuredClone(args);
      if (!checkPR!(s)) throw new StepError(ajv.errorsText(checkPR!.errors, { dataVar: "with" }));
      const out = await pullRequest(preset.repos, s as unknown as PRRequest, signal);
      log("pr done", { repo: out.repo, number: out.number, action: out.action, merged: out.merged, closed: out.closed, branch_deleted: out.branch_deleted });
      return { structuredContent: out as unknown as Record<string, unknown>, content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    } catch (e) {
      const known = e instanceof StepError || e instanceof RepoError;
      const msg = (e as Error).message;
      log(known ? "pr failed" : "pr error", { error: msg, seconds: (Date.now() - t0) / 1000 });
      return { isError: true, content: [{ type: "text" as const, text: known ? msg : `internal error: ${msg}` }] };
    }
  };

  const mcp = () => {
    const s = new Server({ name: "gosidian-pi", version: VERSION }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: "gosidian_manifest", description: "The plugin's manifest, for gosidian", inputSchema: { type: "object", properties: {} } },
        { name: "run", description: (man.nodes as any)[0].description, inputSchema: toolSchema },
        ...(checkPR ? [{ name: "pr", description: prDescription, inputSchema: prSchema(preset.repos) as any }] : []),
      ],
    }));
    s.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      if (req.params.name === "gosidian_manifest") {
        return { content: [{ type: "text", text: JSON.stringify(man) }], structuredContent: man };
      }
      if (req.params.name === "pr" && checkPR) return pr((req.params.arguments ?? {}) as Record<string, unknown>, extra.signal);
      if (req.params.name !== "run") return { isError: true, content: [{ type: "text", text: `no tool ${req.params.name}` }] };
      const meta = (req.params._meta ?? {}) as Record<string, unknown>;
      const left = meta[META.tokensLeft];
      const tokensLeft = typeof left === "number" ? left : undefined;
      const t0 = Date.now();
      let release: (() => void) | undefined;
      try {
        const s = await slots.take(extra.signal);
        release = s.release;
        const res = await runStep(env, (req.params.arguments ?? {}) as Record<string, unknown>, tokensLeft, extra.signal, s.slot, meta);
        const o: any = res.output;
        log("step done", {
          model: o.model.name, turns: o.turns, tokens: o.usage.total_tokens, cost: o.cost, files: res.files.length, seconds: (Date.now() - t0) / 1000,
          ...(o.repo ? { repo: o.repo.name, branch: o.repo.branch, commit: o.repo.commit ?? null, pushed: o.repo.pushed } : {}),
          ...(o.mcp ? { mcp: o.mcp.level } : {}),
        });
        return {
          structuredContent: res.output,
          content: [
            { type: "text", text: String(o.text ?? "") },
            ...res.files.map((f) => ({
              type: "resource" as const,
              resource: { uri: `file:///${encodeURIComponent(f.name)}`, mimeType: f.mime, blob: f.data.toString("base64") },
            })),
          ],
        };
      } catch (e) {
        const msg = (e as Error).message;
        log(e instanceof StepError ? "step failed" : "step error", { error: msg, seconds: (Date.now() - t0) / 1000 });
        // A step that spent before it failed says what, for gosidian's count.
        const spent = e instanceof StepError && e.spent ? { structuredContent: { error: msg, ...e.spent } } : {};
        return { isError: true, ...spent, content: [{ type: "text", text: e instanceof StepError ? msg : `internal error: ${msg}` }] };
      } finally {
        release?.();
      }
    });
    return s;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", plugin: "pi", agent: preset.name, version: VERSION, running: slots.running }));
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
  server.requestTimeout = 60_000;
  await new Promise<void>((ok) => server.listen(opts.port, ok));
  return {
    server,
    proxy,
    close: async () => {
      await new Promise((ok) => server.close(() => ok(undefined)));
      await proxy.close();
    },
  };
}

async function main(): Promise<void> {
  const presetFile = process.env.PI_PRESET || "/etc/gosidian-pi/preset.yaml";
  const preset = loadPreset(presetFile);
  const root = process.getuid?.() === 0;
  const { api_key_env: keyEnv, api_key_file: keyFile } = preset.endpoint;
  let key: string | undefined;
  if (keyEnv) {
    key = process.env[keyEnv]?.trim();
    if (!key) throw new Error(`the preset's key is in ${keyEnv}, which is not set`);
  } else if (keyFile) {
    key = fs.readFileSync(keyFile, "utf8").trim();
    if (!key) throw new Error(`${keyFile} is empty`);
  }
  if (!root) log("not root: pi runs as the server's user, and its tools could read the key and the server's environment", {});
  const workers = Math.max(1, int("PI_WORKERS", 1));
  // The image has a user per slot: 10001 to 10008.
  if (root && workers > 8) throw new Error(`PI_WORKERS ${workers}: at most 8, one user each`);
  const runsDir = process.env.PI_RUNS_DIR || "/tmp/gosidian-pi";
  fs.mkdirSync(runsDir, { recursive: true });
  fs.chmodSync(runsDir, 0o711);
  const app = await start({
    preset,
    key,
    token: process.env.GOSIDIAN_PLUGIN_TOKEN ?? "",
    port: int("PORT", 8000),
    workers,
    env: {
      piBin: process.env.PI_BIN || path.join(here, "..", "node_modules", ".bin", "pi"),
      runsDir,
      ...(root ? { agentUid: int("PI_UID", 10001), agentGid: int("PI_GID", 10001) } : {}),
      maxFilesBytes: int("PI_MAX_FILES_BYTES", 256 << 20),
      maxOutFiles: int("PI_MAX_OUT_FILES", 50),
      maxOutBytes: int("PI_MAX_OUT_BYTES", 50 << 20),
      log,
    },
  });
  log("gosidian-pi ready", {
    agent: preset.name, version: VERSION, pi: PI_VERSION, port: int("PORT", 8000), models: preset.models.map((m) => m.name), tools: preset.tools.allowed,
    repos: preset.repos.map((r) => r.name), mcp: preset.mcp, separate_user: root, token: Boolean(process.env.GOSIDIAN_PLUGIN_TOKEN),
  });
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
      log("gosidian-pi failed to start", { error: (e as Error).message });
      process.exit(1);
    });
  }
}
