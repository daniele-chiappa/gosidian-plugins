// One step of the run node: a workspace of its own, the files fetched in,
// Claude Code run on them headless (-p, the prompt on its stdin) within the
// step's limits, as the user of the step's slot and with only the
// environment it needs, its result read, the files it wrote collected, and
// the workspace removed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { Ajv } from "ajv";
import { runSchema, type Preset } from "./preset.ts";
import { Lines, StreamState, type Outcome } from "./events.ts";
import { check, extractJSON, schemaError } from "./schema.ts";
import { collect, fetchAll, refsOf, StepError, type OutFile } from "./files.ts";
import type { AnthropicProxy } from "./proxy.ts";
import type { Info, Subscription } from "./subscription.ts";
import type { Prober, Versions } from "./versions.ts";

export { StepError };

export interface Env {
  preset: Preset;
  proxy: AnthropicProxy;
  versions: Versions;
  subscription: Subscription;
  runsDir: string;
  // agentUid/agentGid run Claude Code as another user, when the server is
  // root: it then reads neither the credential nor the server's
  // environment. Each slot of CLAUDE_WORKERS has a user of its own
  // (agentUid + slot), so the end of a step can stop every process its
  // user left behind.
  agentUid?: number;
  agentGid?: number;
  maxFilesBytes: number;
  maxOutFiles: number;
  maxOutBytes: number;
  log(msg: string, fields?: Record<string, unknown>): void;
}

export interface Settings {
  prompt: string;
  system?: string;
  model: string;
  effort?: string;
  tools: string[];
  max_turns: number;
  max_seconds: number;
  max_budget_usd: number;
  json?: boolean;
  schema?: object;
}

export interface StepResult {
  output: Record<string, unknown>;
  files: OutFile[];
}

// How old the subscription's limits may be when a step checks
// min_left_percent before it starts.
const LIMITS_MAX_AGE_MS = 5 * 60_000;
const MAX_SCHEMA = 64 << 10;

const validators = new WeakMap<Preset, (v: unknown) => boolean>();
const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });

// settingsOf checks a call's settings against the preset, with its defaults.
export function settingsOf(p: Preset, args: Record<string, unknown>): Settings {
  let validate = validators.get(p) as any;
  if (!validate) {
    const schema: any = runSchema(p);
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
    if (JSON.stringify(s.schema).length > MAX_SCHEMA) throw new StepError(`with.schema is more than ${MAX_SCHEMA >> 10} KiB`);
  }
  return s as unknown as Settings;
}

// buildArgs are Claude Code's arguments for a step (checked on 2.1.301):
// print mode with its events, the model, effort and limits, only the tools
// the node allows and those approved without asking (anything else is
// denied), the file tools confined to the working folder, no settings,
// hooks, skills or MCP servers of any file, no session kept.
export function buildArgs(s: Settings, systemFile: string): string[] {
  const tools = s.tools.join(",");
  return [
    "-p",
    "--output-format", "stream-json", "--verbose",
    "--model", s.model,
    ...(s.effort ? ["--effort", s.effort] : []),
    "--max-turns", String(s.max_turns),
    "--max-budget-usd", String(s.max_budget_usd),
    "--tools", tools,
    ...(tools ? ["--allowedTools", tools] : []),
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--restricted",
    "--setting-sources", "",
    "--settings", JSON.stringify({ disableAllHooks: true }),
    "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
    "--disable-slash-commands",
    "--no-session-persistence",
    "--append-system-prompt-file", systemFile,
    ...(s.schema ? ["--json-schema", JSON.stringify(s.schema)] : []),
  ];
}

// buildEnv is Claude Code's whole environment: nothing of the server's.
export function buildEnv(home: string, proxyUrl: string, key: string): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    TMPDIR: home,
    LANG: "C.UTF-8",
    ANTHROPIC_BASE_URL: proxyUrl,
    ANTHROPIC_API_KEY: key,
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  };
}

// systemPrompt is what a step adds to Claude Code's system prompt: the
// workspace, the preset's instructions, the node's, and, for json without
// a schema, the form of the answer (a schema has Claude Code's own tool).
export function systemPrompt(p: Preset, s: Settings, names: string[]): string {
  const ws = [
    "## Workspace",
    names.length
      ? `The files to work on are in the folder in/ of your working directory: ${names.join(", ")}.`
      : "No files come with this task.",
    s.tools.some((t) => ["Write", "Edit", "NotebookEdit", "Bash"].includes(t))
      ? "Write the files you produce in the folder out/: they are handed back with your answer. Change nothing elsewhere."
      : "You cannot write files in this task: answer with text.",
  ].join("\n");
  const answer = s.json && !s.schema ? "## Answer\nAnswer with a single JSON value and nothing else: no prose, no code fence." : "";
  return [ws, p.system, s.system ?? "", answer].filter((x) => x.trim()).join("\n\n") + "\n";
}

