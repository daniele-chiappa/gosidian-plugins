// Shared pieces of the tests: a preset for a fake API, a fake installer and
// registry, an Env with the real proxy and version store, a server that
// hands files by reference as gosidian does, a bare repository on disk, a
// fake MCP endpoint of gosidian's and a fake Gitea.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { aliasesOf, isAnthropic, parsePreset, type Preset } from "../src/preset.ts";
import { AnthropicProxy, upstreamsOf } from "../src/proxy.ts";
import { ClaudeProber, type Env } from "../src/run.ts";
import { Subscription } from "../src/subscription.ts";
import { Versions, type Installer, type Registry } from "../src/versions.ts";
import { effortLevels } from "../src/npm.ts";
import { Slots } from "../src/server.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE = path.join(here, "fake-claude.ts");
// The subscription's token of the tests: it must never reach Claude Code,
// a log or an answer.
export const TOKEN = "sk-ant-oat01-TEST-SECRET-TOKEN-0123456789";
// The key of the tests' compatible endpoint (a bearer).
export const LOCAL_KEY = "sk-or-v1-TEST-LOCAL-KEY-9876543210";
// The prices of the compatible model, in dollars per million tokens.
export const PRICES = { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 };

// preset is the tests' preset; extra is YAML after its limits: a key of its
// own, or one of limits when indented.
export function preset(upstream: string, extra = ""): Preset {
  return parsePreset(`
name: claude-test
credentials:
  oauth_token_env: TEST_TOKEN
upstream: ${upstream}
models: [sonnet, haiku]
tools:
  allowed: [Read, Grep, Glob, Write]
  default: [Read, Grep, Glob]
system: Rispondi in italiano.
limits:
  default: {max_turns: 6, max_seconds: 60, max_cost: 1}
  max: {max_turns: 20, max_seconds: 120, max_cost: 2}
${extra}`);
}

// twoEndpoints is a preset with a subscription and a compatible endpoint
// (a bearer, OpenRouter's way): sonnet on the first, qwen and free (no
// prices, no effort) on the second.
export function twoEndpoints(anthropic: string, local: string, extra = ""): Preset {
  return parsePreset(`
name: claude-two
endpoints:
  anthropic: {url: ${anthropic}, auth: oauth, key_env: TEST_TOKEN}
  local:
    url: ${local}/api
    auth: bearer
    key_env: LOCAL_KEY
    headers: {HTTP-Referer: "https://gosidian.test", X-Title: gosidian}
models:
  - sonnet
  - name: qwen
    endpoint: local
    id: qwen/qwen3-coder
    context: 65536
    max_output: 8192
    cost: {input: ${PRICES.input}, output: ${PRICES.output}, cache_read: ${PRICES.cache_read}, cache_write: ${PRICES.cache_write}}
  - {name: free, endpoint: local, id: "llama:8b"}
tools:
  allowed: [Read, Grep, Glob, Write]
limits:
  default: {max_turns: 6, max_seconds: 60, max_cost: 1}
  max: {max_turns: 20, max_seconds: 120, max_cost: 2}
${extra}`);
}

// keysOf are the tests' keys of a preset's endpoints: the token for
// Anthropic's, LOCAL_KEY for the others.
export function keysOf(p: Preset): Record<string, string> {
  return Object.fromEntries(Object.values(p.endpoints).map((e) => [e.name, e.auth === "none" ? "" : isAnthropic(e) ? TOKEN : LOCAL_KEY]));
}

// FakeInstaller "installs" a version as a wrapper of fake-claude.ts.
export class FakeInstaller implements Installer {
  installs: string[] = [];
  fail = new Set<string>();
  async install(version: string, dir: string): Promise<{ bin: string; effort_levels: string[] }> {
    this.installs.push(version);
    if (this.fail.has(version)) throw new Error("npm install failed (1): 404 Not Found");
    fs.mkdirSync(dir, { recursive: true });
    const bin = "claude";
    fs.writeFileSync(path.join(dir, bin), `#!/bin/sh\nexec ${process.execPath} ${FAKE_CLAUDE} --fake-version ${version} "$@"\n`, { mode: 0o755 });
    const help = spawnSync(path.join(dir, bin), ["--help"], { encoding: "utf8" }).stdout;
    return { bin, effort_levels: effortLevels(help) };
  }
}

export class FakeRegistry implements Registry {
  tags: Record<string, string>;
  constructor(tags: Record<string, string> = { latest: "2.0.0", stable: "1.0.0" }) {
    this.tags = tags;
  }
  async distTags(): Promise<Record<string, string>> {
    return { ...this.tags };
  }
}

export interface TestEnv {
  env: Env;
  installer: FakeInstaller;
  registry: FakeRegistry;
  logs: string[];
  close(): Promise<void>;
}

