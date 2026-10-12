// One step of the run node: a workspace of its own, the files fetched in,
// pi run on them (pi --mode json, the prompt on its stdin) within the
// step's limits, its answer checked as JSON when asked, the files it wrote
// collected, and the workspace removed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { Ajv } from "ajv";
import { nodeSchema, type Model, type Preset, type Thinking } from "./preset.ts";
import { Lines, RunState, addUsage, noUsage, type Usage } from "./events.ts";
import { check, correction, extractJSON, instructions, schemaError } from "./schema.ts";
import { collect, fetchAll, refsOf, StepError, type OutFile } from "./files.ts";
import type { LLMProxy } from "./proxy.ts";

export { StepError };

export interface Env {
  preset: Preset;
  proxy: LLMProxy;
  piBin: string;
  runsDir: string;
  // agentUid/agentGid run pi as another user, when the server is root: it
  // then reads neither the key nor the server's environment. Each slot of
  // PI_WORKERS has a user of its own (agentUid + slot), so the end of a step
  // can stop every process its user left behind.
  agentUid?: number;
  agentGid?: number;
  maxFilesBytes: number;
  maxOutFiles: number;
  maxOutBytes: number;
  // maxInlineBytes caps the text files a step puts in its prompt.
  maxInlineBytes?: number;
  log(msg: string, fields?: Record<string, unknown>): void;
}

export interface Settings {
  prompt: string;
  system?: string;
  system_mode: "append" | "replace";
  model: string;
  thinking: Thinking;
  tools: string[];
  temperature?: number;
  max_output?: number;
  max_turns: number;
  max_seconds: number;
  max_tokens: number;
  max_cost: number;
  json?: boolean;
  schema?: object;
  json_retries: number;
  inline_files: boolean;
}

export interface StepResult {
  output: Record<string, unknown>;
  files: OutFile[];
}

const validators = new WeakMap<Preset, (v: unknown) => boolean>();
const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });

// settingsOf checks a call's settings against the preset, with its defaults.
export function settingsOf(p: Preset, args: Record<string, unknown>): Settings {
  let validate = validators.get(p) as any;
  if (!validate) {
    const schema: any = nodeSchema(p);
    // files are references by now: refsOf reads them.
    delete schema.properties.files;
    validate = ajv.compile(schema);
    validators.set(p, validate);
  }
  const { files: _files, ...rest } = args;
  const s = structuredClone(rest);
  if (!validate(s)) throw new StepError(ajv.errorsText(validate.errors, { dataVar: "with" }));
  if (s.schema) {
    const e = schemaError(s.schema as object);
    if (e) throw new StepError(`with.schema is not a JSON Schema: ${e}`);
  }
  return s as unknown as Settings;
}

