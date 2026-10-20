// One step of the run node (command-run/1): a folder of its own, the
// repository checked out at its ref, the files fetched in, the script or
// the command run within the step's limits, in the sandbox as the slot's
// user or on a host of the preset over SSH (remote.ts), the end of its
// output kept, the files it wrote collected, and the folder removed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { Ajv } from "ajv";
import { META } from "./kit/contract.ts";
import { RepoError, Workspace } from "./kit/git.ts";
import { envError, MAX_ENV, nodeSchema, type Preset } from "./preset.ts";
import { collect, fetchAll, refsOf, StepError, type OutFile } from "./files.ts";
import { runRemote } from "./remote.ts";
import { lastLines, Tail, type Dirs, type Env, type Ran, type Settings } from "./step.ts";

export { StepError };
export type { Env, Settings };

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
// VERSION is the plugin's: the image's, else package.json's.
export const VERSION: string = process.env.PLUGIN_VERSION || pkg.version;
export const PLUGIN = "gosidian-exec";
export const CONTRACT = "command-run/1";

// The tools' path of a local step: Go, then the image's.
export const STEP_PATH = "/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin";
const BASH = "/bin/bash";

export interface StepResult {
  output: Record<string, unknown>;
  files: OutFile[];
  // error is why the node fails, with fail_on_error: the exit code, the
  // signal or the timeout, and the end of stderr.
  error?: string;
}

const validators = new WeakMap<Preset, (v: unknown) => boolean>();
const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });

// settingsOf checks a call's settings against the preset, with its
// defaults. A target, a repository or a variable outside the preset's is
// refused here, whatever the schema said.
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
  if (s.script !== undefined && s.command !== undefined) throw new StepError("with: script or command, not both");
  if (s.script === undefined && s.command === undefined) throw new StepError("with: a script or a command");
  if (s.repo !== undefined && !p.repos.length) throw new StepError("with.repo: the preset has no repositories (repos)");
  if (typeof s.target === "string" && s.target !== "local" && !p.hosts.some((h) => h.name === s.target)) {
    throw new StepError(`with.target ${s.target}: not local nor a host of the preset${p.hosts.length ? ` (${p.hosts.map((h) => h.name).join(", ")})` : ", which has none"}`);
  }
  if (s.env && typeof s.env === "object" && !Array.isArray(s.env)) {
    const names = Object.keys(s.env);
    if (names.length > MAX_ENV) throw new StepError(`with.env: ${names.length} variables, at most ${MAX_ENV}`);
    for (const n of names) {
      const why = envError(n);
      if (why) throw new StepError(`with.env: ${why}`);
    }
  }
  if (!validate(s)) throw new StepError(ajv.errorsText(validate.errors, { dataVar: "with" }));
  s.env ??= {};
  s.cpu_seconds = Math.min(s.cpu_seconds ?? p.limits.default.cpu_seconds ?? s.timeout, p.limits.max.cpu_seconds);
  return s as Settings;
}

// projectOf is the call's project as a folder's name: lower-case letters,
// digits, ., _ and -; none when the call names none.
export function projectOf(meta: Record<string, unknown> | undefined): string | undefined {
  const p = meta?.[META.project];
  if (typeof p !== "string") return undefined;
  const name = p.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+/, "").replace(/-+$/, "").slice(0, 64);
  return name || undefined;
}

// cacheKey is the key of the cache's folder names, made at its first use
// and kept in the cache's volume, which only root reads.
function cacheKey(dir: string): Buffer {
  const file = path.join(dir, ".key");
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return fs.readFileSync(file);
}

// projectCache is the cache of a project: <cache_dir>/<project>/<mac>,
// whose last name is a MAC of the project's under a key only root reads.
// The folders above it are root's and cannot be listed: a step reaches its
// own project's cache, and no other, whose name it cannot know.
export function projectCache(cacheDir: string, project: string, raw: string): string {
  mkdir(cacheDir, 0o711);
  const mac = crypto.createHmac("sha256", cacheKey(cacheDir)).update(raw).digest("hex").slice(0, 32);
  const dir = path.join(cacheDir, project);
  mkdir(dir, 0o711);
  const own = path.join(dir, mac);
  mkdir(own, 0o777);
  return own;
}

