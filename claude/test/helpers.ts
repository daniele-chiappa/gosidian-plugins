// Shared pieces of the tests: a preset for a fake API, a fake installer and
// registry, an Env with the real proxy and version store, and a server that
// hands files by reference as gosidian does.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { isAlias, parsePreset, type Preset } from "../src/preset.ts";
import { AnthropicProxy } from "../src/proxy.ts";
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
  default: {max_turns: 6, max_seconds: 60, max_budget_usd: 1}
  max: {max_turns: 20, max_seconds: 120, max_budget_usd: 2}
${extra}`);
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
  const proxy = new AnthropicProxy({ baseUrl: p.upstream, kind: p.credentials.kind, credential: TOKEN }, { log, onHeaders: (h) => sub?.note(h) });
  await proxy.listen();
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-runs-"));
  const versionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-versions-"));
  const installer = new FakeInstaller();
  const registry = new FakeRegistry();
  const env = { preset: p, proxy, runsDir, maxFilesBytes: 1 << 20, maxOutFiles: 5, maxOutBytes: 1 << 20, log } as Env;
  const slots = new Slots(1);
  env.versions = new Versions({ dir: versionsDir, installer, prober: new ClaudeProber(env, (fn) => slots.with(fn)), registry, channel: p.version, aliases: p.models.filter(isAlias), log });
  sub = new Subscription({
    kind: p.credentials.kind,
    usage: async () => {
      const r = await proxy.call("GET", "/api/oauth/usage");
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    ping: async () => {
      const r = await proxy.call("POST", "/v1/messages", { model: "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "ok" }] });
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