export async function testEnv(p: Preset, o: { install?: boolean } = {}): Promise<TestEnv> {
  const logs: string[] = [];
  const log = (msg: string, fields: Record<string, unknown> = {}): void => void logs.push(JSON.stringify({ msg, ...fields }));
  let sub: Subscription | undefined;
  const proxy = new AnthropicProxy(upstreamsOf(p, keysOf(p)), { log, onHeaders: (h) => sub?.note(h) });
  await proxy.listen();
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-runs-"));
  const versionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-versions-"));
  const installer = new FakeInstaller();
  const registry = new FakeRegistry();
  const env = { preset: p, proxy, runsDir, maxFilesBytes: 1 << 20, maxOutFiles: 5, maxOutBytes: 1 << 20, log } as Env;
  const slots = new Slots(1);
  env.versions = new Versions({ dir: versionsDir, installer, prober: new ClaudeProber(env, (fn) => slots.with(fn)), registry, channel: p.version, aliases: aliasesOf(p), log });
  const endpoints = Object.values(p.endpoints);
  const oauth = endpoints.find((e) => e.auth === "oauth");
  sub = new Subscription({
    kind: oauth ? "oauth" : endpoints.some(isAnthropic) ? "api_key" : "none",
    usage: async () => {
      const r = await proxy.call(oauth!.name, "GET", "/api/oauth/usage");
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    ping: async () => {
      const r = await proxy.call(oauth!.name, "POST", "/v1/messages", { model: "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "ok" }] });
      await r.arrayBuffer();
    },
    log,
  });
  env.subscription = sub;
  if (o.install !== false) {
    await env.versions.ensure();
    await env.versions.probing;
  }
  return {
    env,
    installer,
    registry,
    logs,
    close: async () => {
      await proxy.close();
      fs.rmSync(runsDir, { recursive: true, force: true });
      fs.rmSync(versionsDir, { recursive: true, force: true });
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

// fake is the prompt of a scenario of fake-claude.ts.
export function fake(scenario: Record<string, unknown>): string {
  return "FAKE:" + JSON.stringify(scenario);
}

// git runs git without the system's or a user's configuration.
export function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: os.tmpdir() };
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, env, encoding: "utf8" });
}

// bareRepo makes a bare repository with a commit on main (a.txt), and gives
// its path.
export function bareRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-repo-"));
  const bare = path.join(dir, "app.git");
  const seed = path.join(dir, "seed");
  git(dir, "init", "--quiet", "--bare", bare);
  git(dir, "init", "--quiet", seed);
  fs.writeFileSync(path.join(seed, "a.txt"), "one\ntwo\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "push", "--quiet", bare, "main");
  return bare;
}

// mcpEndpoint stands in for gosidian's MCP: it answers 200 to the
// requests that carry the token, 401 to the others, and keeps the
// Authorization header of each.
export async function mcpEndpoint(token: string): Promise<{ url: string; auths: string[]; close(): Promise<void> }> {
  const auths: string[] = [];
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
      // the request's body: not read
    }
    auths.push(String(req.headers.authorization ?? ""));
    if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "gosidian", version: "0" } } }));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    auths,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

// fakeGitea stands in for the API of team/app on Gitea: its open pull
// requests (number: branch), each merged or closed as asked, and the
// deletion of a branch; with merge set, a merge gets that status. It keeps
// each request as "<method> <path> <body>", and its Authorization.
export async function fakeGitea(prs: Record<number, string>): Promise<{ api: string; seen: string[]; auths: string[]; merge: number; close(): Promise<void> }> {
  const state = new Map(Object.entries(prs).map(([n, head]) => [Number(n), { head, state: "open", merged: false }]));
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const p = (req.url ?? "").replace("/api/v1/repos/team/app", "");
    g.seen.push(`${req.method} ${p}${body ? " " + body : ""}`);
    g.auths.push(String(req.headers.authorization ?? ""));
    const send = (status: number, v?: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(v === undefined ? "" : JSON.stringify(v));
    if (req.method === "DELETE" && p.startsWith("/branches/")) return send(204);
    const m = /^\/pulls\/(\d+)(\/merge)?$/.exec(p);
    const pr = m ? state.get(Number(m[1])) : undefined;
    if (!m || !pr) return send(404, { message: "pull request not found" });
    if (m[2]) {
      if (g.merge) return send(g.merge, { message: "merge conflict" });
      Object.assign(pr, { state: "closed", merged: true });
      return send(200);
    }
    if (req.method === "PATCH") pr.state = "closed";
    send(req.method === "PATCH" ? 201 : 200, {
      number: Number(m[1]), html_url: `https://git.example.com/team/app/pulls/${m[1]}`, state: pr.state, merged: pr.merged,
      merge_commit_sha: pr.merged ? "c0ffee".padEnd(40, "0") : null, head: { ref: pr.head, repo: { full_name: "team/app" } },
    });
  });
  const g = { api: "", seen: [] as string[], auths: [] as string[], merge: 0, close: () => new Promise<void>((ok) => server.close(() => ok())) };
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  g.api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  return g;
}
