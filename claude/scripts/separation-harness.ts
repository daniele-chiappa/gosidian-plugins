// The harness of separation-test.sh: a fake API, and a call of run through
// MCP whose fake Claude Code runs a shell command that looks for what it
// must not reach (the server's environment, the token, a link to a file of
// the system) and leaves a process behind. It prints what the command saw
// and exits non-zero if something leaked.
import { mockAPI } from "/app/test/mock-api.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOKEN = "sk-ant-oat01-SEPARATION-TEST";
const plugin = process.env.PLUGIN_URL ?? "http://claude-plugin:8000";
const cmd = [
  "echo uid=$(id -u)",
  "cat /proc/1/environ >/dev/null 2>&1 && echo ENVIRON-READABLE || echo environ-denied",
  "for p in /proc/[0-9]*; do [ \"$(stat -c %u $p)\" = 0 ] && cat $p/environ >/dev/null 2>&1 && echo ROOT-ENVIRON-READABLE; done; true",
  "echo token-in-env=${CLAUDE_TEST_TOKEN:-none} plugin-token=${GOSIDIAN_PLUGIN_TOKEN:-none}",
  // The pattern does not match itself: the command's own line holds it.
  `grep -l '${TOKEN.slice(0, -1)}[${TOKEN.slice(-1)}]' /proc/[0-9]*/environ /proc/[0-9]*/cmdline 2>/dev/null | sed 's/^/TOKEN-FOUND-IN /'`,
  // As Claude Code does: a folder of its own in its home, mode 0700.
  "mkdir -p -m 700 \"$HOME/.claude/backups\" && echo {} > \"$HOME/.claude/backups/b.json\" && chmod 600 \"$HOME/.claude/backups/b.json\"",
  "echo hi > out/ok.txt",
  "ln -s /etc/passwd out/link.txt",
  "nohup sleep 300 >/dev/null 2>&1 &",
  "echo done-sh",
].join("\n");
const api = await mockAPI({}, "0.0.0.0", 9000);
let health: any = {};
for (let i = 0; i < 60; i++) {
  try {
    health = await (await fetch(`${plugin}/health`)).json();
    if (health.claude_code) break;
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 500));
}
const c = new Client({ name: "separation-test", version: "0" });
await c.connect(new StreamableHTTPClientTransport(new URL(`${plugin}/mcp`), { requestInit: { headers: { Authorization: "Bearer t0k" } } }));
const prompt = "FAKE:" + JSON.stringify({ sh: cmd, text: "fine" });
const r: any = await c.callTool({ name: "run", arguments: { prompt, tools: ["Bash", "Read", "Write"] } });
await c.close();
await api.close();
const res = (r.content ?? []).filter((x: any) => x.type === "resource");
const files = res.map((x: any) => decodeURIComponent(new URL(x.resource.uri).pathname)).sort();
const sh = res.find((x: any) => x.resource.uri.endsWith("/sh.txt"));
const seen = sh ? Buffer.from(sh.resource.blob, "base64").toString() : "";
console.log(seen.trim());
console.log("files:", files.join(", "), "| skipped:", JSON.stringify(r.structuredContent?.skipped ?? []));
const up = api.requests.find((x) => x.path === "/v1/messages");
const fail: string[] = [];
if (r.isError) fail.push(`the step failed: ${r.content?.[0]?.text}`);
if (!/uid=1000[1-8]/.test(seen)) fail.push("Claude Code did not run as a slot's user");
if (/READABLE/.test(seen)) fail.push("Claude Code read the environment of a root process");
if (/TOKEN-FOUND-IN/.test(seen)) fail.push("the token is in a process Claude Code can read");
if (!/token-in-env=none plugin-token=none/.test(seen)) fail.push("the token or the plugin's token reached Claude Code's environment");
if (files.join() !== "/ok.txt,/sh.txt") fail.push(`the files given back: ${files.join()}`);
if (up?.headers.authorization !== `Bearer ${TOKEN}`) fail.push("the proxy did not put the token in the request to the API");
if (fail.length) {
  console.error("FAIL: " + fail.join("; "));
  process.exit(1);
}
console.log("ok: separate user, no secrets in reach, links refused, the proxy holds the token");
