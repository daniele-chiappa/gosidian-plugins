// Shared pieces of the tests: a preset, an Env, a server that hands files
// by reference as gosidian does, repositories on disk, and a fake ssh that
// runs the host's commands here.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { parsePreset, type Preset } from "../src/preset.ts";
import type { Env } from "../src/run.ts";

export const never = new AbortController().signal;

export function preset(extra = "", name = "exec-test"): Preset {
  return parsePreset(`
name: ${name}
limits:
  default: {timeout: 60}
  max: {timeout: 120, processes: 1024}
env:
  FROM_PRESET: preset
  SHARED: preset
${extra}`);
}

export function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface TestEnv {
  env: Env;
  logs: string[];
  close(): void;
}

export function testEnv(p: Preset, more: Partial<Env> = {}): TestEnv {
  const runsDir = tmp("exec-runs-");
  const logs: string[] = [];
  return {
    env: {
      preset: p,
      runsDir,
      maxFilesBytes: 1 << 20,
      maxOutFiles: 5,
      maxOutBytes: 1 << 20,
      ssh: "ssh",
      image: "",
      log: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`),
      ...more,
    },
    logs,
    close: () => removeAll(runsDir),
  };
}

// removeAll removes a folder of a test, read-only folders in it too.
export function removeAll(dir: string): void {
  try {
    execFileSync("chmod", ["-R", "u+rwX", dir], { stdio: "ignore" });
  } catch {
    // gone, or nothing to open
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

export function stepDirs(env: Env): string[] {
  return fs.readdirSync(env.runsDir);
}

// fileServer hands the given files at /f/<name>, as gosidian's tickets do,
// and makes the references a node gets.
export async function fileServer(files: Record<string, string>): Promise<{ refs: (lie?: Record<string, Partial<{ size: number; sha256: string }>>) => any[]; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "").replace(/^\/f\//, ""));
    if (!(name in files)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/octet-stream" }).end(files[name]);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/f/`;
  return {
    refs: (lie = {}) =>
      Object.entries(files).map(([name, data]) => ({
        name,
        mime: "text/plain",
        size: Buffer.byteLength(data),
        sha256: crypto.createHash("sha256").update(data).digest("hex"),
        url: base + encodeURIComponent(name),
        ...(lie[name] ?? {}),
      })),
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: os.tmpdir() };

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, env: gitEnv, encoding: "utf8" }).trim();
}

// origin makes a bare repository: main with a.txt (tagged v1), then a
// second commit on main, and a branch feature with b.txt. It gives the
// commits.
export function origin(): { url: string; v1: string; main: string; feature: string } {
  const dir = tmp("exec-origin-");
  const bare = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  git(dir, "init", "--quiet", "--bare", bare);
  git(dir, "init", "--quiet", seed);
  fs.writeFileSync(path.join(seed, "a.txt"), "one\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "one");
  git(seed, "tag", "v1");
  const v1 = git(seed, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(seed, "a.txt"), "two\n");
  git(seed, "commit", "--quiet", "-am", "two");
  const main = git(seed, "rev-parse", "HEAD");
  git(seed, "checkout", "--quiet", "-b", "feature");
  fs.writeFileSync(path.join(seed, "b.txt"), "feature\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "feature");
  const feature = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "--quiet", bare, "main", "feature", "v1");
  return { url: bare, v1, main, feature };
}

// alive says whether a process runs (a zombie does not).
export function alive(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^\d+ \(.*\) Z /.test(stat);
  } catch {
    return false;
  }
}

// fakeSSH writes a fake ssh into dir: it reads ssh's options as the plugin
// gives them, logs them, checks the pinned host keys for the fake key
// "fake-host-key-ok", and runs the command here with sh, as the host would.
// A host named down refuses the connection; on a host named bare, only the
// tools of bin/ are in the PATH (no timeout).
export function fakeSSH(dir: string): { bin: string; log: string; calls(): string[][] } {
  const bin = path.join(dir, "ssh");
  const log = path.join(dir, "ssh.log");
  const bare = path.join(dir, "bare-bin");
  fs.mkdirSync(bare, { recursive: true });
  for (const t of ["sh", "tar", "mkdir", "cat", "tail", "du", "cut", "grep", "kill", "chmod", "rm", "sleep", "id", "ls", "printf", "head", "wc", "env"]) {
    const where = execFileSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).trim();
    if (where.startsWith("/")) fs.symlinkSync(where, path.join(bare, t));
  }
  fs.writeFileSync(bin, `#!/bin/sh
# The plugin's ssh, faked: one line of the log per call, its arguments
# separated by tabs (the command's lines joined).
printf '%s\\t' "$@" | tr '\\n' ' ' >> ${JSON.stringify(log)}
echo >> ${JSON.stringify(log)}
known=
while [ $# -gt 0 ]; do
	case $1 in
	-F|-i|-p) shift 2 ;;
	-o) case $2 in UserKnownHostsFile=*) known=\${2#UserKnownHostsFile=} ;; esac; shift 2 ;;
	--) shift; break ;;
	-*) shift ;;
	*) break ;;
	esac
done
dest=$1
shift
case $dest in
*@down) echo "ssh: connect to host down port 22: Connection refused" >&2; exit 255 ;;
esac
grep -q fake-host-key-ok "$known" 2>/dev/null || { echo "Host key verification failed." >&2; exit 255; }
case $dest in
*@bare) PATH=${JSON.stringify(bare)}; export PATH ;;
esac
exec sh -c "$*"
`, { mode: 0o755 });
  return {
    bin,
    log,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t").slice(0, -1)) : []),
  };
}
