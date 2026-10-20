// A command of the plugin's server (git, ssh): its arguments as a list,
// never through a shell, an environment of its own, a time limit, and its
// output kept within a cap.
import { spawn } from "node:child_process";

export interface ExecOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  input?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT = 4 << 20;

export class ExecError extends Error {}

// exec runs cmd and gives its output; a code other than 0 is an ExecError
// with the end of what it said on stderr.
export async function exec(cmd: string, args: string[], o: ExecOptions): Promise<ExecResult> {
  const r = await run(cmd, args, o);
  if (r.code !== 0) {
    const said = (r.stderr || r.stdout).trim().split("\n").slice(-6).join("\n");
    throw new ExecError(`${cmd} ${args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? ""}: exit ${r.code}${said ? `: ${said}` : ""}`);
  }
  return r;
}

// run runs cmd and gives its code and output, whatever the code.
export function run(cmd: string, args: string[], o: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const keep = (s: string, add: Buffer) => (s.length < MAX_OUTPUT ? s + add.toString("utf8") : s);
    child.stdout!.on("data", (b: Buffer) => (stdout = keep(stdout, b)));
    child.stderr!.on("data", (b: Buffer) => (stderr = keep(stderr, b)));
    const stop = () => child.kill("SIGKILL");
    const timer = o.timeoutMs ? setTimeout(stop, o.timeoutMs) : undefined;
    o.signal?.addEventListener("abort", stop, { once: true });
    const end = (f: () => void) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener("abort", stop);
      f();
    };
    child.on("error", (err) => end(() => reject(err)));
    child.on("close", (code, sig) => end(() => resolve({ code: code ?? (sig ? 128 : 1), stdout, stderr })));
    if (child.stdin) {
      // A command that stops reading early closes the pipe: what it did
      // not read is its business, its code says the rest.
      child.stdin.on("error", () => {});
      child.stdin.end(o.input);
    }
  });
}
