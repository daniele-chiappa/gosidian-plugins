// The harness of separation-test.sh: a fake endpoint that has the agent run
// bash to look for what it must not reach, and a call of run through MCP.
// It prints what the agent saw and exits non-zero if something leaked.
import { mockLLM } from "/app/test/mock-llm.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const plugin = process.env.PLUGIN_URL ?? "http://pi-plugin:8000";
const cmd = [
  "echo uid=$(id -u)",
  "cat /proc/1/environ >/dev/null 2>&1 && echo ENVIRON-READABLE || echo environ-denied",
  "for p in /proc/[0-9]*; do [ \"$(stat -c %u $p)\" = 0 ] && cat $p/environ >/dev/null 2>&1 && echo ROOT-ENVIRON-READABLE; done; true",
  "echo key-in-env=${PI_TEST_KEY:-none} token-in-env=${GOSIDIAN_PLUGIN_TOKEN:-none}",
  "echo hi > out/ok.txt",
  "ln -s /etc/passwd out/link.txt",
  "nohup sleep 300 >/dev/null 2>&1 &",
  "echo done-bash",
].join("\n");
const llm = await mockLLM([{ toolCalls: [{ name: "bash", args: { command: cmd } }] }, { text: "fine" }], "0.0.0.0", 9000);
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
const r: any = await c.callTool({ name: "run", arguments: { prompt: "separation test", tools: ["bash", "read", "write"] } });
await c.close();
await llm.close();
const tool = llm.requests[1]?.messages?.find((m: any) => m.role === "tool");
const seen = typeof tool?.content === "string" ? tool.content : JSON.stringify(tool?.content ?? "");
const files = (r.content ?? []).filter((x: any) => x.type === "resource").map((x: any) => decodeURIComponent(new URL(x.resource.uri).pathname));
console.log(seen.trim());
console.log("files:", files.join(", "), "| skipped:", JSON.stringify(r.structuredContent?.skipped ?? []));
const fail: string[] = [];
if (r.isError) fail.push(`the step failed: ${r.content?.[0]?.text}`);
if (!/uid=1000[1-8]/.test(seen)) fail.push("pi did not run as a slot's user");
if (/READABLE/.test(seen)) fail.push("pi read the environment of a root process");
if (!/key-in-env=none token-in-env=none/.test(seen)) fail.push("the key or the plugin's token reached pi's environment");
if (files.join() !== "/ok.txt") fail.push(`the files given back: ${files.join()}`);
if (fail.length) {
  console.error("FAIL: " + fail.join("; "));
  process.exit(1);
}
console.log("ok: separate user, no secrets in reach, links refused");
