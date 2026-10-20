// Shared pieces of the tests: a zip writer that writes what a real tool
// would and what an attacker would (links, devices, lies about sizes,
// encrypted entries), a preset, a server that hands files by reference as
// gosidian does, the plugin started on free ports, raw HTTP requests.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parsePreset, type Preset } from "../src/preset.ts";
import { start, type App } from "../src/server.ts";

export interface ZEntry {
  name: string;
  data?: Buffer | string;
  // 8 deflate (the default), 0 stored; another number is written as the
  // method, with the data stored.
  method?: number;
  // A Unix mode with its type, in the external attributes; default
  // 0o100644, a folder's 0o040755.
  mode?: number;
  // The general purpose flags: 0x800 (UTF-8 names) is always set; 1 says
  // encrypted.
  flags?: number;
  // The size the headers declare, when it lies.
  declaredSize?: number;
}

// zip writes a zip archive of the entries, as the format says.
export function zip(entries: ZEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const dir = e.name.endsWith("/");
    const data = Buffer.from(e.data ?? "");
    const method = e.method ?? (dir ? 0 : 8);
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const size = e.declaredSize ?? data.length;
    const flags = 0x800 | (e.flags ?? 0);
    const mode = e.mode ?? (dir ? 0o040755 : 0o100644);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// site is a small app: a page, a script, a module, its data.
export function site(extra: ZEntry[] = []): ZEntry[] {
  return [
    { name: "index.html", data: `<!doctype html><meta charset="utf-8"><title>App</title><h1>Ciao</h1><script src="app.js"></script>` },
    { name: "app.js", data: "document.title = 'App ok';\n" },
    { name: "assets/", mode: 0o040755 },
    { name: "assets/data.json", data: '{"giorni": 3}\n' },
    ...extra,
  ];
}

export function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function preset(extra = "", env: Record<string, string> = {}): Preset {
  return parsePreset(`name: preview-test\nstore_dir: ${tmp("preview-store-")}\n${extra}`, "preset", env);
}

// fileServer hands the given files at /f/<name>, as gosidian's tickets do,
// and makes the reference a node gets.
export async function fileServer(): Promise<{ ref: (name: string, data: Buffer, lie?: Partial<{ size: number; sha256: string }>) => any; close(): Promise<void> }> {
  const files = new Map<string, Buffer>();
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "").replace(/^\/f\//, ""));
    const f = files.get(name);
    if (!f) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/zip" }).end(f);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/f/`;
  let n = 0;
  return {
    ref: (name, data, lie = {}) => {
      const key = `${++n}-${name}`;
      files.set(key, data);
      return { name, mime: "application/zip", size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex"), url: base + encodeURIComponent(key), ...lie };
    },
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

export interface TestApp {
  app: App;
  preset: Preset;
  mcpURL: string;
  httpURL: string;
  clock: { now: number };
  logs: string[];
  client(): Promise<Client>;
  call(c: Client, name: string, args: Record<string, unknown>, project?: string | null): Promise<any>;
  close(): Promise<void>;
}

// startApp starts the plugin on free ports, its public_url the HTTP
// port's at host (what a browser elsewhere reaches), with a clock the test
// moves.
export async function startApp(p: Preset, host = "127.0.0.1"): Promise<TestApp> {
  const clock = { now: Date.now() };
  const logs: string[] = [];
  const app = await start({ preset: p, token: "t0k", port: 0, httpPort: 0, now: () => clock.now, sweepEvery: 0, log: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`) });
  const httpPort = (app.http.address() as AddressInfo).port;
  p.public_url = `http://${host}:${httpPort}`;
  const clients: Client[] = [];
  const mcpURL = `http://127.0.0.1:${(app.mcp.address() as AddressInfo).port}/mcp`;
  return {
    app,
    preset: p,
    mcpURL,
    httpURL: `http://127.0.0.1:${httpPort}`,
    clock,
    logs,
    async client() {
      const c = new Client({ name: "gosidian-test", version: "0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(mcpURL), { requestInit: { headers: { Authorization: "Bearer t0k" } } }));
      clients.push(c);
      return c;
    },
    call: (c, name, args, project = "demo") =>
      c.callTool({ name, arguments: args, ...(project === null ? {} : { _meta: { "gosidian/project": project, "gosidian/run": "r1" } }) }, undefined, { timeout: 300_000 }),
    async close() {
      for (const c of clients) await c.close();
      await app.close();
      fs.rmSync(p.store_dir, { recursive: true, force: true });
    },
  };
}

export interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

// raw sends a request whose path goes as it is: no client normalizes it.
export function raw(base: string, p: string, method = "GET", headers: Record<string, string> = {}): Promise<Raw> {
  const u = new URL(base);
  return new Promise((ok, fail) => {
    const req = http.request({ host: u.hostname, port: u.port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", fail);
    req.end();
  });
}

// publishSite publishes the entries as a zip and gives the node's output.
export async function publishSite(t: TestApp, c: Client, files: Awaited<ReturnType<typeof fileServer>>, entries: ZEntry[], args: Record<string, unknown> = {}, project = "demo"): Promise<any> {
  const r = await t.call(c, "publish", { site: files.ref("site.zip", zip(entries)), ...args }, project);
  if (r.isError) throw new Error(r.content[0].text);
  return r.structuredContent;
}
