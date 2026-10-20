// A step on a host of the preset, over SSH. The server (root) runs ssh with
// the plugin's key for the host and its pinned host keys, and no agent or
// configuration (agent-kit's ssh.ts). It makes the step's folder on the
// host and sends it a tar of in/, repo/ (without its .git) and the script;
// runs the script there with the host's shell, within the timeout
// (timeout(1) on the host when it has it, else the server's); brings back
// the end of its output and out/ as another tar; and removes the folder,
// whatever happened. The host needs a POSIX sh, tar, tail and du; on Linux,
// the end of a step also stops the processes the script left behind.
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { knownHostsFile, shq, sshOptions } from "./kit/ssh.ts";
import { StepError } from "./files.ts";
import type { Host } from "./preset.ts";
import { endOf, lastLines, type Dirs, type Env, type Ran, type Settings } from "./step.ts";

// The time ssh has to send or bring back a step's files, and to remove
// its folder.
const TRANSFER_MS = 10 * 60_000;
const CLEANUP_MS = 60_000;
// The time the host's timeout(1) has before the server stops ssh itself.
const GRACE_MS = 10_000;
// The members of the tar a host gives back, besides out/.
const META_FILES = [".exit", ".stdout.tail", ".stderr.tail", ".out-skipped"];

interface SSHResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  // killed: the server stopped ssh (its time, the call's cancellation);
  // tooMuch: the host sent more than the server takes.
  killed: boolean;
  tooMuch: boolean;
}

interface SSHOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  // input feeds ssh's stdin; toFile takes its stdout, at most maxBytes.
  input?: ChildProcess;
  toFile?: string;
  maxBytes?: number;
}

// sshArgs are ssh's arguments for a command on the host.
export function sshArgs(h: Host, knownFile: string, command: string): string[] {
  return [
    ...sshOptions(h.key_file, knownFile),
    "-T", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
    "-p", String(h.port),
    "--", `${h.user}@${h.host}`, command,
  ];
}

// The variable the step's processes inherit on the host: the end of the
// step stops those that carry it, wherever they went (Linux's /proc).
function mark(id: string): string {
  return `GOSIDIAN_EXEC_STEP=${id}`;
}

function killLeft(id: string): string {
  return `for p in /proc/[0-9]*; do grep -qF -- ${shq(mark(id))} "$p/environ" 2>/dev/null && kill -9 "\${p#/proc/}" 2>/dev/null; done`;
}

// prepCommand makes the step's folder in workdir, a folder of the host's
// user (not a link, nor another's: /tmp is everyone's), unpacks the tar it
// reads there, and says whether the host has timeout(1).
export function prepCommand(h: Host, id: string): string {
  return [
    "umask 077",
    `w=${shq(h.workdir)}`,
    'mkdir -p -- "$w" 2>/dev/null',
    'if [ ! -d "$w" ] || [ -h "$w" ] || [ ! -O "$w" ]; then echo "gosidian-exec: $w is not a folder of $(id -un)\'s" >&2; exit 97; fi',
    `mkdir -- "$w/step-${id}" && cd -- "$w/step-${id}" && tar -xf - || exit 98`,
    "if command -v timeout >/dev/null 2>&1; then echo gosidian-exec-timeout; fi",
  ].join("\n");
}

// runCommand runs the step in its folder: the variables, then the script
// with the host's shell (or the command, its arguments quoted), its
// output in files (a process it leaves behind holds no pipe of ssh's), its
// exit code in .exit.
export function runCommand(h: Host, s: Settings, id: string, dir: string, timeout: boolean): string {
  const argv = s.script !== undefined ? [h.shell, "-e", "./script.sh"] : s.command!;
  const limit = timeout ? `timeout -s KILL ${s.timeout} ` : "";
  return [
    `cd -- ${shq(dir)} || exit 97`,
    `export ${mark(id)}`,
    ". ./env.sh",
    `{ ${limit}${argv.map(shq).join(" ")}; } </dev/null >.stdout 2>.stderr`,
    "echo $? >.exit",
  ].join("\n");
}

// fetchCommand stops what the step left running, keeps the end of its
// output, and writes a tar of it with its exit code and out/ (none when
// out/ is a link, or more than maxKiB).
export function fetchCommand(id: string, dir: string, keep: number, maxKiB: number): string {
  return [
    `cd -- ${shq(dir)} || exit 97`,
    killLeft(id),
    `for f in .stdout .stderr; do tail -c ${keep + 1} "$f" >"$f.tail" 2>/dev/null || : >"$f.tail"; done`,
    "[ -f .exit ] || : >.exit",
    "set -- .exit .stdout.tail .stderr.tail",
    'if [ -d out ] && [ ! -h out ]; then',
    `  if [ "$(du -sk out | cut -f1)" -le ${maxKiB} ]; then set -- "$@" out; else echo "out/ is more than ${maxKiB} KiB" >.out-skipped; set -- "$@" .out-skipped; fi`,
    "fi",
    'exec tar -cf - "$@"',
  ].join("\n");
}

