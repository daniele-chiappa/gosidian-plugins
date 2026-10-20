// The harness of separation-test.sh: a fake endpoint that has the agent run
// bash to look for what it must not reach, a fake of gosidian's MCP, and
// calls of run through MCP: a step on its files, a step with gosidian's MCP,
// two steps on a repository, a step whose bash runs past its max_seconds.
// It prints what the agent saw and exits non-zero if something leaked or
// ran on; the branch a step pushed goes in /out/branch, for the script to
// check on the git server.
import fs from "node:fs";
import { mockLLM, type Reply } from "/app/test/mock-llm.ts";
import { mockMCP } from "/app/test/mock-mcp.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const plugin = process.env.PLUGIN_URL ?? "http://pi-plugin:8000";
const MCP_TOKEN = "gsd-separation-mcp-token";
const bash = (lines: string[]): Reply => ({ toolCalls: [{ name: "bash", args: { command: lines.join("\n") } }] });

// Each scenario: the replies of the endpoint, one per tool result so far.
const scenarios: Record<string, Reply[]> = {
  "separation test": [
    bash([
      "echo uid=$(id -u)",
      "cat /proc/1/environ >/dev/null 2>&1 && echo ENVIRON-READABLE || echo environ-denied",
      "for p in /proc/[0-9]*; do [ \"$(stat -c %u $p)\" = 0 ] && cat $p/environ >/dev/null 2>&1 && echo ROOT-ENVIRON-READABLE; done; true",
      "echo key-in-env=${PI_TEST_KEY:-none} token-in-env=${GOSIDIAN_PLUGIN_TOKEN:-none} mcp-token-in-env=${GOSIDIAN_MCP_TOKEN:-none}",
      "echo hi > out/ok.txt",
      "ln -s /etc/passwd out/link.txt",
      "nohup sleep 300 >/dev/null 2>&1 &",
      "echo done-bash",
    ]),
  ],
  "mcp test": [
    bash([
      // The token is the agent's, by design: in its environment only.
      "[ -n \"$GOSIDIAN_MCP_TOKEN\" ] && echo mcp-token-in-env || echo MCP-TOKEN-MISSING",
      // The token from the environment, as a pattern in a file: no
      // command line of these holds it.
      "n=0; for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -qF -f <(printf %s \"$GOSIDIAN_MCP_TOKEN\") && n=$((n+1)); done; echo token-in-argv=$n",
      "grep -rlF -f <(printf %s \"$GOSIDIAN_MCP_TOKEN\") \"$PI_CODING_AGENT_DIR\" \"$HOME\" 2>/dev/null | wc -l | sed 's/^ */token-in-files=/'",
      "{ echo '{}' > \"$PI_CODING_AGENT_DIR/mcp.json\"; } 2>/dev/null && echo MCPJSON-WRITABLE || echo mcpjson-denied",
      "mv \"$PI_CODING_AGENT_DIR/mcp.json\" \"$PI_CODING_AGENT_DIR/x.json\" 2>/dev/null && echo MCPJSON-MOVED || echo mcpjson-stays",
      "echo done-bash",
    ]),
    { toolCalls: [{ name: "mcp__gosidian__memory_get", args: { path: "a.md" } }] },
  ],
  "repo test": [
    bash([
      "cat /etc/gosidian-pi/deploy_key >/dev/null 2>&1 && echo KEY-READABLE || echo key-denied",
      "gd=$(sed -n 's/^gitdir: //p' repo/.git); echo gitdir=$gd",
      "touch \"$gd/hooks/post-checkout\" 2>/dev/null && echo GITDIR-WRITABLE || echo gitdir-denied",
      "{ echo '[core]' >> \"$gd/config\"; } 2>/dev/null && echo GITCONFIG-WRITABLE || echo gitconfig-denied",
      "git -C repo log --oneline -1 >/dev/null 2>&1 && echo git-reads || echo GIT-CANNOT-READ",
      "mv repo repo2 2>/dev/null && echo REPO-MOVED || echo repo-stays",
      "echo nuovo > repo/b.txt",
      "git -C repo -c core.sshCommand='ssh -i /etc/gosidian-pi/deploy_key -o BatchMode=yes -o StrictHostKeyChecking=no' push origin HEAD:refs/heads/evil >/dev/null 2>&1 && echo PUSHED || echo push-denied",
      "git -C repo -c user.name=a -c user.email=a@a commit -qam evil >/dev/null 2>&1 && echo COMMITTED || echo commit-denied",
      "echo done-bash",
    ]),
  ],
  "repo hardlink": [
    bash([
      "gd=$(sed -n 's/^gitdir: //p' repo/.git)",
      // The kernel's protected_hardlinks usually refuses a link to a file of
      // root's; the commit refuses one the agent may make.
      "ln \"$gd/config\" repo/leak-root 2>/dev/null && echo linked-root-file || echo root-link-denied",
      "echo x > repo/own && ln repo/own repo/leak-own && echo linked-own-file",
      "echo done-bash",
    ]),
  ],
  // pi's bash runs a command longer than the step's max_seconds.
  "max_seconds test": [bash(["sleep 30", "echo done-sleep"])],
};

