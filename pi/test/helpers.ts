// Shared pieces of the tests: a preset for an endpoint, an Env, and a
// server that hands files by reference as gosidian does.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { parsePreset, type Preset } from "../src/preset.ts";
import { LLMProxy } from "../src/proxy.ts";
import type { Env } from "../src/run.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PI_BIN = path.join(here, "..", "node_modules", ".bin", "pi");

export function preset(baseUrl: string, extra = "", allowed = "[read, ls, write]"): Preset {
  return parsePreset(`
name: pi-test
endpoint:
  base_url: ${baseUrl}
  body:
    provider: {data_collection: deny}
models:
  - id: vendor/model-a
    name: a
    max_output: 800
    cost: {input: 2, output: 10}
    sampling: {temperature: 0.2}
  - id: model-b
    name: b
    body:
      provider: {order: [first]}
tools:
  allowed: ${allowed}
  default: [read, ls]
limits:
  default: {max_turns: 6, max_seconds: 60, max_tokens: 50000, max_cost: 1}
  max: {max_turns: 20, max_seconds: 120, max_tokens: 100000, max_cost: 2}
system: Rispondi in italiano.
${extra}`);
}

export interface TestEnv {
  env: Env;
  close(): Promise<void>;
}

export async function testEnv(p: Preset, key = "sk-test"): Promise<TestEnv> {
  const proxy = new LLMProxy({ baseUrl: p.endpoint.base_url, key, body: p.endpoint.body, models: Object.fromEntries(p.models.map((m) => [m.id, m.body])) });
  await proxy.listen();
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runs-"));
  const logs: string[] = [];
  return {
    env: {
      preset: p,
      proxy,
      piBin: PI_BIN,
      runsDir,
      maxFilesBytes: 1 << 20,
      maxOutFiles: 5,
      maxOutBytes: 1 << 20,
      log: (m) => logs.push(m),
    },
    close: async () => {
      await proxy.close();
      fs.rmSync(runsDir, { recursive: true, force: true });
    },
  };
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

export function stepDirs(env: Env): string[] {
  return fs.readdirSync(env.runsDir);
}

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: os.tmpdir() };

// git runs git in cwd as a test's user, with a name and main as the first
// branch.
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, env: gitEnv, encoding: "utf8" });
}

// origin makes a bare repository with a commit on main: a.txt.
export function origin(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-origin-"));
  const bare = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  git(dir, "init", "--quiet", "--bare", bare);
  git(dir, "init", "--quiet", seed);
  fs.writeFileSync(path.join(seed, "a.txt"), "one\ntwo\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "push", "--quiet", bare, "main");
  return bare;
}
