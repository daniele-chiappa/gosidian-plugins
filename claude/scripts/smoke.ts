// The harness of smoke-test.sh: waits for the plugin to install Claude Code
// and probe its aliases, then calls run (haiku, a prompt of two words),
// version and usage through MCP, as gosidian would, and prints what they
// answer. It never sees the credential.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const plugin = process.env.PLUGIN_URL ?? "http://claude-plugin:8000";
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const t0 = Date.now();
let health: any = {};
for (let i = 0; i < 300; i++) {
  try {
    health = await (await fetch(`${plugin}/health`)).json();
    if (health.claude_code) break;
  } catch {
    // not up yet
  }
  await sleep(2000);
}
console.log(`installed: ${health.claude_code} after ${Math.round((Date.now() - t0) / 1000)} s (${health.state}${health.error ? `, ${health.error}` : ""})`);
if (!health.claude_code) process.exit(1);
const c = new Client({ name: "smoke-test", version: "0" });
await c.connect(new StreamableHTTPClientTransport(new URL(`${plugin}/mcp`), { requestInit: { headers: { Authorization: "Bearer t0k" } } }));
const call = async (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) => {
  const r: any = await c.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }, undefined, { timeout: 900_000 });
  if (r.isError) {
    console.log(`${name} FAILED: ${r.content?.[0]?.text}`);
    return undefined;
  }
  return r.structuredContent;
};
// The probe after the first install: the aliases appear in version.
let ver: any;
for (let i = 0; i < 120; i++) {
  ver = await call("version", {});
  if (ver && Object.keys(ver.aliases ?? {}).length) break;
  await sleep(3000);
}
const run: any = await call("run", { prompt: "Rispondi solo: ok", model: "haiku" }, { "gosidian/llm_tokens_left": 500000 });
console.log("run:", JSON.stringify(run, null, 2));
console.log("version:", JSON.stringify({ ...ver, models: (ver?.models ?? []).map((m: any) => `${m.id} [${m.effort.join(",")}]`) }, null, 2));
console.log("usage:", JSON.stringify(await call("usage", {}), null, 2));
await c.close();
if (!run || run.subtype !== "success") process.exit(1);
