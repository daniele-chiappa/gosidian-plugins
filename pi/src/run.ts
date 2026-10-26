// One step of the run node: a workspace of its own, the step's repository
// cloned in, the files fetched in, pi run on them (pi --mode json, the
// prompt on its stdin) within the step's limits, with gosidian's MCP when
// the node asks for it, its answer checked as JSON when asked, what it
// changed in the repository committed, the files it wrote collected, and
// the workspace removed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Ajv } from "ajv";
import { ACCESS, META, type Access, type MCPLevel } from "./kit/contract.ts";
import { RepoError, Workspace, type RepoRequest } from "./kit/git.ts";
import { killUser, signalGroup } from "./kit/signal.ts";
import { accessTools, endpointOf, nodeSchema, type Effort, type MCPGrant, type Model, type Preset } from "./preset.ts";
import { Lines, RunState, addUsage, noUsage, type Usage } from "./events.ts";
import { check, correction, extractJSON, instructions, schemaError } from "./schema.ts";
import { collect, fetchAll, refsOf, StepError, type OutFile } from "./files.ts";
import type { LLMProxy } from "./proxy.ts";

export { StepError };

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
// VERSION is the plugin's: the image's, else package.json's.
export const VERSION: string = process.env.PLUGIN_VERSION || pkg.version;

// PI_VERSION is the version of pi the plugin runs, from its package.
export const PI_VERSION: string = (() => {
  try {
    const f = path.join(here, "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
    return String(JSON.parse(fs.readFileSync(f, "utf8")).version);
  } catch {
    return "unknown";
  }
})();

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
  effort: Effort;
  access?: Access;
  // tools are those of the step: the node's, access's or the preset's default.
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
  // repo is a repository of the preset to work on.
  repo?: RepoRequest;
  mcp: MCPLevel;
}

export interface StepResult {
  output: Record<string, unknown>;
  files: OutFile[];
}

// The answer's text a commit message keeps.
const MAX_COMMIT_BODY = 4000;

const validators = new WeakMap<Preset, (v: unknown) => boolean>();
const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });

// settingsOf checks a call's settings against the preset, with its
// defaults: thinking (deprecated) is effort, and access gives the tools,
// which the node's tools narrow.
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
  const s: any = structuredClone(rest);
  if (s.thinking !== undefined) {
    if (s.effort !== undefined) throw new StepError("with: effort and thinking (deprecated) are the same setting: give effort only");
    s.effort = s.thinking;
    delete s.thinking;
  }
  if (s.repo !== undefined && !p.repos.length) throw new StepError("with.repo: the preset has no repositories (repos)");
  if (typeof s.mcp === "string" && s.mcp !== "none" && !(p.mcp as string[]).includes(s.mcp)) {
    throw new StepError(`with.mcp ${s.mcp}: the preset grants ${p.mcp.length ? `gosidian's MCP ${p.mcp.join(", ")} only` : "no access to gosidian's MCP (mcp)"}`);
  }
  // A level the preset cannot give fails here, with the tools it lacks.
  let level: string[] | undefined;
  if (typeof s.access === "string" && (ACCESS as readonly string[]).includes(s.access)) {
    try {
      level = accessTools(p, s.access);
    } catch (e) {
      throw new StepError(`with.${(e as Error).message}`);
    }
  }
  const toolsGiven = s.tools !== undefined;
  if (!validate(s)) throw new StepError(ajv.errorsText(validate.errors, { dataVar: "with" }));
  if (level) {
    const outside = toolsGiven ? (s.tools as string[]).filter((t) => !level.includes(t)) : [];
    if (outside.length) throw new StepError(`with.tools: ${outside.join(", ")} not within access ${s.access} (${level.join(", ")})`);
    if (!toolsGiven) s.tools = level;
  }
  if (s.schema) {
    const e = schemaError(s.schema as object);
    if (e) throw new StepError(`with.schema is not a JSON Schema: ${e}`);
  }
  return s as Settings;
}

// MCPAccess is gosidian's MCP for a step: the level the node asked for,
// the endpoint and the token of the call.
export interface MCPAccess {
  level: MCPGrant;
  url: string;
  token: string;
}

// pi's name of gosidian's MCP server (its tools are mcp__gosidian__<tool>),
// and the variable of pi's environment that holds the token: mcp.json
// names it in a header, so the token is never in pi's arguments or a file.
export const MCP_SERVER = "gosidian";
export const MCP_TOKEN_ENV = "GOSIDIAN_MCP_TOKEN";