// stepEnv is a local step's whole environment: nothing of the server's.
// The tools' caches are in the step's cache/: its own folder, or a link to
// its project's.
export function stepEnv(p: Preset, s: Settings, d: Dirs): Record<string, string> {
  return {
    PATH: STEP_PATH,
    HOME: d.home,
    TMPDIR: d.tmp,
    LANG: "C.UTF-8",
    CI: "true",
    GOPATH: path.join(d.home, "go"),
    GOCACHE: path.join(d.cache, "go-build"),
    GOMODCACHE: path.join(d.cache, "go-mod"),
    npm_config_cache: path.join(d.cache, "npm"),
    npm_config_update_notifier: "false",
    PIP_CACHE_DIR: path.join(d.cache, "pip"),
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    ...p.env,
    ...s.env,
  };
}

// hardLimits reads the server's hard limits (processes, bytes of a file,
// CPU seconds): a step's ulimit cannot go above them.
export function hardLimits(text?: string): { processes: number; fileSize: number; cpu: number } {
  let t = text;
  if (t === undefined) {
    try {
      t = fs.readFileSync("/proc/self/limits", "utf8");
    } catch {
      t = "";
    }
  }
  const hard = (name: string) => {
    const m = new RegExp(`^${name}\\s+\\S+\\s+(\\S+)`, "m").exec(t!);
    return !m || m[1] === "unlimited" ? Infinity : Number(m[1]);
  };
  return { processes: hard("Max processes"), fileSize: hard("Max file size"), cpu: hard("Max cpu time") };
}

// ulimits are a local step's: processes, KiB of a file (bash's unit), CPU
// seconds, within the server's own hard limits.
export function ulimits(s: Settings, hard = hardLimits()): { processes: number; fileKiB: number; cpu: number } {
  return {
    processes: Math.min(s.processes, hard.processes),
    fileKiB: Math.min(s.file_size * 1024, Math.floor(hard.fileSize / 1024)),
    cpu: Math.min(s.cpu_seconds, hard.cpu),
  };
}

// The shell that starts a local step: the limits, no core files, umask 0
// (the server, root without CAP_DAC_OVERRIDE, removes what it made), then
// the script's shell or the command in its place. The limits are its
// arguments, set as both soft and hard: the step cannot raise them.
const WRAPPER = 'set +o posix; ulimit -c 0 && ulimit -u "$1" && ulimit -f "$2" && ulimit -t "$3" && umask 000 && shift 3 && exec "$@"';

export async function runStep(env: Env, args: Record<string, unknown>, signal: AbortSignal, slot = 0, meta?: Record<string, unknown>): Promise<StepResult> {
  const p = env.preset;
  const s = settingsOf(p, args);
  const refs = refsOf(args.files);
  const host = s.target === "local" ? undefined : p.hosts.find((h) => h.name === s.target);
  if (s.target !== "local" && !host) throw new StepError(`the preset has no host ${s.target}`);
  const repo = s.repo ? p.repos.find((r) => r.name === s.repo!.name) : undefined;
  if (s.repo && !repo) throw new StepError(`the preset has no repository ${s.repo.name}`);
  const user = host ? undefined : userOf(env, slot);
  const dirs = makeDirs(env.runsDir, user, Boolean(host));
  try {
    let repoOut: { name: string; ref: string; commit: string } | undefined;
    if (repo) {
      const ws = await repoStep(() => Workspace.checkout(repo, s.repo!.ref, { root: dirs.root, workTree: dirs.repo, signal }));
      repoOut = { name: repo.name, ref: s.repo!.ref ?? repo.base, commit: await repoStep(() => ws.head()) };
      // git may read the repository, which is the server's.
      if (!host) writeFile(path.join(dirs.home, ".gitconfig"), ws.agentConfig());
    }
    await fetchAll(refs, dirs.in, env.maxFilesBytes, signal);
    let ran: Ran;
    if (host) {
      ran = await runRemote(env, host, s, dirs, signal);
    } else {
      setCache(p, dirs, meta);
      ran = await runLocal(env, s, dirs, user, signal);
    }
    if (ran.canceled) throw new StepError("the call was canceled");
    const { files, skipped } = collect(ran.out, env.maxOutFiles, env.maxOutBytes);
    const skip = [...(ran.skipped ?? []), ...skipped];
    const output: Record<string, unknown> = {
      exit_code: ran.exit_code,
      signal: ran.signal,
      timed_out: ran.timed_out,
      stdout: ran.stdout,
      stderr: ran.stderr,
      truncated: ran.truncated,
      seconds: ran.seconds,
      ...(repoOut ? { repo: repoOut } : {}),
      target: s.target,
      executor: { plugin: PLUGIN, version: VERSION, image: env.image },
      ...(skip.length ? { skipped: skip } : {}),
    };
    return { output, files, ...(s.fail_on_error ? errorOf(ran, s) : {}) };
  } finally {
    removeStep(dirs, user, env.log);
  }
}

