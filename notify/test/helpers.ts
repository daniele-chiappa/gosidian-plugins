// Shared pieces of the tests: fakes of what the plugin talks to (the
// Telegram Bot API with long polling, an ntfy server, an SMTP server,
// gosidian's resume address), a preset with their addresses, the plugin
// started on free ports with a clock the test moves, and its MCP client.
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parsePreset, type Preset } from "../src/preset.ts";
import { start, type App } from "../src/server.ts";
import { remember, type Secrets } from "../src/secrets.ts";

export function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

// until waits for a condition, at most ms.
export async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// The secrets of the tests: values a leak would show.
export const SECRETS: Secrets = {
  telegram_token: "424242:AAH-sEcReT-bot-token-0123456789abcdef",
  ntfy_token: "tk_sEcReTntfyToken0123456789abcd",
  smtp_user: "mailer",
  smtp_password: "sEcReT-smtp-password-42",
};
for (const v of [SECRETS.telegram_token, SECRETS.ntfy_token, SECRETS.smtp_password]) remember(v);

// Where a fake listens: 127.0.0.1 on a free port, or (the separation
// test's harness) every address on a port of its own.
export interface Listen {
  port: number;
  host: string;
  name: string;
}

async function serve(handler: http.RequestListener, at?: Listen): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((ok) => server.listen(at?.port ?? 0, at?.host ?? "127.0.0.1", ok));
  return { server, url: `http://${at?.name ?? "127.0.0.1"}:${(server.address() as AddressInfo).port}` };
}

function body(req: http.IncomingMessage): Promise<string> {
  return new Promise((ok) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
  });
}

export interface TgCall {
  method: string;
  body: any;
  // sendMessage's: the message as the API gave it back.
  result?: { message_id: number; chat: { id: number } };
}

// fakeTelegram is the Bot API as the plugin uses it: sendMessage,
// createForumTopic, editMessageReplyMarkup, answerCallbackQuery and
// getUpdates, whose long poll waits for an update pushed by the test.
export async function fakeTelegram(token = SECRETS.telegram_token, at?: Listen) {
  const calls: TgCall[] = [];
  const updates: any[] = [];
  const waiting = new Set<() => void>();
  let nextMessage = 100;
  let nextThread = 500;
  let nextUpdate = 1;
  // fail: a method's next answers, by the test.
  const fail: Record<string, { code: number; description: string; retry_after?: number }[]> = {};
  const { server, url } = await serve(async (req, res) => {
    const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(req.url ?? "");
    const reply = (status: number, j: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(j));
    if (!m || req.method !== "POST") return reply(404, { ok: false, error_code: 404, description: "Not Found" });
    const b = JSON.parse((await body(req)) || "{}");
    if (m[1] !== token) return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });
    const method = m[2];
    const call: TgCall = { method, body: b };
    if (method !== "getUpdates") calls.push(call);
    const f = fail[method]?.shift();
    if (f) return reply(f.code, { ok: false, error_code: f.code, description: f.description, ...(f.retry_after ? { parameters: { retry_after: f.retry_after } } : {}) });
    switch (method) {
      case "sendMessage":
        call.result = { message_id: nextMessage++, chat: { id: b.chat_id } };
        return reply(200, { ok: true, result: { ...call.result, ...(b.message_thread_id ? { message_thread_id: b.message_thread_id } : {}), text: b.text } });
      case "createForumTopic":
        return reply(200, { ok: true, result: { message_thread_id: nextThread++, name: b.name, icon_color: 7322096 } });
      case "editMessageReplyMarkup":
      case "answerCallbackQuery":
        return reply(200, { ok: true, result: true });
      case "getUpdates": {
        calls.push({ method, body: b });
        const take = () => updates.filter((u) => u.update_id >= (b.offset ?? 0));
        if (!take().length) {
          await new Promise<void>((ok) => {
            const t = setTimeout(done, (b.timeout ?? 0) * 1000);
            function done() {
              clearTimeout(t);
              waiting.delete(done);
              ok();
            }
            waiting.add(done);
            req.on("close", done);
          });
        }
        if (res.destroyed) return;
        return reply(200, { ok: true, result: take() });
      }
      default:
        return reply(404, { ok: false, error_code: 404, description: "Not Found: method not found" });
    }
  }, at);
  return {
    url,
    calls,
    fail,
    of: (method: string) => calls.filter((c) => c.method === method),
    // push adds an update; a long poll waiting takes it.
    push(u: Record<string, unknown>) {
      updates.push({ update_id: nextUpdate++, ...u });
      for (const w of [...waiting]) w();
    },
    // press is a press of a button of a message, by a user id.
    press(from: number, message: { chat: number; message_id: number }, data: string) {
      const id = `cq${nextUpdate}`;
      this.push({ callback_query: { id, from: { id: from, is_bot: false, first_name: "U" }, message: { message_id: message.message_id, chat: { id: message.chat } }, chat_instance: "1", data } });
      return id;
    },
    close: () => new Promise<void>((ok) => {
      for (const w of [...waiting]) w();
      server.closeAllConnections();
      server.close(() => ok());
    }),
  };
}