// mcpOf reads gosidian's MCP for a step from the call's _meta: none when
// the node asks for none.
export function mcpOf(level: MCPLevel, meta: Record<string, unknown> | undefined): MCPAccess | undefined {
  if (level === "none") return undefined;
  const url = meta?.[META.mcpURL];
  const token = meta?.[META.mcpToken];
  if (typeof url !== "string" || !url || typeof token !== "string" || !token) {
    throw new StepError(`with.mcp ${level}: the call carries no ${META.mcpURL} and ${META.mcpToken} in its _meta: gosidian is too old for it, or the manifest is not accepted with its permissions.mcp`);
  }
  if (!/^https?:\/\/[^\s${}]+$/.test(url)) throw new StepError(`${META.mcpURL} ${JSON.stringify(url.slice(0, 200))} is not an http(s) address`);
  if (!/^[\x21-\x7e]+$/.test(token)) throw new StepError(`${META.mcpToken} is not a token: one line of printable characters`);
  return { level, url, token };
}

// mcpConfig is pi's mcp.json for a step: gosidian's server over streamable
// HTTP, its token taken from pi's environment, its tools declared to the
// model as pi's own (direct), and no codemode.
export function mcpConfig(m: { url: string; level: MCPGrant }): string {
  return JSON.stringify({
    autoEnableCodemode: false,
    mcpServers: {
      [MCP_SERVER]: {
        url: m.url,
        headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` },
        exposure: "direct",
        description: m.level === "write" ? "gosidian: the notes of the task's project, to read and write" : "gosidian: the notes of the task's project, to read",
      },
    },
  }, null, 2);
}

// checkMCP opens a session with gosidian's MCP and closes it, before pi
// starts: pi goes on without a server it cannot reach, and a step that
// asked for gosidian's MCP fails instead, with the reason.
export async function checkMCP(m: MCPAccess, signal: AbortSignal): Promise<void> {
  const headers = { authorization: `Bearer ${m.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gosidian-pi", version: VERSION } },
  });
  let res: Response;
  try {
    res = await fetch(m.url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  } catch (e) {
    throw new StepError(`gosidian's MCP at ${m.url} cannot be reached: ${(e as Error).message}`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok || !text.includes('"result"')) {
    throw new StepError(`gosidian's MCP at ${m.url} answered ${res.status}${text ? `: ${text.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
  }
  const session = res.headers.get("mcp-session-id");
  if (session) {
    await fetch(m.url, { method: "DELETE", headers: { authorization: headers.authorization, "mcp-session-id": session }, redirect: "error", signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
}

// piArgs are pi's arguments for a step: JSON events, the model and its
// thinking level, the step's tools, no context files, skills of its own or
// extensions, offline, a session of its own. With gosidian's MCP, the
// built-in MCP extension alone, and gosidian's tools among the step's.
export function piArgs(p: Preset, s: Settings, m: Model, sysFile: string, sessionDir: string, mcp: boolean): string[] {
  const tools = [...s.tools, ...(mcp ? [`mcp__${MCP_SERVER}__*`] : [])];
  return [
    "--mode", "json",
    "--model", `gosidian/${m.id}`,
    "--thinking", s.effort,
    ...(tools.length ? ["--tools", tools.join(",")] : ["--no-tools"]),
    "--no-context-files", "--no-extensions",
    ...(mcp ? ["-e", "builtin:mcp"] : ["--no-mcp"]),
    "--offline",
    "--session-dir", sessionDir,
    ...(p.skills.length ? p.skills.flatMap((k) => ["--skill", k]) : ["--no-skills"]),
    s.system_mode === "replace" ? "--system-prompt" : "--append-system-prompt", sysFile,
  ];
}

// piEnv is pi's whole environment: nothing of the server's but, with
// gosidian's MCP, the call's token.
export function piEnv(dirs: { agent: string; home: string }, mcpToken?: string): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: dirs.home,
    TMPDIR: dirs.home,
    LANG: "C.UTF-8",
    PI_CODING_AGENT_DIR: dirs.agent,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    ...(mcpToken ? { [MCP_TOKEN_ENV]: mcpToken } : {}),
  };
}

// commitMessage is the commit of a step: the preset and the first line of
// the task, the agent's answer, and the project and run of gosidian.
export function commitMessage(p: Preset, prompt: string, answer: string, meta: Record<string, unknown> | undefined): string {
  const first = prompt.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const subject = `${p.name}: ${first.length > 72 ? first.slice(0, 71) + "…" : first}`;
  const text = answer.trim();
  const body = text.length > MAX_COMMIT_BODY ? text.slice(0, MAX_COMMIT_BODY) + "\n[…]" : text;
  const o = originOf(meta);
  return [subject, "", ...(body ? [body, ""] : []), `gosidian: project ${o.project ?? "-"}, run ${o.run ?? "-"}`].join("\n") + "\n";
}

// originOf names the project and the run of gosidian that called.
export function originOf(meta: Record<string, unknown> | undefined): { project?: string; run?: string } {
  const project = meta?.[META.project];
  const run = meta?.[META.run];
  return { ...(typeof project === "string" && project ? { project } : {}), ...(typeof run === "string" && run ? { run } : {}) };
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

// costOf is the cost of a step as pi adds it up, and where it comes from:
// none when the model has no prices in the preset.
function costOf(m: Model, usage: Usage): { cost: number; cost_source: "agent" | "none" } {
  const priced = Object.values(m.cost).some((v) => v > 0);
  return priced ? { cost: Number(usage.cost.toFixed(6)), cost_source: "agent" } : { cost: 0, cost_source: "none" };
}

export async function runStep(env: Env, args: Record<string, unknown>, tokensLeft: number | undefined, signal: AbortSignal, slot = 0, meta?: Record<string, unknown>): Promise<StepResult> {
  const p = env.preset;
  const s = settingsOf(p, args);
  const refs = refsOf(args.files);
  const mcp = mcpOf(s.mcp, meta);
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
  // Written by the server, read by pi: in/, the prompt files, pi's
  // configuration and the repository's git folder. Written by pi too: its
  // own folder (locks, auth.json), home, session, work, out, the
  // repository's files. The folders pi writes and the server's files lie
  // in are sticky: pi cannot rename or replace what the server wrote (its
  // configuration, which a relaunch reads again; repo/, which the server
  // commits from).
  mkdir(root, 0o711);
  for (const d of [dirs.home, dirs.session, dirs.out]) mkdir(d, 0o777);
  for (const d of [dirs.agent, dirs.work]) mkdir(d, 0o1777);
  mkdir(dirs.in, 0o755);

  let proxyUsed = 0;
  const grant = env.proxy.grant({ left: () => budget - proxyUsed, usage: (n) => (proxyUsed += n) });
  const started = Date.now();
  try {
    if (mcp) await checkMCP(mcp, signal);
    let ws: Workspace | undefined;
    if (s.repo) {
      const repo = p.repos.find((r) => r.name === s.repo!.name);
      if (!repo) throw new StepError(`the preset has no repository ${s.repo.name}`);
      const run = (originOf(meta).run ?? "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "run";
      ws = await repoStep(() => Workspace.open(repo, s.repo!, { root, workTree: path.join(dirs.work, "repo"), defaultBranch: `${repo.branch_prefix}${run}-${id}`, signal }));
      writeFile(path.join(dirs.home, ".gitconfig"), ws.agentConfig());
    }
    const names = await fetchAll(refs, dirs.in, env.maxFilesBytes, signal);
    writeAgentDir(dirs.agent, env.proxy.url, grant.token, model, s, mcp);
    const sysFile = path.join(root, "system.md");
    writeFile(sysFile, systemPrompt(p, s, names, wantJSON, ws, mcp?.level));
    const base = piArgs(p, s, model, sysFile, dirs.session, Boolean(mcp));
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
      const st = await runPi(env, [...base, ...(cont ? ["--continue"] : []), "-p"], prompt, dirs, piEnv(dirs, mcp?.token), left, () => proxyUsed, signal, slot);
      usage = addUsage(usage, st.usage);
      turns += st.turns;
      for (const [k, n] of Object.entries(st.tools)) tools[k] = (tools[k] ?? 0) + n;
      // What the step spent, when it fails after pi ran.
      const spent = (): Record<string, unknown> => ({ usage: { ...usage, cost: Number(usage.cost.toFixed(6)) }, ...costOf(model, usage) });
      if (st.limit) {
        throw new StepError(`the agent stopped at ${st.limit} (${limitText(st.limit, s)}) after ${turns} turns, ${usage.total_tokens} tokens, $${usage.cost.toFixed(4)}`, spent());
      }
      if (st.stop === "error" || st.stop === "aborted" || !st.settled) {
        throw new StepError(`the agent failed: ${st.error || st.stderr || `pi ended (${st.exit})`}`, spent());
      }
      const out: Record<string, unknown> = {
        text: st.text,
        model: { name: model.name, id: model.id, endpoint: endpointOf(p) },
        stop: st.stop === "length" ? "length" : "done",
        turns,
        // usage.cost is deprecated: cost.
        usage: { ...usage, cost: Number(usage.cost.toFixed(6)) },
        ...costOf(model, usage),
        tools,
        executor: { plugin: "gosidian-pi", version: VERSION, agent: "pi", agent_version: PI_VERSION },
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
          throw new StepError(`the answer is not the JSON asked for, after ${attempt + 1} tries: ${errors.join("; ")}; it began: ${st.text.slice(0, 300)}`, spent());
        }
        out.json = (got as { value: unknown }).value;
      }
      if (mcp) out.mcp = { level: mcp.level, url: mcp.url };
      if (ws) out.repo = await repoStep(() => ws.finish(commitMessage(p, s.prompt, st.text, meta)));
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
// its limits and sampling; with gosidian's MCP, its server. pi reads these
// files and does not write them: they stay the server's (a value of them
// may be a command, which pi runs).
function writeAgentDir(dir: string, proxyURL: string, token: string, m: Model, s: Settings, mcp?: MCPAccess): void {
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
  if (mcp) writeFile(path.join(dir, "mcp.json"), mcpConfig(mcp));
}

// systemPrompt is what the step adds to pi's system prompt (or puts in its
// place): the workspace, the repository, gosidian's MCP, the preset's
// instructions, the node's, and the JSON the answer must be. A step whose
// MCP writes is told that the notes it asks for go into the vault with its
// tools: agents that wrote no file gave their notes back as text
// (gosidian's fitness pilot, 2026-10-25).
export function systemPrompt(p: Preset, s: Settings, names: string[], json: boolean, repo?: Workspace, mcp?: MCPLevel): string {
  const writes = s.tools.some((t) => ["edit", "write", "bash"].includes(t));
  const ws = [
    "## Workspace",
    names.length
      ? `The files to work on are in the folder in/ of your working directory: ${names.join(", ")}.`
      : "No files come with this task.",
    `Write the files you produce in the folder out/: they are handed back with your answer. Change nothing elsewhere${repo ? ", but in repo/" : ""}.`,
  ].join("\n");
  const rp = repo
    ? [
        "## Repository",
        `The repository ${repo.repo.name} is checked out in the folder repo/ of your working directory, on the branch ${repo.branch}, from ${repo.base}. The folders in/ and out/ are not part of it, and keep their meaning.`,
        writes
          ? "Make your changes to its files there. Do not commit, push or change branches: when the task ends, the plugin commits what you changed."
          : "Read its files there: you cannot change them in this task.",
        ...(s.tools.includes("bash") ? ["git log, git diff and git status work in repo/; its git folder is read-only."] : []),
      ].join("\n")
    : "";
  const vault =
    mcp === "write"
      ? `## gosidian\nThe MCP server ${MCP_SERVER} (tools mcp__${MCP_SERVER}__memory_*) reads and writes the vault of the run's project. Read its notes with it, and write the notes the task asks for with memory_create, memory_update or memory_edit, in the folders the task allows: a note is not a file of your working folder, and an answer that holds it writes nothing.`
      : mcp === "read"
        ? `## gosidian\nThe MCP server ${MCP_SERVER} (tools mcp__${MCP_SERVER}__memory_*) reads the vault of the run's project: you cannot change its notes in this task.`
        : "";
  const parts = s.system_mode === "replace"
    ? [s.system ?? "", p.system, ws, rp, vault]
    : [ws, rp, vault, p.system, s.system ?? ""];
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
  piEnvironment: Record<string, string>,
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
      env: piEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      ...(user ? user : {}),
    });
    let stopping: NodeJS.Timeout | undefined;
    const stop = (why: string) => {
      if (st.limit) return;
      st.limit = why;
      // As the slot's user: root without CAP_KILL may not signal it.
      signalGroup(child.pid, "SIGTERM", user);
      stopping = setTimeout(() => signalGroup(child.pid, "SIGKILL", user), 3000);
    };
    const timer = setTimeout(() => stop("max_seconds"), left.ms);
    const onAbort = () => stop("canceled");
    // A call canceled between two runs (a retry for the JSON) stops the
    // next at once.
    if (signal.aborted) onAbort();
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
      // A tool's command runs in a group of its own (bash's background
      // jobs too): the slot's user stops all its processes; without one,
      // what is left of its group.
      if (user) killUser(user);
      else signalGroup(child.pid, "SIGKILL");
      st.exit = code;
      st.stderr = st.stderr.trim().split("\n").slice(-5).join(" ").slice(0, 600);
      resolve(st);
    });
    child.stdin.end(prompt);
  });
}
