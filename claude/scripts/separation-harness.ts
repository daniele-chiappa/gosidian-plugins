// The harness of separation-test.sh: a fake API, a fake MCP endpoint of
// gosidian's, and four calls of run through MCP. In the first three the
// fake Claude Code runs a shell command. The first looks for what it must
// not reach (the server's environment, the token, a link to a file of the
// system) and leaves a process behind. The second works on the preset's
// repository with gosidian's MCP: it tries to read the deploy key, to write
// the git folder (a hook, the configuration), to commit and push by itself,
// to move repo/, to hard-link a file only root reads, and to find the MCP
// token in a command line; then it edits a.txt, which the server commits.
// The third hard-links a file of the repository, which the server refuses
// to commit. In the fourth the fake sleeps 30 s with a max_seconds of 3:
// the server, root without CAP_KILL, must stop it at the limit. It prints
// what the commands saw and exits non-zero if something leaked or ran on;
// separation-test.sh then checks the repository and the processes left.
import http from "node:http";
import { mockAPI } from "/app/test/mock-api.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOKEN = "sk-ant-oat01-SEPARATION-TEST";
const MCP_TOKEN = "gsd_mcp_SEPARATION-TEST";
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
// The pattern does not match itself: the command's own line holds it.
const grepFor = (secret: string, where: string) => `grep -l '${secret.slice(0, -1)}[${secret.slice(-1)}]' ${where} 2>/dev/null`;
const attack = [
  "cat /repos/deploy-key >/dev/null 2>&1 && echo KEY-READABLE || echo key-denied",
  "GD=$(sed -n 's/^gitdir: //p' repo/.git)",
  "[ -d \"$GD\" ] && echo git-folder-found || echo GIT-FOLDER-MISSING",
  "(echo '#!/bin/sh' > \"$GD/hooks/pre-commit\") 2>/dev/null && echo HOOK-WRITTEN || echo hook-denied",
  "git -C repo config core.hooksPath /tmp 2>/dev/null && echo CONFIG-WRITTEN || echo config-denied",
  "git -C repo log --oneline -1 >/dev/null 2>&1 && echo git-log-ok || echo GIT-LOG-FAILED",
  "echo three >> repo/a.txt",
  "git -C repo -c user.name=x -c user.email=x@x commit -qam self >/dev/null 2>&1 && echo SELF-COMMITTED || echo commit-denied",
  "git -C repo push -q origin HEAD:refs/heads/agent/self >/dev/null 2>&1 && echo SELF-PUSHED || echo push-denied",
  "ln /tmp/root-only repo/leak.txt 2>/dev/null && echo HARDLINK-MADE || echo hardlink-denied",
  "mv repo repo-moved 2>/dev/null && echo REPO-MOVED || echo move-denied",
  `${grepFor(MCP_TOKEN, "/proc/[0-9]*/cmdline")} | sed 's/^/MCP-TOKEN-IN-CMDLINE /'`,
  "echo done-repo",
].join("\n");
const api = await mockAPI({}, "0.0.0.0", 9000);
// gosidian's MCP: 200 with the call's token, 401 without.
const mcpAuths: string[] = [];
const mcp = http.createServer(async (req, res) => {
  for await (const _ of req) {
    // the body: not read
  }
  mcpAuths.push(String(req.headers.authorization ?? ""));
  if (req.headers.authorization !== `Bearer ${MCP_TOKEN}`) return void res.writeHead(401).end();
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "gosidian", version: "0" } } }));
});
await new Promise<void>((ok) => mcp.listen(9100, "0.0.0.0", ok));
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
const meta = { "gosidian/project": "sep", "gosidian/run": "s1", "gosidian/mcp_url": "http://claude-harness:9100/mcp", "gosidian/mcp_token": MCP_TOKEN };
const r2: any = await c.callTool({ name: "run", arguments: { prompt: "FAKE:" + JSON.stringify({ sh: attack, text: "edited a.txt" }), tools: ["Bash", "Read", "Write"], repo: { name: "app" }, mcp: "read" }, _meta: meta });
const link = "ln repo/a.txt repo/a-link.txt && echo hi >> repo/a.txt";
const r3: any = await c.callTool({ name: "run", arguments: { prompt: "FAKE:" + JSON.stringify({ sh: link, text: "linked" }), tools: ["Bash"], repo: { name: "app" } }, _meta: { "gosidian/run": "s2" } });
// A step past its max_seconds: the server, root without CAP_KILL, must
// stop the slot's Claude Code at the limit, not when it ends by itself.
const t4 = Date.now();
const r4: any = await c.callTool({ name: "run", arguments: { prompt: "FAKE:" + JSON.stringify({ sleep: 30, text: "late" }), max_seconds: 3 } });
const took4 = (Date.now() - t4) / 1000;
await c.close();
await api.close();
mcp.close();
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

const res2 = (r2.content ?? []).filter((x: any) => x.type === "resource");
const sh2 = res2.find((x: any) => x.resource.uri.endsWith("/sh.txt"));
const seen2 = sh2 ? Buffer.from(sh2.resource.blob, "base64").toString() : "";
console.log(seen2.trim());
const o2 = r2.structuredContent ?? {};
console.log("repo:", JSON.stringify(o2.repo), "| mcp:", JSON.stringify(o2.mcp));
if (r2.isError) fail.push(`the step on the repository failed: ${r2.content?.[0]?.text}`);
for (const want of ["key-denied", "git-folder-found", "hook-denied", "config-denied", "git-log-ok", "commit-denied", "push-denied", "hardlink-denied", "move-denied", "done-repo"]) {
  if (!seen2.includes(want)) fail.push(`the step on the repository: no ${want}`);
}
if (/KEY-READABLE|HOOK-WRITTEN|CONFIG-WRITTEN|SELF-COMMITTED|SELF-PUSHED|HARDLINK-MADE|REPO-MOVED|MCP-TOKEN-IN-CMDLINE/.test(seen2)) fail.push("the agent did what it must not on the repository");
if (!(o2.repo?.pushed && o2.repo?.changed === 1 && /^agent\/s1-[0-9a-f]{16}$/.test(o2.repo?.branch ?? ""))) fail.push(`the server's commit: ${JSON.stringify(o2.repo)}`);
if (o2.mcp?.status !== "connected" || !mcpAuths.includes(`Bearer ${MCP_TOKEN}`)) fail.push(`gosidian's MCP: ${JSON.stringify(o2.mcp)}`);
if (JSON.stringify(r2).includes(MCP_TOKEN)) fail.push("the MCP token is in the answer");
const said3 = String(r3.content?.[0]?.text ?? "");
console.log("hard link:", said3);
if (!r3.isError || !/a(-link)?\.txt is a hard link: nothing committed/.test(said3)) fail.push("a hard link in repo/ did not make the commit refuse");
const said4 = String(r4.content?.[0]?.text ?? "");
console.log(`max_seconds 3, a sleep of 30 s: ${took4.toFixed(1)} s: ${said4}`);
if (!r4.isError || !/stopped at max_seconds \(3 s\)/.test(said4)) fail.push("a step past its max_seconds did not fail with max_seconds");
if (took4 > 13) fail.push(`a step past its max_seconds (3 s) ran ${took4.toFixed(1)} s: the server could not stop Claude Code`);
if (fail.length) {
  console.error("FAIL: " + fail.join("; "));
  process.exit(1);
}
console.log("ok: separate user, no secrets in reach, links refused, the proxy holds the token");
console.log("ok: the repository's key and git folder out of reach, the server commits the plain edit, a hard link commits nothing; the MCP token in no command line");
console.log("ok: a step past its max_seconds is stopped at the limit");