// fakeNtfy takes ntfy's JSON publishing, with a token.
export async function fakeNtfy(token = SECRETS.ntfy_token) {
  const messages: any[] = [];
  const fail: { status: number; error: string }[] = [];
  const auth: string[] = [];
  const { server, url } = await serve(async (req, res) => {
    const b = await body(req);
    auth.push(String(req.headers.authorization ?? ""));
    if (req.method !== "POST" || req.url !== "/") return res.writeHead(404).end();
    if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ code: 40301, http: 403, error: "forbidden" }));
    const f = fail.shift();
    if (f) return res.writeHead(f.status, { "content-type": "application/json" }).end(JSON.stringify({ http: f.status, error: f.error }));
    const m = JSON.parse(b);
    messages.push(m);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `m${messages.length}`, event: "message", ...m }));
  });
  return { url, messages, fail, auth, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

export interface Mail {
  from: string;
  to: string[];
  data: string;
  user: string;
}

// smtpSink is an SMTP server that keeps what it gets: EHLO, AUTH PLAIN or
// LOGIN (with the user and password given, when given), MAIL, RCPT, DATA.
export async function smtpSink(creds?: { user: string; pass: string }) {
  const mails: Mail[] = [];
  const server = net.createServer((sock) => {
    let buf = "";
    let state: "cmd" | "data" | "plain" | "login-user" | "login-pass" = "cmd";
    let cur: Mail = { from: "", to: [], data: "", user: "" };
    let loginUser = "";
    let authed = !creds;
    const w = (s: string) => sock.write(s + "\r\n");
    const check = (u: string, p: string) => {
      if (!creds || (u === creds.user && p === creds.pass)) {
        authed = true;
        cur.user = u;
        w("235 2.7.0 Authentication successful");
      } else {
        w("535 5.7.8 Authentication credentials invalid");
      }
      state = "cmd";
    };
    w("220 sink ESMTP");
    sock.on("error", () => {});
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (state === "data") {
          if (line === ".") {
            mails.push(cur);
            cur = { from: "", to: [], data: "", user: cur.user };
            state = "cmd";
            w("250 2.0.0 OK queued");
          } else {
            cur.data += (line.startsWith("..") ? line.slice(1) : line) + "\r\n";
          }
          continue;
        }
        if (state === "plain") {
          const [, u, p] = Buffer.from(line, "base64").toString("utf8").split("\0");
          check(u, p);
          continue;
        }
        if (state === "login-user") {
          loginUser = Buffer.from(line, "base64").toString("utf8");
          state = "login-pass";
          w("334 UGFzc3dvcmQ6");
          continue;
        }
        if (state === "login-pass") {
          check(loginUser, Buffer.from(line, "base64").toString("utf8"));
          continue;
        }
        const [verb, ...rest] = line.split(" ");
        switch (verb.toUpperCase()) {
          case "EHLO":
            sock.write("250-sink\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n");
            break;
          case "HELO":
            w("250 sink");
            break;
          case "AUTH":
            if (rest[0]?.toUpperCase() === "PLAIN") {
              if (rest[1]) {
                const [, u, p] = Buffer.from(rest[1], "base64").toString("utf8").split("\0");
                check(u, p);
              } else {
                state = "plain";
                w("334 ");
              }
            } else if (rest[0]?.toUpperCase() === "LOGIN") {
              state = "login-user";
              w("334 VXNlcm5hbWU6");
            } else {
              w("504 5.5.4 Unrecognized authentication type");
            }
            break;
          case "MAIL":
            if (!authed) {
              w("530 5.7.0 Authentication required");
              break;
            }
            cur.from = line.replace(/^MAIL FROM:\s*/i, "");
            w("250 2.1.0 OK");
            break;
          case "RCPT":
            cur.to.push(line.replace(/^RCPT TO:\s*/i, ""));
            w("250 2.1.5 OK");
            break;
          case "DATA":
            state = "data";
            w("354 End data with <CR><LF>.<CR><LF>");
            break;
          case "RSET":
          case "NOOP":
            w("250 OK");
            break;
          case "QUIT":
            w("221 bye");
            sock.end();
            break;
          default:
            w("502 5.5.2 Command not recognized");
        }
      }
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { port: (server.address() as AddressInfo).port, mails, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

// headersOf reads a mail's headers, unfolded, names in lower case.
export function headersOf(m: Mail): Record<string, string> {
  const head = m.data.split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ");
  const out: Record<string, string> = {};
  for (const l of head.split("\r\n")) {
    const i = l.indexOf(":");
    if (i > 0) out[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
  }
  return out;
}

// words decodes a header's encoded words (RFC 2047), as a mail client does.
export function words(h: string): string {
  return h
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?utf-8\?([qb])\?([^?]*)\?=/gi, (_, enc: string, w: string) =>
      enc.toLowerCase() === "b"
        ? Buffer.from(w, "base64").toString("utf8")
        : Buffer.from(w.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_m, x) => String.fromCharCode(parseInt(x, 16))), "latin1").toString("utf8"),
    );
}

// textOf is a mail's body, quoted-printable undone.
export function textOf(m: Mail): string {
  const raw = m.data.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  const qp = /quoted-printable/i.test(headersOf(m)["content-transfer-encoding"] ?? "");
  const b64 = /base64/i.test(headersOf(m)["content-transfer-encoding"] ?? "");
  if (b64) return Buffer.from(raw.replace(/\s+/g, ""), "base64").toString("utf8");
  if (!qp) return raw;
  const bytes = raw.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return Buffer.from(bytes, "latin1").toString("utf8");
}

// fakeGosidian is gosidian's resume address: it keeps what a run got, and
// answers what the test says (200 by default).
export async function fakeGosidian(at?: Listen) {
  const resumes: { run: string; key: string; step: string | null; body: any }[] = [];
  const answers: number[] = [];
  const { server, url } = await serve(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const m = /^\/api\/v1\/runs\/([^/]+)\/resume$/.exec(u.pathname);
    const b = await body(req);
    if (!m || req.method !== "POST") return res.writeHead(404).end();
    const status = answers.shift() ?? 200;
    if (status === 200) resumes.push({ run: m[1], key: u.searchParams.get("key") ?? "", step: u.searchParams.get("step"), body: JSON.parse(b) });
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(status === 200 ? { run: { id: m[1], status: "running" } } : { error: { code: "conflict", message: "no step waits" } }));
  }, at);
  return { url, resumes, answers, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

export const KEY = "0123456789abcdef".repeat(4);
export const resumeURL = (base: string, run = "r1") => `${base}/api/v1/runs/${run}/resume?key=${KEY}`;

export interface Fakes {
  tg: Awaited<ReturnType<typeof fakeTelegram>>;
  ntfy: Awaited<ReturnType<typeof fakeNtfy>>;
  smtp: Awaited<ReturnType<typeof smtpSink>>;
  gs: Awaited<ReturnType<typeof fakeGosidian>>;
}

export async function fakes(): Promise<Fakes & { close(): Promise<void> }> {
  const [tg, ntfy, smtp, gs] = await Promise.all([fakeTelegram(), fakeNtfy(), smtpSink({ user: SECRETS.smtp_user, pass: SECRETS.smtp_password }), fakeGosidian()]);
  return { tg, ntfy, smtp, gs, close: async () => void (await Promise.all([tg.close(), ntfy.close(), smtp.close(), gs.close()])) };
}

// presetText is a preset with every channel at the fakes: people alice
// (all three), bob (ntfy and email), carol (Telegram only), dave (email
// only); groups ops and all; rooms team (Telegram topics, auto_topics,
// ntfy) and alerts (ntfy only).
export function presetText(f: Fakes, extra = ""): string {
  return `name: notify-test
store_dir: ${tmp("notify-store-")}
gosidian_url: ${f.gs.url}
time_zone: Europe/Rome
channels:
  telegram: {token_file: /run/secrets/tg, api_url: "${f.tg.url}", poll_timeout: 1}
  ntfy: {server: "${f.ntfy.url}", token_file: /run/secrets/ntfy}
  email: {host: 127.0.0.1, port: ${f.smtp.port}, security: none, user_file: /run/secrets/u, password_file: /run/secrets/p, from: "Notify <notify@example.com>"}
people:
  alice: {telegram: 1001, ntfy: alice-topic, email: alice@example.com}
  bob: {telegram: 1002, ntfy: bob-topic, email: bob@example.com}
  carol: {telegram: 1003}
  dave: {email: dave@example.com}
groups:
  ops: [alice, bob]
rooms:
  team:
    telegram: {chat: -1009, topics: {agents: 15, releases: 12}, auto_topics: true, max_auto_topics: 3}
    ntfy: team-topic
  alerts:
    ntfy: {topic: alerts-topic, topics: {errors: alerts-errors}}
${extra}`;
}

// preset is presetText parsed; extra adds keys at its top level.
export function preset(f: Fakes, extra = "", env: Record<string, string> = {}): Preset {
  return parsePreset(presetText(f, extra), "preset", env);
}

export interface TestApp {
  app: App;
  preset: Preset;
  mcpURL: string;
  pageURL: string;
  clock: { now: number };
  logs: string[];
  client(): Promise<Client>;
  call(name: string, args: Record<string, unknown>, project?: string | null, run?: string): Promise<any>;
  close(): Promise<void>;
  stop(): Promise<void>;
}

// startApp starts the plugin on free ports, its public_url the reply
// page's, at a time the test sets (default 12:00 in Rome).
export async function startApp(p: Preset, o: { now?: number; secrets?: Secrets; keepStore?: boolean } = {}): Promise<TestApp> {
  const clock = { now: o.now ?? Date.parse("2026-10-20T10:00:00Z") };
  const logs: string[] = [];
  const app = await start({ preset: p, secrets: o.secrets ?? SECRETS, token: "t0k", port: 0, httpPort: 0, now: () => clock.now, tickEvery: 0, log: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`) });
  const httpPort = (app.http.address() as AddressInfo).port;
  if (!p.public_url) p.public_url = `http://127.0.0.1:${httpPort}`;
  const mcpURL = `http://127.0.0.1:${(app.mcp.address() as AddressInfo).port}/mcp`;
  let client: Client | undefined;
  const t: TestApp = {
    app,
    preset: p,
    mcpURL,
    pageURL: `http://127.0.0.1:${httpPort}`,
    clock,
    logs,
    async client() {
      const c = new Client({ name: "gosidian-test", version: "0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(mcpURL), { requestInit: { headers: { Authorization: "Bearer t0k" } } }));
      return c;
    },
    async call(name, args, project = "demo", run = "r1") {
      client ??= await t.client();
      return client.callTool({ name, arguments: args, ...(project === null ? {} : { _meta: { "gosidian/project": project, "gosidian/run": run } }) }, undefined, { timeout: 60_000 });
    },
    async stop() {
      await client?.close();
      client = undefined;
      await app.close();
    },
    async close() {
      await t.stop();
      if (!o.keepStore) fs.rmSync(p.store_dir, { recursive: true, force: true });
    },
  };
  return t;
}

// ok calls a node and gives its output, failing on an error.
export async function ok(t: TestApp, name: string, args: Record<string, unknown>, project = "demo", run = "r1"): Promise<any> {
  const r = await t.call(name, args, project, run);
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return r.structuredContent;
}

// refused calls a node and gives the error's text, failing when it worked.
export async function refused(t: TestApp, name: string, args: Record<string, unknown>, project: string | null = "demo", run = "r1"): Promise<string> {
  const r = await t.call(name, args, project, run);
  if (!r.isError) throw new Error(`${name} worked: ${JSON.stringify(r.structuredContent)}`);
  return r.content[0].text;
}

// raw sends a request to the reply page.
export function raw(base: string, p: string, method = "GET", data?: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const u = new URL(base);
  return new Promise((ok, fail) => {
    const req = http.request({ host: u.hostname, port: u.port, path: p, method, headers: { ...(data !== undefined ? { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(data)) } : {}), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", fail);
    req.end(data);
  });
}

// at is a time of a day in Rome (UTC+2 on 2026-10-20, CEST).
export const at = (hhmm: string, day = "2026-10-20") => Date.parse(`${day}T${hhmm}:00+02:00`);