export async function runStep(env: Env, args: Record<string, unknown>, tokensLeft: number | undefined, signal: AbortSignal, slot = 0): Promise<StepResult> {
  const p = env.preset;
  const s = settingsOf(p, args);
  const refs = refsOf(args.files);
  const model = p.models.find((m) => m.name === s.model) as Model;
  const budget = tokensLeft === undefined ? s.max_tokens : Math.min(s.max_tokens, tokensLeft);
  if (budget <= 0) throw new StepError("the run has no language-model tokens left ([pipelines] max_llm_tokens)");
  const wantJSON = Boolean(s.json || s.schema);

  const id = crypto.randomBytes(8).toString("hex");
  const root = path.join(env.runsDir, `step-${id}`);
  const dirs = {
    root,
    agent: path.join(root, "agent"),
    home: path.join(root, "home"),
    session: path.join(root, "session"),
    work: path.join(root, "work"),
    in: path.join(root, "work", "in"),
    out: path.join(root, "work", "out"),
  };
  // Written by the server, read by pi: in/ and the prompt files. Written by
  // pi too: its own folder (locks, auth.json), home, session, work, out.
  mkdir(root, 0o711);
  for (const d of [dirs.agent, dirs.home, dirs.session, dirs.work, dirs.out]) mkdir(d, 0o777);
  mkdir(dirs.in, 0o755);

  let proxyUsed = 0;
  const grant = env.proxy.grant({ left: () => budget - proxyUsed, usage: (n) => (proxyUsed += n) });
  const started = Date.now();
  try {
    const names = await fetchAll(refs, dirs.in, env.maxFilesBytes, signal);
    writeAgentDir(dirs.agent, env.proxy.url, grant.token, model, s);
    const sysFile = path.join(root, "system.md");
    writeFile(sysFile, systemPrompt(p, s, names, wantJSON));
    const base = [
      "--mode", "json",
      "--model", `gosidian/${model.id}`,
      "--thinking", s.thinking,
      ...(s.tools.length ? ["--tools", s.tools.join(",")] : ["--no-tools"]),
      "--no-context-files", "--no-extensions", "--no-mcp", "--offline",
      "--session-dir", dirs.session,
      ...(p.skills.length ? p.skills.flatMap((k) => ["--skill", k]) : ["--no-skills"]),
      s.system_mode === "replace" ? "--system-prompt" : "--append-system-prompt", sysFile,
    ];
    let usage: Usage = noUsage();
    let turns = 0;
    const tools: Record<string, number> = {};
    let prompt = s.inline_files ? s.prompt + inlined(dirs.in, names, env.maxInlineBytes ?? 256 << 10) : s.prompt;
    let cont = false;
    for (let attempt = 0; ; attempt++) {
      const left = {
        turns: s.max_turns - turns,
        tokens: budget - Math.max(usage.total_tokens, proxyUsed),
        cost: s.max_cost - usage.cost,
        ms: s.max_seconds * 1000 - (Date.now() - started),
      };
      const st = await runPi(env, [...base, ...(cont ? ["--continue"] : []), "-p"], prompt, dirs, left, () => proxyUsed, signal, slot);
      usage = addUsage(usage, st.usage);
      turns += st.turns;
      for (const [k, n] of Object.entries(st.tools)) tools[k] = (tools[k] ?? 0) + n;
      if (st.limit) {
        throw new StepError(`the agent stopped at ${st.limit} (${limitText(st.limit, s)}) after ${turns} turns, ${usage.total_tokens} tokens, $${usage.cost.toFixed(4)}`);
      }
      if (st.stop === "error" || st.stop === "aborted" || !st.settled) {
        throw new StepError(`the agent failed: ${st.error || st.stderr || `pi ended (${st.exit})`}`);
      }
      const out: Record<string, unknown> = {
        text: st.text,
        model: model.name,
        stop: st.stop === "length" ? "length" : "done",
        turns,
        tools,
        usage: { ...usage, cost: Number(usage.cost.toFixed(6)) },
      };
      if (wantJSON) {
        const got = extractJSON(st.text);
        const errors = got.ok ? (s.schema ? check(s.schema, got.value) : []) : [got.error];
        if (errors.length) {
          if (attempt < s.json_retries) {
            env.log("the answer is not the JSON asked for: one more turn", { errors });
            prompt = correction(errors);
            cont = true;
            continue;
          }
          throw new StepError(`the answer is not the JSON asked for, after ${attempt + 1} tries: ${errors.join("; ")}; it began: ${st.text.slice(0, 300)}`);
        }
        out.json = (got as { value: unknown }).value;
      }
      const { files, skipped } = collect(dirs.out, env.maxOutFiles, env.maxOutBytes);
      if (skipped.length) out.skipped = skipped;
      return { output: out, files };
    }
  } finally {
    grant.revoke();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// inlined is the text files of in/ for the prompt, within maxBytes
// together; a file that is not text, or past the cap, stays for the tools.
function inlined(dir: string, names: string[], maxBytes: number): string {
  const parts: string[] = [];
  const left: string[] = [];
  let total = 0;
  for (const n of names) {
    const data = fs.readFileSync(path.join(dir, n));
    if (data.includes(0) || total + data.length > maxBytes) {
      left.push(n);
      continue;
    }
    total += data.length;
    parts.push(`<file name="in/${n}">\n${data.toString("utf8")}\n</file>`);
  }
  if (!parts.length) return "";
  const rest = left.length ? `\n\nThe other files are in in/ for your tools: ${left.join(", ")}.` : "";
  return `\n\n## The files of the task\n\n${parts.join("\n\n")}${rest}`;
}

function limitText(limit: string, s: Settings): string {
  switch (limit) {
    case "max_turns":
      return `${s.max_turns} turns`;
    case "max_tokens":
      return `${s.max_tokens} tokens, or the run's max_llm_tokens`;
    case "max_cost":
      return `$${s.max_cost}`;
    case "max_seconds":
      return `${s.max_seconds} s`;
    default:
      return "the call was canceled";
  }
}

function mkdir(d: string, mode: number): void {
  fs.mkdirSync(d, { recursive: true });
  fs.chmodSync(d, mode);
}

function writeFile(f: string, text: string): void {
  fs.writeFileSync(f, text);
  fs.chmodSync(f, 0o644);
}

// writeAgentDir writes pi's folder for the step: one provider, gosidian,
// that is the proxy, with the step's token as its key and the model with
// its limits and sampling.
function writeAgentDir(dir: string, proxyURL: string, token: string, m: Model, s: Settings): void {
  const sampling: Record<string, unknown> = { ...m.sampling };
  if (s.temperature !== undefined) sampling.temperature = s.temperature;
  const model = {
    id: m.id,
    name: m.name,
    contextWindow: m.context,
    maxTokens: Math.min(s.max_output ?? m.max_output, m.max_output),
    reasoning: m.reasoning,
    input: m.images ? ["text", "image"] : ["text"],
    cost: { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cache_read, cacheWrite: m.cost.cache_write },
    ...(Object.keys(sampling).length ? { samplingParams: sampling } : {}),
  };
  writeFile(path.join(dir, "models.json"), JSON.stringify({
    providers: { gosidian: { baseUrl: proxyURL, api: "openai-completions", apiKey: token, models: [model] } },
  }, null, 2));
  writeFile(path.join(dir, "settings.json"), JSON.stringify({
    defaultProjectTrust: "never",
    defaultProvider: "gosidian",
    defaultModel: m.id,
    retry: { enabled: true, maxRetries: 2 },
  }, null, 2));
  for (const f of ["models.json", "settings.json"]) fs.chmodSync(path.join(dir, f), 0o666);
}

// systemPrompt is what the step adds to pi's system prompt (or puts in its
// place): the workspace, the preset's instructions, the node's, and the
// JSON the answer must be.
function systemPrompt(p: Preset, s: Settings, names: string[], json: boolean): string {
  const ws = [
    "## Workspace",
    names.length
      ? `The files to work on are in the folder in/ of your working directory: ${names.join(", ")}.`
      : "No files come with this task.",
    "Write the files you produce in the folder out/: they are handed back with your answer. Change nothing elsewhere.",
  ].join("\n");
  const parts = s.system_mode === "replace"
    ? [s.system ?? "", p.system, ws]
    : [ws, p.system, s.system ?? ""];
  if (json) parts.push("## Answer\n" + instructions(s.schema));
  return parts.filter((x) => x.trim()).join("\n\n") + "\n";
}

interface PiRun extends RunState {
  limit?: string;
  stderr: string;
  exit: number | null;
}

// runPi runs pi once and follows its events, stopping it at a limit.
function runPi(
  env: Env,
  args: string[],
  prompt: string,
  dirs: Record<string, string>,
  left: { turns: number; tokens: number; cost: number; ms: number },
  proxyUsed: () => number,
  signal: AbortSignal,
  slot: number,
): Promise<PiRun> {
  return new Promise((resolve, reject) => {
    const user = env.agentUid !== undefined ? { uid: env.agentUid + slot, gid: env.agentGid ?? env.agentUid } : undefined;
    const st = new RunState() as PiRun;
    st.stderr = "";
    st.exit = null;
    if (left.ms <= 0) {
      st.limit = "max_seconds";
      return resolve(st);
    }
    // umask 0: every file pi makes can be removed by the server, which runs
    // without CAP_DAC_OVERRIDE. A process group of its own, to stop with pi
    // whatever its tools started.
    const child = spawn("/bin/sh", ["-c", 'umask 000 && exec "$0" "$@"', env.piBin, ...args], {
      cwd: dirs.work,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: dirs.home,
        TMPDIR: dirs.home,
        LANG: "C.UTF-8",
        PI_CODING_AGENT_DIR: dirs.agent,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      ...(user ? user : {}),
    });
    let stopping: NodeJS.Timeout | undefined;
    const stop = (why: string) => {
      if (st.limit) return;
      st.limit = why;
      kill(child.pid, "SIGTERM");
      stopping = setTimeout(() => kill(child.pid, "SIGKILL"), 3000);
    };
    const timer = setTimeout(() => stop("max_seconds"), left.ms);
    const onAbort = () => stop("canceled");
    signal.addEventListener("abort", onAbort, { once: true });
    const lines = new Lines();
    const onLine = (line: string) => {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      st.feed(ev);
      if (st.turns > left.turns) stop("max_turns");
      else if (Math.max(st.usage.total_tokens, proxyUsed()) > left.tokens) stop("max_tokens");
      else if (st.usage.cost > left.cost) stop("max_cost");
    };
    child.stdout.on("data", (c: Buffer) => lines.push(c, onLine));
    child.stderr.on("data", (c: Buffer) => {
      if (st.stderr.length < 4000) st.stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      lines.end(onLine);
      clearTimeout(timer);
      if (stopping) clearTimeout(stopping);
      signal.removeEventListener("abort", onAbort);
      kill(child.pid, "SIGKILL"); // what is left of its group
      // A tool's command runs in a group of its own (bash's background
      // jobs too): the slot's user stops all its processes.
      if (user) spawnSync("/bin/sh", ["-c", "kill -9 -1 2>/dev/null; true"], { ...user, stdio: "ignore", timeout: 5000 });
      st.exit = code;
      st.stderr = st.stderr.trim().split("\n").slice(-5).join(" ").slice(0, 600);
      resolve(st);
    });
    child.stdin.end(prompt);
  });
}

function kill(pid: number | undefined, sig: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, sig);
  } catch {
    // gone already
  }
}