const textOf = (m: any) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
const llm = await mockLLM((_n, body) => {
  const msgs: any[] = body.messages ?? [];
  const user = textOf(msgs.find((m) => m.role === "user"));
  const key = Object.keys(scenarios).find((k) => user.includes(k));
  const done = msgs.filter((m) => m.role === "tool").length;
  return (key && scenarios[key][done]) || { text: "fine" };
}, "0.0.0.0", 9000);
const mcp = await mockMCP({ host: "0.0.0.0", port: 9100 });

for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${plugin}/health`)).ok) break;
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 500));
}
const c = new Client({ name: "separation-test", version: "0" });
await c.connect(new StreamableHTTPClientTransport(new URL(`${plugin}/mcp`), { requestInit: { headers: { Authorization: "Bearer t0k" } } }));
const meta = { "gosidian/project": "sep", "gosidian/run": "sep-run-1" };
const call = async (args: Record<string, unknown>, more: Record<string, unknown> = {}) =>
  (await c.callTool({ name: "run", arguments: args, _meta: { ...meta, ...more } })) as any;
// What the agent's bash printed in a scenario: the first tool result.
const seen = (key: string): string => {
  const req = [...llm.requests].reverse().find((b) => textOf((b.messages ?? []).find((m: any) => m.role === "user")).includes(key) && b.messages.some((m: any) => m.role === "tool"));
  return textOf(req?.messages?.find((m: any) => m.role === "tool")).trim();
};

const fail: string[] = [];

// 1. A step on its files: the separate user, no secrets, links refused.
const r: any = await call({ prompt: "separation test", tools: ["bash", "read", "write"] });
const files = (r.content ?? []).filter((x: any) => x.type === "resource").map((x: any) => decodeURIComponent(new URL(x.resource.uri).pathname));
const s1 = seen("separation test");
console.log(s1);
console.log("files:", files.join(", "), "| skipped:", JSON.stringify(r.structuredContent?.skipped ?? []));
if (r.isError) fail.push(`the step failed: ${r.content?.[0]?.text}`);
if (!/uid=1000[1-8]/.test(s1)) fail.push("pi did not run as a slot's user");
if (/READABLE/.test(s1)) fail.push("pi read the environment of a root process");
if (!/key-in-env=none token-in-env=none mcp-token-in-env=none/.test(s1)) fail.push("the key or a token reached pi's environment");
if (files.join() !== "/ok.txt") fail.push(`the files given back: ${files.join()}`);

// 2. gosidian's MCP: pi reaches it with the call's token, which is in its
// environment only, and its configuration stays the server's.
const m: any = await call({ prompt: "mcp test", tools: ["bash"], mcp: "read" }, { "gosidian/mcp_url": "http://pi-harness:9100/mcp", "gosidian/mcp_token": MCP_TOKEN });
const s2 = seen("mcp test");
console.log(s2);
console.log("mcp:", JSON.stringify(m.structuredContent?.mcp), "| tools:", JSON.stringify(m.structuredContent?.tools), "| server saw:", mcp.seen.map((x) => x.method).join(","));
if (m.isError) fail.push(`the MCP step failed: ${m.content?.[0]?.text}`);
for (const want of ["mcp-token-in-env", "token-in-argv=0", "token-in-files=0", "mcpjson-denied", "mcpjson-stays"]) {
  if (!s2.split("\n").includes(want)) fail.push(`MCP step: no ${want}`);
}
if (m.structuredContent?.tools?.mcp__gosidian__memory_get !== 1) fail.push("pi did not call gosidian's tool");
if (!mcp.seen.length || mcp.seen.some((x) => x.auth !== `Bearer ${MCP_TOKEN}`)) fail.push("gosidian's MCP did not get the call's token");
if (JSON.stringify(m).includes(MCP_TOKEN)) fail.push("the MCP token is in the step's result");

// 3. A step on a repository: the agent edits, cannot read the deploy key,
// write the git folder, move repo/, commit or push; the plugin commits.
const g: any = await call({ prompt: "repo test", access: "exec", repo: { name: "app" } });
const s3 = seen("repo test");
console.log(s3);
console.log("repo:", JSON.stringify(g.structuredContent?.repo));
if (g.isError) fail.push(`the repository's step failed: ${g.content?.[0]?.text}`);
for (const want of ["key-denied", "gitdir-denied", "gitconfig-denied", "git-reads", "repo-stays", "push-denied", "commit-denied"]) {
  if (!s3.split("\n").includes(want)) fail.push(`repository step: no ${want}`);
}
const repo = g.structuredContent?.repo;
if (!repo?.pushed || !/^agent\/sep-run-1-[0-9a-f]{16}$/.test(repo.branch ?? "") || repo.changed !== 1) fail.push(`the repository's step: ${JSON.stringify(repo)}`);
else fs.writeFileSync("/out/branch", repo.branch);