// errorOf says why a run fails its node: the timeout, a signal, an exit
// code other than 0; with the end of what it wrote on stderr.
function errorOf(r: Ran, s: Settings): { error?: string } {
  let why: string;
  if (r.timed_out) why = `timed out after ${s.timeout} s (timeout)`;
  else if (r.signal) why = `killed by ${r.signal} after ${r.seconds} s`;
  else if (r.exit_code !== 0) why = `exit ${r.exit_code} after ${r.seconds} s`;
  else return {};
  const where = s.target === "local" ? "" : `on ${s.target}: `;
  const said = lastLines(r.stderr) || lastLines(r.stdout);
  return { error: `${where}${why}${said ? `: ${said}` : ""}` };
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

function userOf(env: Env, slot: number): { uid: number; gid: number } | undefined {
  if (env.slotUid === undefined) return undefined;
  return { uid: env.slotUid + slot, gid: (env.slotGid ?? env.slotUid) + slot };
}

// makeDirs makes a step's folders. As root, the step's folder is root's
// with the slot's group, mode 0750: its user enters it, the other slots'
// users do not, whatever they learn of its name. Inside, the script writes
// home, tmp and work (sticky: it cannot move or replace what the server
// put there) and out/; it reads in/ and the repository's git folder. An SSH
// step's folder is the server's alone.
function makeDirs(runsDir: string, user: { uid: number; gid: number } | undefined, remote: boolean): Dirs {
  const id = crypto.randomBytes(8).toString("hex");
  const root = path.join(runsDir, `step-${id}`);
  const work = path.join(root, "work");
  const d: Dirs = {
    id,
    root,
    home: path.join(root, "home"),
    tmp: path.join(root, "tmp"),
    cache: path.join(root, "cache"),
    work,
    in: path.join(work, "in"),
    out: path.join(work, "out"),
    repo: path.join(work, "repo"),
    script: path.join(root, "script.sh"),
    private: path.join(root, "private"),
  };
  if (user && !remote) {
    // A process of root's with the slot's group makes it: root without
    // CAP_CHOWN cannot give it that group afterwards.
    const r = spawnSync("mkdir", ["-m", "750", "--", root], { gid: user.gid, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`the step's folder: ${r.stderr || r.error?.message}`);
  } else {
    mkdir(root, remote ? 0o700 : 0o711);
  }
  if (!remote) for (const x of [d.home, d.tmp]) mkdir(x, 0o1777);
  mkdir(work, remote ? 0o700 : 0o1777);
  mkdir(d.in, 0o755);
  mkdir(d.out, remote ? 0o700 : 0o777);
  if (remote) mkdir(d.private, 0o700);
  return d;
}

// setCache gives a local step its cache: a folder of its own, removed with
// it, or with cache: project, a link to its project's.
function setCache(p: Preset, d: Dirs, meta: Record<string, unknown> | undefined): void {
  const project = projectOf(meta);
  if (p.cache === "project" && project) {
    fs.symlinkSync(projectCache(p.cache_dir, project, String(meta![META.project])), d.cache);
  } else {
    mkdir(d.cache, 0o777);
  }
}

// runLocal runs the script (or the command) as the slot's user, in work/,
// within the step's limits; at its end, or at the timeout or the call's
// cancellation, it stops its process group, then every process of the
// slot's user.
function runLocal(env: Env, s: Settings, d: Dirs, user: { uid: number; gid: number } | undefined, signal: AbortSignal): Promise<Ran> {
  const p = env.preset;
  let argv: string[];
  if (s.script !== undefined) {
    writeFile(d.script, s.script);
    argv = [p.shell, "-e", d.script];
  } else {
    argv = s.command!;
  }
  const lim = ulimits(s);
  const out = new Tail(s.output_limit);
  const err = new Tail(s.output_limit);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(BASH, ["-c", WRAPPER, "gosidian-exec", String(lim.processes), String(lim.fileKiB), String(lim.cpu), ...argv], {
      cwd: d.work,
      env: stepEnv(p, s, d),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      ...(user ?? {}),
    });
    let timedOut = false;
    let canceled = false;
    let exited: { code: number | null; sig: NodeJS.Signals | null; ms: number } | undefined;
    let done = false;
    let hard: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    const stop = (why: "timeout" | "canceled") => {
      if (exited || timedOut || canceled) return;
      if (why === "timeout") timedOut = true;
      else canceled = true;
      kill(child.pid, "SIGTERM", user);
      hard = setTimeout(() => kill(child.pid, "SIGKILL", user), 3000);
    };
    const timer = setTimeout(() => stop("timeout"), s.timeout * 1000);
    const onAbort = () => stop("canceled");
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (b: Buffer) => out.push(b));
    child.stderr!.on("data", (b: Buffer) => err.push(b));
    const finish = () => {
      if (done || !exited) return;
      done = true;
      if (drain) clearTimeout(drain);
      resolve({
        exit_code: exited.code,
        signal: exited.sig,
        timed_out: timedOut,
        canceled,
        stdout: out.text(),
        stderr: err.text(),
        truncated: out.truncated || err.truncated,
        seconds: Math.round(exited.ms) / 1000,
        out: d.out,
      });
    };
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (hard) clearTimeout(hard);
      signal.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("exit", (code, sig) => {
      exited = { code, sig, ms: Date.now() - started };
      clearTimeout(timer);
      if (hard) clearTimeout(hard);
      signal.removeEventListener("abort", onAbort);
      // Every process of the slot's user, of another group too, which may
      // hold the pipes; without one, what is left of its group.
      if (user) killUser(user);
      else kill(child.pid, "SIGKILL");
      // Without a slot's user, a process of another session may keep the
      // pipes open: what came is enough.
      drain = setTimeout(() => {
        child.stdout!.destroy();
        child.stderr!.destroy();
        finish();
      }, 2000);
    });
    child.on("close", finish);
  });
}

