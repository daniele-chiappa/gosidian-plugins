// One step of the run node: a workspace of its own, the repository cloned
// in and the files fetched in, Claude Code run on them headless (-p, the
// prompt on its stdin) within the step's limits, as the user of the step's
// slot and with only the environment it needs (gosidian's MCP when the step
// asks for it), its result read, what it changed in the repository
// committed, the files it wrote collected, and the workspace removed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { Ajv } from "ajv";
import { ACCESS, accessTools, isAnthropic, modelOf, runSchema, type Model, type Preset, type Prices } from "./preset.ts";
import { Lines, StreamState, type Outcome } from "./events.ts";
import { check, extractJSON, schemaError } from "./schema.ts";
import { collect, fetchAll, refsOf, StepError, type OutFile } from "./files.ts";
import { origin } from "./steps.ts";
import { META, type MCPLevel } from "./kit/contract.ts";
import { RepoError, Workspace, type RepoRequest } from "./kit/git.ts";
import type { AnthropicProxy, Tokens } from "./proxy.ts";
import type { Info, Subscription } from "./subscription.ts";
import type { Prober, Versions } from "./versions.ts";

export { StepError };

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// VERSION is the plugin's: the image's, else package.json's.
export const VERSION: string = process.env.PLUGIN_VERSION || pkg.version;

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
  system_mode: "append" | "replace";
  // model is the name of a model of the preset.
  model: string;
  effort?: string;
  access?: string;
  // tools are those of the step: the node's, access's or the preset's default.
  tools: string[];
  max_turns: number;
  max_seconds: number;
  max_tokens: number;
  max_cost: number;
  json?: boolean;
  schema?: object;
  // repo is a repository of the preset to work on.
  repo?: RepoRequest;
  mcp?: MCPLevel;
}

// Target is the model a step runs on, and whether its endpoint is a
// compatible one (not Anthropic's).
export interface Target {
  model: Model;
  compatible: boolean;
}

export function targetOf(p: Preset, name: string): Target {
  const model = modelOf(p, name);
  if (!model) throw new StepError(`the preset has no model ${name}`);
  return { model, compatible: !isAnthropic(p.endpoints[model.endpoint]) };
}

export interface StepResult {
  output: Record<string, unknown>;
  files: OutFile[];
}

// How old the subscription's limits may be when a step checks
// min_left_percent before it starts.
const LIMITS_MAX_AGE_MS = 5 * 60_000;
const MAX_SCHEMA = 64 << 10;
// The agent's answer in a commit message, at most.
const MAX_COMMIT_BODY = 4000;

const validators = new WeakMap<Preset, (v: unknown) => boolean>();
const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });

// settingsOf checks a call's settings against the preset, with its
// defaults: max_budget_usd (deprecated) is max_cost, and access gives the
// tools, which the node's tools narrow.
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
  const s: any = structuredClone(rest);
  if (s.max_budget_usd !== undefined) {
    if (s.max_cost !== undefined) throw new StepError("with: max_cost and max_budget_usd (deprecated) are the same limit: give max_cost only");
    s.max_cost = s.max_budget_usd;
    delete s.max_budget_usd;
  }
  const level = typeof s.access === "string" && Object.hasOwn(ACCESS, s.access) ? accessTools(p, s.access) : undefined;
  if (level?.missing.length) throw new StepError(`with.access ${s.access} needs ${level.missing.join(" or ")}, which the preset does not allow`);
  const toolsGiven = s.tools !== undefined;
  if (!validate(s)) throw new StepError(ajv.errorsText(validate.errors, { dataVar: "with" }));
  if (level) {
    const outside = toolsGiven ? (s.tools as string[]).filter((t) => !ACCESS[s.access].includes(t)) : [];
    if (outside.length) throw new StepError(`with.tools: ${outside.join(", ")} not within access ${s.access} (${level.tools.join(", ")})`);
    if (!toolsGiven) s.tools = level.tools;
  }
  if (s.schema) {
    const e = schemaError(s.schema as object);
    if (e) throw new StepError(`with.schema is not a JSON Schema: ${e}`);
    if (JSON.stringify(s.schema).length > MAX_SCHEMA) throw new StepError(`with.schema is more than ${MAX_SCHEMA >> 10} KiB`);
  }
  return s as unknown as Settings;
}

// MCPAccess is gosidian's MCP for a step: the level the node asked for, and
// the endpoint and the token gosidian handed in the call's _meta.
export interface MCPAccess {
  level: Exclude<MCPLevel, "none">;
  url: string;
  token: string;
}