// 4. A hard link in repo/: nothing committed, the step fails.
const h: any = await call({ prompt: "repo hardlink", access: "exec", repo: { name: "app" } });
const s4 = seen("repo hardlink");
console.log(s4);
console.log("hard link:", h.isError ? h.content?.[0]?.text : JSON.stringify(h.structuredContent?.repo));
if (!h.isError || !/is a hard link: nothing committed/.test(h.content?.[0]?.text ?? "")) fail.push("a hard link in repo/ did not stop the commit");

// 5. A step past its max_seconds (bash sleeps 30 s, the limit is 3 s): the
// server, root without CAP_KILL, stops the slot's pi at the limit, not
// when it ends by itself.
const t5 = Date.now();
const x: any = await call({ prompt: "max_seconds test", tools: ["bash"], max_seconds: 3 });
const took5 = (Date.now() - t5) / 1000;
const said5 = String(x.content?.[0]?.text ?? "");
console.log(`max_seconds 3, bash sleep 30: ${took5.toFixed(1)} s: ${said5}`);
if (!x.isError || !/stopped at max_seconds \(3 s\)/.test(said5)) fail.push("a step past its max_seconds did not fail with max_seconds");
if (took5 > 13) fail.push(`a step past its max_seconds (3 s) ran ${took5.toFixed(1)} s: the server could not stop pi`);

await c.close();
await llm.close();
await mcp.close();
if (fail.length) {
  console.error("FAIL: " + fail.join("; "));
  process.exit(1);
}
console.log("ok: separate user, no secrets in reach, links refused, gosidian's token in pi's environment only, the repository the server's");
console.log("ok: a step past its max_seconds is stopped at the limit");
