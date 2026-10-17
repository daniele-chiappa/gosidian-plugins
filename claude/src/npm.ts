// Claude Code from the npm registry: its versions (dist-tags), and an
// install of one into a folder of the volume, without its install scripts.
// npm picks the package of the platform (linux-x64-musl in the image),
// which holds the native binary: the plugin runs that binary itself.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PACKAGE, type Installer, type Registry } from "./versions.ts";

export const NPM_REGISTRY = "https://registry.npmjs.org";

export class NpmRegistry implements Registry {
  private url: string;
  constructor(url = NPM_REGISTRY) {
    this.url = url.replace(/\/+$/, "");
  }

  async distTags(): Promise<Record<string, string>> {
    const r = await fetch(`${this.url}/-/package/${PACKAGE}/dist-tags`, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
    if (!r.ok) throw new Error(`the npm registry answered ${r.status}`);
    const tags = await r.json();
    if (!tags || typeof tags !== "object") throw new Error("the npm registry gave no dist-tags");
    return tags as Record<string, string>;
  }
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// exec runs a command with only the environment given, as user (when the
// server is root), and gives its output (1 MiB of each at most). A command
// run as another user gets umask 000: the server, root without
// CAP_DAC_OVERRIDE, can then remove what it leaves.
export function exec(cmd: string, args: string[], opts: { env: Record<string, string>; cwd?: string; user?: { uid: number; gid: number }; timeoutMs: number; umask?: string }): Promise<ExecResult> {
  return new Promise((ok, fail) => {
    const child = spawn("/bin/sh", ["-c", `umask ${opts.umask ?? "022"} && exec "$0" "$@"`, cmd, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(opts.user ?? {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      if (stdout.length < 1 << 20) stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < 1 << 20) stderr += c.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      ok({ code, stdout, stderr });
    });
  });
}

// effortLevels reads the levels --effort takes from a version's --help:
// "--effort <level>  Effort level for the current session (low, medium, …)".
export function effortLevels(help: string): string[] {
  const m = /--effort\s+<[^>]+>\s+[^(]*\(([a-z,\s]+)\)/.exec(help);
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
}

// findBinary finds the native binary npm installed under prefix: the
// platform's package (@anthropic-ai/claude-code-<platform>/claude), else
// the wrapper's bin/claude.exe when its install script made it the binary.
export function findBinary(prefix: string): string | undefined {
  const scope = path.join(prefix, "node_modules", "@anthropic-ai");
  let names: string[] = [];
  try {
    names = fs.readdirSync(scope).filter((n) => n.startsWith("claude-code-")).sort();
  } catch {
    return undefined;
  }
  for (const n of names) {
    const f = path.join(scope, n, "claude");
    if (isElf(f)) return path.relative(prefix, f);
  }
  const wrapper = path.join(scope, "claude-code", "bin", "claude.exe");
  return isElf(wrapper) ? path.relative(prefix, wrapper) : undefined;
}

function isElf(f: string): boolean {
  try {
    const fd = fs.openSync(f, "r");
    try {
      const b = Buffer.alloc(4);
      fs.readSync(fd, b, 0, 4, 0);
      return b.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export interface NpmInstallerOptions {
  npm?: string;
  registry?: string;
  // checkUser runs the new binary's --version and --help (nobody, as root).
  checkUser?: { uid: number; gid: number };
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export class NpmInstaller implements Installer {
  private o: NpmInstallerOptions;
  constructor(o: NpmInstallerOptions = {}) {
    this.o = o;
  }

  async install(version: string, dir: string): Promise<{ bin: string; effort_levels: string[] }> {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    // npm's cache and home beside the install, on the volume: the package
    // is some hundred MB, more than a small /tmp in memory may hold.
    const tmp = fs.mkdtempSync(path.join(path.dirname(dir), ".npm-"));
    try {
      const r = await exec(this.o.npm ?? "npm", [
        "install", "--prefix", dir, "--ignore-scripts", "--no-audit", "--no-fund", "--no-save",
        "--omit=dev", "--loglevel=error", `${PACKAGE}@${version}`,
      ], {
        env: {
          PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
          HOME: tmp,
          npm_config_cache: path.join(tmp, "cache"),
          npm_config_registry: this.o.registry ?? NPM_REGISTRY,
          npm_config_update_notifier: "false",
        },
        timeoutMs: 10 * 60_000,
      });
      if (r.code !== 0) throw new Error(`npm install failed (${r.code}): ${tail(r.stderr || r.stdout)}`);
      const bin = findBinary(dir);
      if (!bin) throw new Error("npm installed no native binary of Claude Code for this platform");
      fs.chmodSync(path.join(dir, bin), 0o755);
      const check = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: tmp, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
      if (this.o.checkUser) fs.chmodSync(tmp, 0o777);
      const v = await exec(path.join(dir, bin), ["--version"], { env: check, cwd: tmp, user: this.o.checkUser, timeoutMs: 60_000, umask: "000" });
      if (v.code !== 0 || !v.stdout.trim().startsWith(version)) {
        throw new Error(`the installed binary says ${JSON.stringify(v.stdout.trim().slice(0, 80))} (${v.code}), not ${version}: ${tail(v.stderr)}`);
      }
      const h = await exec(path.join(dir, bin), ["--help"], { env: check, cwd: tmp, user: this.o.checkUser, timeoutMs: 60_000, umask: "000" });
      return { bin, effort_levels: effortLevels(h.stdout) };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

function tail(s: string): string {
  return s.trim().split("\n").slice(-5).join(" ").slice(0, 600);
}