// killUser stops every process of a slot's user.
function killUser(user: { uid: number; gid: number }): void {
  spawnSync("/bin/sh", ["-c", "kill -9 -1 2>/dev/null; true"], { ...user, env: { PATH: "/usr/bin:/bin" }, stdio: "ignore", timeout: 5000 });
}

// kill signals the step's process group. As the slot's user: root without
// CAP_KILL may not signal another user's processes.
function kill(pid: number | undefined, sig: NodeJS.Signals, user?: { uid: number; gid: number }): void {
  if (!pid) return;
  if (user) {
    spawnSync("/bin/sh", ["-c", 'kill -s "$0" "-$1" 2>/dev/null; true', sig.replace(/^SIG/, ""), String(pid)], { ...user, env: { PATH: "/usr/bin:/bin" }, stdio: "ignore", timeout: 5000 });
    return;
  }
  try {
    process.kill(-pid, sig);
  } catch {
    // gone already
  }
}

// The step's user empties what it wrote: its folders, a read-only one
// too (Go's module cache); the server removes the rest.
const EMPTY = 'chmod -R u+rwX -- "$@" 2>/dev/null; for d in "$@"; do rm -rf -- "$d"/* "$d"/.[!.]* "$d"/..?* 2>/dev/null; done; true';

// removeStep removes a step's folder. The server, root without
// CAP_DAC_OVERRIDE, can neither read nor empty a folder the script made
// with mode 0700, or 0555: the step's user empties its folders first (a
// project's cache, a link, stays). A folder left behind is logged; it
// never fails the step, whose result is made.
function removeStep(d: Dirs, user: { uid: number; gid: number } | undefined, log: Env["log"]): void {
  const own = [d.home, d.tmp, d.work, d.cache].filter((x) => {
    try {
      return fs.lstatSync(x).isDirectory();
    } catch {
      return false;
    }
  });
  if (own.length) {
    spawnSync("/bin/sh", ["-c", EMPTY, "sh", ...own], { env: { PATH: "/usr/bin:/bin" }, cwd: "/", stdio: "ignore", timeout: 120_000, ...(user ?? {}) });
  }
  try {
    fs.rmSync(d.root, { recursive: true, force: true });
  } catch (e) {
    log("a step's folder was left behind", { dir: d.root, error: (e as Error).message });
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