// effortOf says which effort the step ran with: the effort of the
// requests the proxy saw for the step's model. Claude Code sends none for
// a model without effort levels, and says nothing: the note does.
export function effortOf(requested: string | undefined, model: string, seen: Map<string, Set<string | null>>): { requested: string | null; applied: string | null; note?: string } {
  const efforts = seen.get(model) ?? new Set([...seen.values()].flatMap((s) => [...s]));
  const values = [...efforts].filter((e): e is string => typeof e === "string");
  const applied = requested && values.includes(requested) ? requested : (values.at(-1) ?? null);
  const out: { requested: string | null; applied: string | null; note?: string } = { requested: requested ?? null, applied };
  if (requested && !applied) out.note = `${model || "the model"} takes no effort level: Claude Code sent its requests without one`;
  else if (requested && applied !== requested) out.note = `Claude Code sent the effort ${applied}, not ${requested}`;
  return out;
}

function failText(o: Outcome, s: Settings | undefined): string {
  const spent = `after ${o.turns} turns, ${o.usage.total_tokens} tokens, $${o.cost.toFixed(4)}`;
  switch (o.subtype) {
    case "error_max_turns":
      return `Claude Code stopped at max_turns${s ? ` (${s.max_turns} turns)` : ""} ${spent}`;
    case "error_max_budget_usd":
      return `Claude Code stopped at max_budget_usd${s ? ` ($${s.max_budget_usd})` : ""} ${spent}`;
  }
  const why = o.errors.join("; ") || o.text || o.terminal || "no reason given";
  return `Claude Code ended with ${o.subtype || "an error"}${o.apiError ? ` (the API answered ${o.apiError})` : ""}: ${why.slice(0, 600)} (${spent})`;
}

export interface ClaudeRun {
  state: StreamState;
  limit?: string;
  stderr: string;
  exit: number | null;
}

export interface RunOptions {
  bin: string;
  args: string[];
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  user?: { uid: number; gid: number };
  ms: number;
  signal: AbortSignal;
  maxTurns: number;
  // overBudget says when the step's tokens are spent (the proxy counts).
  overBudget(): boolean;
}