// The MCP server of gosidian as Claude Code knows it, and the variable of
// its environment that holds the token: Claude Code expands ${VAR} in the
// headers of --mcp-config (checked on 2.1.304), so the token is never in
// its arguments, which every process may read (/proc/<pid>/cmdline).
export const MCP_SERVER = "gosidian";
export const MCP_TOKEN_ENV = "GOSIDIAN_MCP_TOKEN";

// mcpOf reads gosidian's MCP for a step from the call's _meta: none when the
// node asks for none, an error when it asks and the call carries none.
export function mcpOf(level: MCPLevel | undefined, meta: Record<string, unknown> | undefined): MCPAccess | undefined {
  if (!level || level === "none") return undefined;
  const url = meta?.[META.mcpURL];
  const token = meta?.[META.mcpToken];
  if (typeof url !== "string" || !url || typeof token !== "string" || !token) {
    throw new StepError(`with.mcp ${level}: the call carries no ${META.mcpURL} and ${META.mcpToken} in its _meta: gosidian is too old for it, or the manifest is not accepted with its permissions.mcp`);
  }
  if (!/^https?:\/\/[^\s${}]+$/.test(url)) throw new StepError(`${META.mcpURL} ${JSON.stringify(url.slice(0, 200))} is not an http(s) address`);
  if (!/^[\x21-\x7e]+$/.test(token)) throw new StepError(`${META.mcpToken} is not a token: one line of printable characters`);
  return { level, url, token };
}