// cleanupCommand stops what the step left running and removes its folder.
export function cleanupCommand(id: string, dir: string): string {
  return [killLeft(id), `d=${shq(dir)}`, '[ -d "$d" ] || exit 0', 'chmod -R u+rwX -- "$d" 2>/dev/null', 'rm -rf -- "$d"'].join("\n");
}

// envFile sets the step's variables on the host: the host's, then the
// node's.
export function envFile(h: Host, s: Settings): string {
  return Object.entries({ ...h.env, ...s.env }).map(([k, v]) => `export ${k}=${shq(v)}\n`).join("");
}

// checkNames checks the members of the tar a host gave back: its exit
// code, its output's end and out/, nothing above or beside them.
export function checkNames(names: string[]): void {
  for (const raw of names) {
    const n = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!n) continue;
    if (n.startsWith("/") || n.split("/").includes("..")) throw new StepError(`the host gave back ${JSON.stringify(raw)}: not a file of the step`);
    if (!META_FILES.includes(n) && n !== "out" && !n.startsWith("out/")) throw new StepError(`the host gave back ${JSON.stringify(raw)}: not a file of out/`);
  }
}

function hostKeyError(stderr: string): boolean {
  return /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key for .* has changed|No \S+ host key is known/i.test(stderr);
}

export async function runRemote(env: Env, h: Host, s: Settings, d: Dirs, signal: AbortSignal): Promise<Ran> {
  const known = knownHostsFile(d.private, h.known_hosts);
  const dir = `${h.workdir}/step-${d.id}`;
  const ssh = (command: string, o: SSHOptions) => runSSH(env, sshArgs(h, known, command), d.private, o);
  const fail = (what: string, r: SSHResult): never => {
    if (hostKeyError(r.stderr)) {
      throw new StepError(`host ${h.name}: its host key is not the one the preset pins (known_hosts): ${lastLines(r.stderr, 3)}`);
    }
    const how = r.killed ? "it took too long" : r.code === 255 ? "ssh failed" : `exit ${r.code}`;
    throw new StepError(`host ${h.name}: ${what} (${how}): ${lastLines(r.stderr, 3) || "no message"}`);
  };

  if (s.script !== undefined) writeFile(d.script, s.script);
  writeFile(path.join(d.root, "env.sh"), envFile(h, s));
  let started = false;
  try {
    // 1. The folder, and the step's files in it.
    const tar = spawn("tar", [
      "-c", "-f", "-", "--anchored", "--exclude=repo/.git", "--owner=0", "--group=0", "--numeric-owner",
      "-C", d.root, "env.sh", ...(s.script !== undefined ? ["script.sh"] : []),
      "-C", d.work, "in", "out", ...(fs.existsSync(d.repo) ? ["repo"] : []),
    ], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" } });
    let tarErr = "";
    tar.stderr!.on("data", (b: Buffer) => (tarErr += b.toString("utf8").slice(0, 2000)));
    const tarDone = new Promise<number | null>((ok) => tar.on("close", (code) => ok(code)));
    started = true;
    const prep = await ssh(prepCommand(h, d.id), { timeoutMs: TRANSFER_MS, signal, input: tar });
    const tarCode = await tarDone;
    if (signal.aborted) return canceledRun(d);
    if (prep.code !== 0) fail("the step's folder could not be made", prep);
    if (tarCode !== 0) throw new StepError(`the step's files could not be packed: ${lastLines(tarErr, 3)}`);
    const hasTimeout = prep.stdout.toString("utf8").includes("gosidian-exec-timeout");

    // 2. The run, within the timeout.
    const t0 = Date.now();
    const run = await ssh(runCommand(h, s, d.id, dir, hasTimeout), { timeoutMs: s.timeout * 1000 + (hasTimeout ? GRACE_MS : 0), signal });
    const ms = Date.now() - t0;
    if (signal.aborted) return canceledRun(d);
    if (!run.killed && run.code !== 0) fail("the step could not run", run);

    // 3. What it wrote and gave back.
    const back = path.join(d.root, "back");
    fs.mkdirSync(back, { mode: 0o700 });
    const file = path.join(d.root, "back.tar");
    const keep = s.output_limit;
    const max = env.maxOutBytes + 2 * (keep + 1) + (1 << 20);
    const got = await ssh(fetchCommand(d.id, dir, keep, Math.ceil(env.maxOutBytes / 1024)), { timeoutMs: TRANSFER_MS, signal, toFile: file, maxBytes: max });
    if (signal.aborted) return canceledRun(d);
    if (got.tooMuch) throw new StepError(`host ${h.name}: it gave back more than ${Math.round(max / 1048576)} MiB`);
    if (got.code !== 0) fail("the step's output could not be brought back", got);
    await untar(file, back);
    const read = (n: string) => {
      try {
        return fs.readFileSync(path.join(back, n));
      } catch {
        return Buffer.alloc(0);
      }
    };
    const code = read(".exit").toString("utf8").trim();
    const rc = /^\d+$/.test(code) ? Number(code) : null;
    // The host's timeout(1) kills with SIGKILL: 137 (124 for some), at the
    // timeout.
    const timedOut = run.killed || (hasTimeout && (rc === 137 || rc === 124) && ms >= s.timeout * 1000);
    if (rc === null && !timedOut) throw new StepError(`host ${h.name}: the step did not start: ${lastLines(read(".stderr.tail").toString("utf8") || run.stderr, 3) || "no message"}`);
    const so = read(".stdout.tail");
    const se = read(".stderr.tail");
    const skipped = read(".out-skipped").toString("utf8").trim();
    return {
      exit_code: timedOut ? null : rc,
      signal: timedOut ? "SIGKILL" : null,
      timed_out: timedOut,
      canceled: false,
      stdout: endOf(so, keep),
      stderr: endOf(se, keep),
      truncated: so.length > keep || se.length > keep,
      seconds: Math.round(ms) / 1000,
      out: path.join(back, "out"),
      ...(skipped ? { skipped: [{ name: "out/", error: skipped }] } : {}),
    };
  } finally {
    if (started) {
      const r = await ssh(cleanupCommand(d.id, dir), { timeoutMs: CLEANUP_MS }).catch((e: Error) => ({ code: null, stderr: e.message }) as SSHResult);
      if (r.code !== 0) env.log("a step's folder may be left on its host", { host: h.name, dir, error: lastLines(r.stderr, 3) });
    }
  }
}

function canceledRun(d: Dirs): Ran {
  return { exit_code: null, signal: null, timed_out: false, canceled: true, stdout: "", stderr: "", truncated: false, seconds: 0, out: path.join(d.root, "back", "out") };
}

// runSSH runs ssh with the server's own environment, none of its secrets:
// a home only it reads, no agent.
function runSSH(env: Env, args: string[], home: string, o: SSHOptions): Promise<SSHResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(env.ssh, args, {
      stdio: [o.input ? "pipe" : "ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: home, LANG: "C" },
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderr = "";
    let killed = false;
    let tooMuch = false;
    let sink: fs.WriteStream | undefined;
    const stop = () => {
      killed = true;
      child.kill("SIGKILL");
      o.input?.kill("SIGKILL");
    };
    const timer = setTimeout(stop, o.timeoutMs);
    if (o.signal?.aborted) stop();
    o.signal?.addEventListener("abort", stop, { once: true });
    if (o.input) {
      child.stdin!.on("error", () => {
        // ssh ended before reading it all: its code says why
      });
      o.input.stdout!.pipe(child.stdin!);
    }
    if (o.toFile) sink = fs.createWriteStream(o.toFile, { mode: 0o600 });
    child.stdout!.on("data", (b: Buffer) => {
      outBytes += b.length;
      if (o.maxBytes !== undefined && outBytes > o.maxBytes) {
        if (!tooMuch) {
          tooMuch = true;
          stop();
        }
        return;
      }
      if (sink) sink.write(b);
      else if (outBytes <= 64 << 10) out.push(b);
    });
    child.stderr!.on("data", (b: Buffer) => {
      if (stderr.length < 8000) stderr += b.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", stop);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", stop);
      const res = { code, stdout: Buffer.concat(out), stderr, killed, tooMuch };
      if (sink) sink.end(() => resolve(res));
      else resolve(res);
    });
  });
}

// untar unpacks the tar a host gave back into dir, after checking its
// members' names: no owner, no modes of the host's, no folder's metadata
// changed; links come out as links, which collect skips.
async function untar(file: string, dir: string): Promise<void> {
  const list = await tarRun(["-t", "-f", file]);
  checkNames(list.split("\n").filter(Boolean));
  await tarRun(["-x", "-f", file, "-C", dir, "--no-same-owner", "--no-same-permissions", "--no-overwrite-dir"]);
}

function tarRun(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" } });
    let out = "";
    let err = "";
    child.stdout!.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr!.on("data", (b: Buffer) => (err += b.toString("utf8").slice(0, 2000)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new StepError(`what the host gave back is not a tar the plugin takes: ${lastLines(err, 3)}`));
    });
  });
}

function writeFile(f: string, text: string): void {
  fs.writeFileSync(f, text, { mode: 0o600 });
}
