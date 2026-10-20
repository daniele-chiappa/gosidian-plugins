// gosidian-exec: a gosidian plugin whose node runs a script or a command,
// and keeps command-run/1, the contract of gosidian's command nodes. One
// container is one executor: its preset names the shell, the limits of a
// step, the variables of every step, the hosts its scripts reach, the
// repositories a step may check out, the hosts a step may run on over SSH
// and the dependency cache. MCP at /mcp (Streamable HTTP, stateless), GET
// /health.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { META } from "./kit/contract.ts";
import { hostsOfPreset, loadPreset, nodeSchema, outputSchema, type Preset } from "./preset.ts";
import { CONTRACT, runStep, StepError, VERSION, type Env } from "./run.ts";

export { VERSION };

const MAX_REQUEST = 16 << 20;
const MAX_WORKERS = 8;

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
  const hosts = p.hosts.map((h) => h.name);
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
        description: `Runs a script or a command in the plugin's sandbox${hosts.length ? ` or on a host of its preset (${hosts.join(", ")})` : ""}, on the files it names${p.repos.length ? " and a repository of its preset at a ref" : ""}: it gives back the exit code, the end of the output and the files written in out/`,
        files: ["files"],
        file_refs: true,
        input_schema: nodeSchema(p),
        output_schema: outputSchema,
      },
    ],
    permissions: { files: true, network: hostsOfPreset(p) },
  };
}

// Slots runs the steps a few at a time (EXEC_WORKERS), in arrival order.
class Slots {
  private busy = 0;
  private queue: (() => void)[] = [];
  private free: number[] = [];
  private readonly n: number;
  constructor(n: number) {
    this.n = n;
  }
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

// summary is the result's text: how the run ended, in a line.
function summary(o: Record<string, any>): string {
  const how = o.timed_out ? "timed out" : o.signal ? `killed by ${o.signal}` : `exit ${o.exit_code}`;
  return `${how} in ${o.seconds} s on ${o.target}${o.truncated ? " (output truncated)" : ""}`;
}

export interface App {
  server: http.Server;
  close(): Promise<void>;
}

export async function start(opts: { env: Env; token: string; port: number; workers: number }): Promise<App> {
  const { env } = opts;
  const preset = env.preset;
  const slots = new Slots(opts.workers);
  const man = manifest(preset);
  const toolSchema: any = nodeSchema(preset);
  toolSchema.properties.files = {};

  const mcp = () => {
    const s = new Server({ name: "gosidian-exec", version: VERSION }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: "gosidian_manifest", description: "The plugin's manifest, for gosidian", inputSchema: { type: "object", properties: {} } },
        { name: "run", description: (man.nodes as any)[0].description, inputSchema: toolSchema },
      ],
    }));
    s.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      if (req.params.name === "gosidian_manifest") {
        return { content: [{ type: "text", text: JSON.stringify(man) }], structuredContent: man };
      }
      if (req.params.name !== "run") return { isError: true, content: [{ type: "text", text: `no tool ${req.params.name}` }] };
      const meta = (req.params._meta ?? {}) as Record<string, unknown>;
      const origin = { project: meta[META.project] ?? null, run: meta[META.run] ?? null };
      const t0 = Date.now();
      let release: (() => void) | undefined;
      try {
        const s = await slots.take(extra.signal);
        release = s.release;
        const res = await runStep(env, (req.params.arguments ?? {}) as Record<string, unknown>, extra.signal, s.slot, meta);
        const o: any = res.output;
        log(res.error ? "step failed" : "step done", {
          ...origin, target: o.target, exit_code: o.exit_code, signal: o.signal, timed_out: o.timed_out, seconds: (Date.now() - t0) / 1000,
          files: res.files.length, ...(o.repo ? { repo: o.repo.name, commit: o.repo.commit } : {}),
        });
        if (res.error) return { isError: true, content: [{ type: "text", text: res.error }] };
        return {
          structuredContent: res.output,
          content: [
            { type: "text", text: summary(o) },
            ...res.files.map((f) => ({
              type: "resource" as const,
              resource: { uri: `file:///${encodeURIComponent(f.name)}`, mimeType: f.mime, blob: f.data.toString("base64") },
            })),
          ],
        };
      } catch (e) {
        const msg = (e as Error).message;
        log(e instanceof StepError ? "step refused" : "step error", { ...origin, error: msg, seconds: (Date.now() - t0) / 1000 });
        return { isError: true, content: [{ type: "text", text: e instanceof StepError ? msg : `internal error: ${msg}` }] };
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
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", plugin: "exec", name: preset.name, version: VERSION, running: slots.running }));
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
    close: () =>
      new Promise((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}

async function main(): Promise<void> {
  const preset = loadPreset(process.env.EXEC_PRESET || "/etc/gosidian-exec/preset.yaml");
  const root = process.getuid?.() === 0;
  // The keys of the hosts: files only root reads, which a step never sees.
  for (const h of preset.hosts) {
    try {
      fs.accessSync(h.key_file, fs.constants.R_OK);
    } catch (e) {
      throw new Error(`hosts ${h.name}: key_file ${h.key_file}: ${(e as Error).message}`);
    }
  }
  if (!root) log("not root: the steps run as the server's user, and could read the hosts' keys and the server's environment", {});
  const workers = Math.max(1, int("EXEC_WORKERS", 2));
  // The image has a user and a group per slot: 10101 to 10108, apart from
  // the agent plugins' 10001 up, since ulimit -u counts by user ID across
  // the host.
  if (workers > MAX_WORKERS) throw new Error(`EXEC_WORKERS ${workers}: at most ${MAX_WORKERS}, a user each`);
  const runsDir = process.env.EXEC_RUNS_DIR || "/tmp/gosidian-exec";
  fs.mkdirSync(runsDir, { recursive: true });
  fs.chmodSync(runsDir, 0o711);
  if (preset.cache === "project") {
    fs.mkdirSync(preset.cache_dir, { recursive: true });
    fs.chmodSync(preset.cache_dir, 0o711);
  }
  const port = int("PORT", 8000);
  const slotUid = int("EXEC_UID", 10101);
  const app = await start({
    token: process.env.GOSIDIAN_PLUGIN_TOKEN ?? "",
    port,
    workers,
    env: {
      preset,
      runsDir,
      ...(root ? { slotUid, slotGid: int("EXEC_GID", slotUid) } : {}),
      maxFilesBytes: int("EXEC_MAX_FILES_BYTES", 256 << 20),
      maxOutFiles: int("EXEC_MAX_OUT_FILES", 50),
      maxOutBytes: int("EXEC_MAX_OUT_BYTES", 50 << 20),
      ssh: process.env.EXEC_SSH || "ssh",
      image: process.env.EXEC_IMAGE ?? "",
      log,
    },
  });
  log("gosidian-exec ready", {
    name: preset.name, version: VERSION, port, workers, shell: preset.shell, hosts: preset.hosts.map((h) => h.name),
    repos: preset.repos.map((r) => r.name), cache: preset.cache, separate_user: root, token: Boolean(process.env.GOSIDIAN_PLUGIN_TOKEN),
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
      log("gosidian-exec failed to start", { error: (e as Error).message });
      process.exit(1);
    });
  }
}