// mcpConfig is Claude Code's --mcp-config: gosidian's server, its token
// from the environment, or no server.
export function mcpConfig(m?: { url: string }): string {
  const servers = m ? { [MCP_SERVER]: { type: "http", url: m.url, headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` } } } : {};
  return JSON.stringify({ mcpServers: servers });
}

// buildArgs are Claude Code's arguments for a step (checked on 2.1.301 and
// 2.1.304): print mode with its events, the model, effort and limits, only
// the tools the node allows and those approved without asking (anything
// else is denied), the file tools confined to the working folder, no
// settings, hooks, skills or MCP servers of any file, no session kept. On
// Anthropic's endpoints the model is its id (an alias too), and the dollars
// are Claude Code's own limit; on a compatible one the model is its name
// (the proxy sends its id), and the plugin keeps max_cost at the preset's
// prices: Claude Code knows no price of the endpoint's models. With
// gosidian's MCP its one server is gosidian's, whose tools are all approved
// (mcp__gosidian__*: --tools leaves MCP tools alone, and --restricted keeps
// them).
export function buildArgs(s: Settings, t: Target, systemFile: string, mcp?: { url: string }): string[] {
  const tools = s.tools.join(",");
  const allowed = [...s.tools, ...(mcp ? [`mcp__${MCP_SERVER}__*`] : [])].join(",");
  return [
    "-p",
    "--output-format", "stream-json", "--verbose",
    "--model", t.compatible ? t.model.name : t.model.id,
    ...(s.effort && t.model.effort ? ["--effort", s.effort] : []),
    "--max-turns", String(s.max_turns),
    ...(t.compatible ? [] : ["--max-budget-usd", String(s.max_cost)]),
    "--tools", tools,
    ...(allowed ? ["--allowedTools", allowed] : []),
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--restricted",
    "--setting-sources", "",
    "--settings", JSON.stringify({ disableAllHooks: true }),
    "--strict-mcp-config", "--mcp-config", mcpConfig(mcp),
    "--disable-slash-commands",
    "--no-session-persistence",
    s.system_mode === "replace" ? "--system-prompt-file" : "--append-system-prompt-file", systemFile,
    ...(s.schema ? ["--json-schema", JSON.stringify(s.schema)] : []),
  ];
}

// buildEnv is Claude Code's whole environment: nothing of the server's. On
// a compatible endpoint every alias is the step's model (a background task
// uses haiku's) and the experimental betas are off (an endpoint may refuse
// their fields); a model's context and output tokens are its preset's. With
// gosidian's MCP, its token, which --mcp-config names.
export function buildEnv(home: string, proxyUrl: string, key: string, t?: Target, mcpToken?: string): Record<string, string> {
  const m = t?.model;
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
    ...(t?.compatible && m
      ? {
          ANTHROPIC_DEFAULT_OPUS_MODEL: m.name,
          ANTHROPIC_DEFAULT_SONNET_MODEL: m.name,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: m.name,
          ANTHROPIC_DEFAULT_FABLE_MODEL: m.name,
          CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
        }
      : {}),
    ...(m?.context ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(m.context) } : {}),
    ...(m?.max_output ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(m.max_output) } : {}),
    ...(mcpToken ? { [MCP_TOKEN_ENV]: mcpToken } : {}),
  };
}

// RepoInfo is what the system prompt says of the step's repository.
export interface RepoInfo {
  name: string;
  branch: string;
  base: string;
}

// systemPrompt is what a step adds to Claude Code's system prompt: the
// workspace, the repository, the preset's instructions, the node's, and,
// for json without a schema, the form of the answer (a schema has Claude
// Code's own tool).
export function systemPrompt(p: Preset, s: Settings, names: string[], repo?: RepoInfo): string {
  const writes = s.tools.some((t) => ["Write", "Edit", "NotebookEdit", "Bash"].includes(t));
  const ws = [
    "## Workspace",
    names.length
      ? `The files to work on are in the folder in/ of your working directory: ${names.join(", ")}.`
      : "No files come with this task.",
    writes
      ? `Write the files you produce in the folder out/: they are handed back with your answer. Change nothing elsewhere${repo ? ", but in repo/" : ""}.`
      : "You cannot write files in this task: answer with text.",
  ].join("\n");
  const rp = repo
    ? [
        "## Repository",
        `The repository ${repo.name} is checked out in the folder repo/ of your working directory, on the branch ${repo.branch}, from ${repo.base}. The folders in/ and out/ are not part of it: they are as above.`,
        writes
          ? "Make your changes to its files there. Do not commit, push or change branches: when the task ends, the plugin commits what you changed."
          : "Read its files there: you cannot change them in this task.",
        ...(s.tools.includes("Bash") ? ["git log, git diff and git status work in repo/; its git folder is read-only."] : []),
      ].join("\n")
    : "";
  const answer = s.json && !s.schema ? "## Answer\nAnswer with a single JSON value and nothing else: no prose, no code fence." : "";
  return [ws, rp, p.system, s.system ?? "", answer].filter((x) => x.trim()).join("\n\n") + "\n";
}

// commitMessage is the commit of a step: the preset and the first line of
// the task, the agent's answer, and the project and run of gosidian.
export function commitMessage(p: Preset, prompt: string, answer: string, meta: Record<string, unknown> | undefined): string {
  const first = prompt.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const subject = `${p.name}: ${first.length > 72 ? first.slice(0, 71) + "…" : first}`;
  const text = answer.trim();
  const body = text.length > MAX_COMMIT_BODY ? text.slice(0, MAX_COMMIT_BODY) + "\n[…]" : text;
  const o = origin(meta);
  return [subject, "", ...(body ? [body, ""] : []), `gosidian: project ${o.project ?? "-"}, run ${o.run ?? "-"}`].join("\n") + "\n";
}

// effortOf says which effort the step ran with: the effort of the
// requests the proxy saw for the step's model. Claude Code sends none for
// a model without effort levels, and says nothing: the note does. A model
// whose preset says it takes none gets no --effort.
export function effortOf(requested: string | undefined, model: string, seen: Map<string, Set<string | null>>, takes = true): { requested: string | null; applied: string | null; note?: string } {
  const efforts = seen.get(model) ?? new Set([...seen.values()].flatMap((s) => [...s]));
  const values = [...efforts].filter((e): e is string => typeof e === "string");
  const applied = requested && values.includes(requested) ? requested : (values.at(-1) ?? null);
  const out: { requested: string | null; applied: string | null; note?: string } = { requested: requested ?? null, applied };
  if (requested && !takes) out.note = `${model || "the model"} takes no effort level in the preset: the step ran without --effort`;
  else if (requested && !applied) out.note = `${model || "the model"} takes no effort level: Claude Code sent its requests without one`;
  else if (requested && applied !== requested) out.note = `Claude Code sent the effort ${applied}, not ${requested}`;
  return out;
}

function failText(o: Outcome, s: Settings | undefined): string {
  const spent = `after ${o.turns} turns, ${o.usage.total_tokens} tokens, $${o.cost.toFixed(4)}`;
  switch (o.subtype) {
    case "error_max_turns":
      return `Claude Code stopped at max_turns${s ? ` (${s.max_turns} turns)` : ""} ${spent}`;
    case "error_max_budget_usd":
      return `Claude Code stopped at max_cost${s ? ` ($${s.max_cost})` : ""} ${spent}`;
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
  // over names the limit the step went over, of those the proxy counts
  // (max_tokens, max_cost); "" when none.
  over(): string;
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
      const over = o.over();
      if (over) stop(over);
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
  // id names the step: its folder, and its branch in a repository.
  id: string;
  root: string;
  home: string;
  work: string;
  in: string;
  out: string;
}

function makeDirs(runsDir: string): Dirs {
  const id = crypto.randomBytes(8).toString("hex");
  const root = path.join(runsDir, `step-${id}`);
  const d = { id, root, home: path.join(root, "home"), work: path.join(root, "work"), in: path.join(root, "work", "in"), out: path.join(root, "work", "out") };
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

function limitText(limit: string, s: Settings, runCaps: boolean): string {
  switch (limit) {
    case "max_turns":
      return `${s.max_turns} turns`;
    case "max_tokens":
      return runCaps ? "the run's max_llm_tokens" : `${s.max_tokens} tokens`;
    case "max_cost":
      return `$${s.max_cost} at the preset's prices`;
    case "max_seconds":
      return `${s.max_seconds} s`;
    default:
      return "the call was canceled";
  }
}

// priceOf is the cost of tokens at a model's prices (dollars per million).
export function priceOf(t: Tokens, c: Prices): number {
  return (t.input * c.input + t.output * c.output + t.cache_read * c.cache_read + t.cache_write * c.cache_write) / 1e6;
}

// openRepo clones the step's repository into work/repo, on the step's
// branch. work/ becomes sticky, so the slot's user cannot rename or replace
// repo/, and the agent's git configuration lets it read the git folder,
// which is the server's.
async function openRepo(p: Preset, req: RepoRequest, dirs: Dirs, meta: Record<string, unknown> | undefined, signal: AbortSignal): Promise<Workspace> {
  const repo = p.repos.find((r) => r.name === req.name);
  if (!repo) throw new StepError(`the preset has no repository ${req.name}`);
  fs.chmodSync(dirs.work, 0o1777);
  const run = (origin(meta).run ?? "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "run";
  const ws = await repoStep(() => Workspace.open(repo, req, { root: dirs.root, workTree: path.join(dirs.work, "repo"), defaultBranch: `${repo.branch_prefix}${run}-${dirs.id}`, signal }));
  const cfg = path.join(dirs.home, ".gitconfig");
  fs.writeFileSync(cfg, ws.agentConfig());
  fs.chmodSync(cfg, 0o644);
  return ws;
}

// repoStep runs a step of the repository's: its error fails the node.
async function repoStep<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RepoError) throw new StepError(e.message);
    throw e;
  }
}