// runClaude runs Claude Code once and follows its events, stopping it at a
// limit; at the end it stops whatever the process tree left behind.
export function runClaude(o: RunOptions): Promise<ClaudeRun> {
  return new Promise((resolve, reject) => {
    const st: ClaudeRun = { state: new StreamState(), stderr: "", exit: null };
    // umask 0: every file Claude Code makes can be removed by the server,
    // which runs without CAP_DAC_OVERRIDE. A process group of its own, to
    // stop with it whatever its tools started.
    const child = spawn("/bin/sh", ["-c", 'umask 000 && exec "$0" "$@"', o.bin, ...o.args], {
      cwd: o.cwd,
      env: o.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      ...(o.user ?? {}),
    });
    let stopping: NodeJS.Timeout | undefined;
    const stop = (why: string) => {
      if (st.limit) return;
      st.limit = why;
      kill(child.pid, "SIGTERM");
      stopping = setTimeout(() => kill(child.pid, "SIGKILL"), 3000);
    };
    const timer = setTimeout(() => stop("max_seconds"), Math.max(1, o.ms));
    const onAbort = () => stop("canceled");
    if (o.signal.aborted) onAbort();
    o.signal.addEventListener("abort", onAbort, { once: true });
    const lines = new Lines();
    const onLine = (line: string) => {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      st.state.feed(ev);
      if (o.overBudget()) stop("max_tokens");
      // Claude Code keeps --max-turns itself: this is the net under it.
      else if (st.state.turns > o.maxTurns + 1) stop("max_turns");
    };
    child.stdout.on("data", (c: Buffer) => lines.push(c, onLine));
    child.stderr.on("data", (c: Buffer) => {
      if (st.stderr.length < 4000) st.stderr += c.toString("utf8");
    });
    child.stdin.on("error", () => {
      // it ended before reading the prompt: its exit says why
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      lines.end(onLine);
      clearTimeout(timer);
      if (stopping) clearTimeout(stopping);
      o.signal.removeEventListener("abort", onAbort);
      kill(child.pid, "SIGKILL"); // what is left of its group
      // A tool's command may run in a group of its own: the slot's user
      // stops all its processes.
      if (o.user) spawnSync("/bin/sh", ["-c", "kill -9 -1 2>/dev/null; true"], { ...o.user, stdio: "ignore", timeout: 5000 });
      st.exit = code;
      st.stderr = st.stderr.trim().split("\n").slice(-5).join(" ").slice(0, 600);
      resolve(st);
    });
    child.stdin.end(o.prompt);
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

interface Dirs {
  root: string;
  home: string;
  work: string;
  in: string;
  out: string;
}

function makeDirs(runsDir: string): Dirs {
  const id = crypto.randomBytes(8).toString("hex");
  const root = path.join(runsDir, `step-${id}`);
  const d = { root, home: path.join(root, "home"), work: path.join(root, "work"), in: path.join(root, "work", "in"), out: path.join(root, "work", "out") };
  // Written by the server, read by Claude Code: in/ and the system prompt.
  // Written by Claude Code too: home, work, out.
  mkdir(root, 0o711);
  for (const x of [d.home, d.work, d.out]) mkdir(x, 0o777);
  mkdir(d.in, 0o755);
  return d;
}

// removeStep removes a step's folder. Claude Code makes folders of its own
// with mode 0700 (~/.claude), which the server, root without
// CAP_DAC_OVERRIDE, can neither read nor empty: the step's user empties
// home and work first, then the server removes the rest. A folder left
// behind is logged; it never fails the step, whose result is already made.
function removeStep(dirs: Dirs, user: { uid: number; gid: number } | undefined, log: Env["log"]): void {
  if (user) {
    spawnSync("/bin/sh", ["-c", 'rm -rf -- "$0"/* "$0"/.[!.]* "$0"/..?* "$1"/* "$1"/.[!.]* "$1"/..?* 2>/dev/null; true', dirs.home, dirs.work], {
      env: { PATH: "/usr/bin:/bin" },
      cwd: "/",
      stdio: "ignore",
      timeout: 60_000,
      ...user,
    });
  }
  try {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  } catch (e) {
    log("a step's folder was left behind", { dir: dirs.root, error: (e as Error).message });
  }
}

function mkdir(d: string, mode: number): void {
  fs.mkdirSync(d, { recursive: true });
  fs.chmodSync(d, mode);
}

function userOf(env: Env, slot: number): { uid: number; gid: number } | undefined {
  return env.agentUid !== undefined ? { uid: env.agentUid + slot, gid: env.agentGid ?? env.agentUid } : undefined;
}

function limitText(limit: string, s: Settings): string {
  switch (limit) {
    case "max_turns":
      return `${s.max_turns} turns`;
    case "max_tokens":
      return "the run's max_llm_tokens";
    case "max_seconds":
      return `${s.max_seconds} s`;
    default:
      return "the call was canceled";
  }
}

export async function runStep(env: Env, args: Record<string, unknown>, tokensLeft: number | undefined, signal: AbortSignal, slot = 0): Promise<StepResult> {
  const p = env.preset;
  const s = settingsOf(p, args);
  const refs = refsOf(args.files);
  if (tokensLeft !== undefined && tokensLeft <= 0) throw new StepError("the run has no language-model tokens left ([pipelines] max_llm_tokens)");
  const budget = tokensLeft ?? Number.POSITIVE_INFINITY;
  const short = await env.subscription.shortfall(p.limits.min_left_percent, LIMITS_MAX_AGE_MS);
  if (short) throw new StepError(short);
  const started = Date.now();

  return env.versions.use(async (meta, bin) => {
    if (s.effort && meta.effort_levels.length && !meta.effort_levels.includes(s.effort)) {
      throw new StepError(`Claude Code ${meta.version} takes no effort ${s.effort}: it takes ${meta.effort_levels.join(", ")}`);
    }
    const dirs = makeDirs(env.runsDir);
    let used = 0;
    const seen = new Map<string, Set<string | null>>();
    const grant = env.proxy.grant({
      left: () => budget - used,
      usage: (n) => (used += n),
      seen: (model, effort) => {
        if (!seen.has(model)) seen.set(model, new Set());
        seen.get(model)!.add(effort);
      },
    });
    try {
      const names = await fetchAll(refs, dirs.in, env.maxFilesBytes, signal);
      const sysFile = path.join(dirs.root, "system.md");
      fs.writeFileSync(sysFile, systemPrompt(p, s, names));
      fs.chmodSync(sysFile, 0o644);
      const run = await runClaude({
        bin,
        args: buildArgs(s, sysFile),
        prompt: s.prompt,
        cwd: dirs.work,
        env: buildEnv(dirs.home, env.proxy.url, grant.key),
        user: userOf(env, slot),
        ms: s.max_seconds * 1000 - (Date.now() - started),
        signal,
        maxTurns: s.max_turns,
        overBudget: () => used > budget,
      });
      if (run.limit) {
        throw new StepError(`Claude Code stopped at ${run.limit} (${limitText(run.limit, s)}) after ${run.state.turns} turns, ${used} tokens`);
      }
      const o = run.state.outcome();
      if (!o) throw new StepError(`Claude Code ended without a result (exit ${run.exit}): ${run.stderr || "no message"}`);
      if (o.subtype !== "success" || o.isError) throw new StepError(failText(o, s));
      const out: Record<string, unknown> = {
        text: o.text,
        model: o.model,
        effort: effortOf(s.effort, o.model, seen),
        subtype: o.subtype,
        turns: o.turns,
        usage: { ...o.usage, total_tokens: Math.max(o.usage.total_tokens, used) },
        cost: Number(o.cost.toFixed(6)),
        denials: o.denials,
        tools: run.state.init?.tools ?? [],
        claude_code: meta.version,
      };
      if (s.schema) {
        if (o.structured === undefined) throw new StepError(`the answer did not follow the schema: Claude Code gave no structured output; it began: ${o.text.slice(0, 300)}`);
        const errors = check(s.schema, o.structured);
        if (errors.length) throw new StepError(`the structured output does not follow the schema: ${errors.join("; ")}`);
        out.json = o.structured;
      } else if (s.json) {
        const got = extractJSON(o.text);
        if (!got.ok) throw new StepError(`the answer is not JSON: ${got.error}; it began: ${o.text.slice(0, 300)}`);
        out.json = got.value;
      }
      out.subscription = subscriptionNow(env.subscription);
      const { files, skipped } = collect(dirs.out, env.maxOutFiles, env.maxOutBytes);
      if (skipped.length) out.skipped = skipped;
      return { output: out, files };
    } finally {
      grant.revoke();
      removeStep(dirs, userOf(env, slot), env.log);
    }
  });
}

// subscriptionNow is the subscription's limits after a step: those of the
// last answer the proxy saw.
export function subscriptionNow(sub: Subscription): Info {
  if (!sub.applicable) return { applicable: false, reason: "an API key: the limits of a subscription do not apply" };
  return sub.latest ?? { applicable: true, reason: "no answer of the API carried the limits" };
}

// ClaudeProber runs an alias once with a prompt of one word and no tools,
// to learn the model a version resolves it to.
export class ClaudeProber implements Prober {
  private env: Env;
  private withSlot: <T>(fn: (slot: number) => Promise<T>) => Promise<T>;

  constructor(env: Env, withSlot: <T>(fn: (slot: number) => Promise<T>) => Promise<T>) {
    this.env = env;
    this.withSlot = withSlot;
  }

  probe(bin: string, alias: string): Promise<string> {
    return this.withSlot(async (slot) => {
      const dirs = makeDirs(this.env.runsDir);
      const grant = this.env.proxy.grant({ left: () => Number.POSITIVE_INFINITY, usage: () => {} });
      try {
        const sysFile = path.join(dirs.root, "system.md");
        fs.writeFileSync(sysFile, "This is a probe of the installation: answer with one word.\n");
        fs.chmodSync(sysFile, 0o644);
        const s: Settings = { prompt: "Reply with only: ok", model: alias, tools: [], max_turns: 1, max_seconds: 120, max_budget_usd: 0.5 };
        const run = await runClaude({
          bin,
          args: buildArgs(s, sysFile),
          prompt: s.prompt,
          cwd: dirs.work,
          env: buildEnv(dirs.home, this.env.proxy.url, grant.key),
          user: userOf(this.env, slot),
          ms: s.max_seconds * 1000,
          signal: AbortSignal.timeout(s.max_seconds * 1000 + 5000),
          maxTurns: 1,
          overBudget: () => false,
        });
        if (run.limit) throw new Error(`stopped at ${run.limit}`);
        const o = run.state.outcome();
        if (!o) throw new Error(`no result (exit ${run.exit}): ${run.stderr || "no message"}`);
        if (o.subtype !== "success" || o.isError) throw new Error(failText(o, undefined));
        if (!o.model) throw new Error("the result names no model");
        return o.model;
      } finally {
        grant.revoke();
        removeStep(dirs, userOf(this.env, slot), this.env.log);
      }
    });
  }
}