export async function runStep(env: Env, args: Record<string, unknown>, tokensLeft: number | undefined, signal: AbortSignal, slot = 0, meta?: Record<string, unknown>): Promise<StepResult> {
  const p = env.preset;
  const s = settingsOf(p, args);
  const t = targetOf(p, s.model);
  const mcp = mcpOf(s.mcp, meta);
  const endpoint = p.endpoints[t.model.endpoint];
  const refs = refsOf(args.files);
  if (tokensLeft !== undefined && tokensLeft <= 0) throw new StepError("the run has no language-model tokens left ([pipelines] max_llm_tokens)");
  const runCaps = tokensLeft !== undefined && tokensLeft < s.max_tokens;
  const budget = Math.min(s.max_tokens, tokensLeft ?? Number.POSITIVE_INFINITY);
  // The subscription's limits are those of its own endpoint's steps.
  const short = endpoint.auth === "oauth" ? await env.subscription.shortfall(p.limits.min_left_percent, LIMITS_MAX_AGE_MS) : "";
  if (short) throw new StepError(short);
  const started = Date.now();

  return env.versions.use(async (installed, bin) => {
    const effort = t.model.effort ? s.effort : undefined;
    if (effort && installed.effort_levels.length && !installed.effort_levels.includes(effort)) {
      throw new StepError(`Claude Code ${installed.version} takes no effort ${effort}: it takes ${installed.effort_levels.join(", ")}`);
    }
    const dirs = makeDirs(env.runsDir);
    let used = 0;
    const tokens: Tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    const seen = new Map<string, Set<string | null>>();
    const grant = env.proxy.grant({
      endpoint: endpoint.name,
      ...(t.compatible ? { model: t.model.id } : {}),
      ...(t.model.effort ? {} : { noEffort: true }),
      left: () => budget - used,
      usage: (n, u) => {
        used += n;
        for (const k of Object.keys(tokens) as (keyof Tokens)[]) tokens[k] += u[k];
      },
      seen: (model, e) => {
        if (!seen.has(model)) seen.set(model, new Set());
        seen.get(model)!.add(e);
      },
    });
    // On a compatible endpoint the plugin prices the step: Claude Code
    // knows no price of its models.
    const prices = t.compatible ? t.model.cost : undefined;
    try {
      const ws = s.repo ? await openRepo(p, s.repo, dirs, meta, signal) : undefined;
      const names = await fetchAll(refs, dirs.in, env.maxFilesBytes, signal);
      const sysFile = path.join(dirs.root, "system.md");
      fs.writeFileSync(sysFile, systemPrompt(p, s, names, ws && { name: ws.repo.name, branch: ws.branch, base: ws.base }));
      fs.chmodSync(sysFile, 0o644);
      const run = await runClaude({
        bin,
        args: buildArgs(s, t, sysFile, mcp),
        prompt: s.prompt,
        cwd: dirs.work,
        env: buildEnv(dirs.home, env.proxy.url, grant.key, t, mcp?.token),
        user: userOf(env, slot),
        ms: s.max_seconds * 1000 - (Date.now() - started),
        signal,
        maxTurns: s.max_turns,
        over: () => (used > budget ? "max_tokens" : prices && priceOf(tokens, prices) > s.max_cost ? "max_cost" : ""),
      });
      if (run.limit) {
        throw new StepError(`Claude Code stopped at ${run.limit} (${limitText(run.limit, s, runCaps)}) after ${run.state.turns} turns, ${used} tokens`);
      }
      const o = run.state.outcome();
      if (!o) throw new StepError(`Claude Code ended without a result (exit ${run.exit}): ${run.stderr || "no message"}`);
      if (o.subtype !== "success" || o.isError) throw new StepError(failText(o, s));
      const cost = !t.compatible ? { cost: o.cost, cost_source: "agent" } : prices ? { cost: priceOf(tokens, prices), cost_source: "prices" } : { cost: 0, cost_source: "none" };
      const out: Record<string, unknown> = {
        text: o.text,
        // On Anthropic's endpoints, the alias as this version resolved it.
        model: { name: t.model.name, id: t.compatible ? t.model.id : o.model || t.model.id, endpoint: endpoint.name },
        stop: o.stop === "max_tokens" ? "length" : "done",
        turns: o.turns,
        usage: { ...o.usage, total_tokens: Math.max(o.usage.total_tokens, used) },
        cost: Number(cost.cost.toFixed(6)),
        cost_source: cost.cost_source,
        tools: run.state.tools,
        denials: o.denials,
        executor: { plugin: "gosidian-claude", version: VERSION, agent: "claude-code", agent_version: installed.version },
        effort: effortOf(s.effort, o.model, seen, t.model.effort),
        subtype: o.subtype,
        allowed_tools: run.state.init?.tools ?? [],
        claude_code: installed.version,
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
      if (mcp) {
        const status = run.state.init?.mcp[MCP_SERVER];
        out.mcp = { level: mcp.level, url: mcp.url, ...(status ? { status } : {}) };
      }
      // Only a step that succeeded commits.
      if (ws) out.repo = await repoStep(() => ws.finish(commitMessage(p, s.prompt, o.text, meta)));
      if (endpoint.auth === "oauth") out.subscription = subscriptionNow(env.subscription);
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
  if (!sub.applicable) return { applicable: false, reason: sub.reason };
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
    const p = this.env.preset;
    // The alias's model of an Anthropic endpoint: its endpoint is the probe's.
    const anthropic = p.models.filter((m) => isAnthropic(p.endpoints[m.endpoint]));
    const model = anthropic.find((m) => m.id === alias) ?? (anthropic[0] ? { ...anthropic[0], id: alias } : undefined);
    if (!model) return Promise.reject(new Error("the preset has no model on an Anthropic endpoint"));
    const t: Target = { model: { ...model, effort: false }, compatible: false };
    return this.withSlot(async (slot) => {
      const dirs = makeDirs(this.env.runsDir);
      const grant = this.env.proxy.grant({ endpoint: model.endpoint, left: () => Number.POSITIVE_INFINITY, usage: () => {} });
      try {
        const sysFile = path.join(dirs.root, "system.md");
        fs.writeFileSync(sysFile, "This is a probe of the installation: answer with one word.\n");
        fs.chmodSync(sysFile, 0o644);
        const s: Settings = { prompt: "Reply with only: ok", system_mode: "append", model: model.name, tools: [], max_turns: 1, max_seconds: 120, max_tokens: 100_000, max_cost: 0.5 };
        const run = await runClaude({
          bin,
          args: buildArgs(s, t, sysFile),
          prompt: s.prompt,
          cwd: dirs.work,
          env: buildEnv(dirs.home, this.env.proxy.url, grant.key),
          user: userOf(this.env, slot),
          ms: s.max_seconds * 1000,
          signal: AbortSignal.timeout(s.max_seconds * 1000 + 5000),
          maxTurns: 1,
          over: () => "",
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
