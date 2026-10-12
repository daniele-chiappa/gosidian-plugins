// The plugin as gosidian sees it: the bearer, the manifest, a call of run
// with the tokens left in its _meta, the files given back as resources.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mockLLM } from "./mock-llm.ts";
import { PI_BIN, preset } from "./helpers.ts";
import { start } from "../src/server.ts";

test("gosidian's view: bearer, manifest, run with the tokens left, files as resources", async () => {
  const llm = await mockLLM([
    { toolCalls: [{ name: "write", args: { path: "out/fig 1.md", content: "x" } }], usage: { prompt: 100, completion: 5 } },
    { text: "ok ![](fig 1.md)", usage: { prompt: 120, completion: 3 } },
  ]);
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-srv-"));
  const app = await start({
    preset: preset(llm.url),
    key: "sk-x",
    token: "t0k",
    port: 0,
    workers: 1,
    env: { piBin: PI_BIN, runsDir, maxFilesBytes: 1 << 20, maxOutFiles: 5, maxOutBytes: 1 << 20, log: () => {} },
  });
  const url = `http://127.0.0.1:${(app.server.address() as any).port}`;
  try {
    assert.equal((await fetch(url + "/mcp", { method: "POST", body: "{}" })).status, 401);
    const health = await (await fetch(url + "/health")).json();
    assert.equal(health.agent, "pi-test");

    const client = new Client({ name: "gosidian-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp"), { requestInit: { headers: { Authorization: "Bearer t0k" } } }));
    const man: any = (await client.callTool({ name: "gosidian_manifest", arguments: {} })).structuredContent;
    assert.equal(man.name, "pi-test");
    assert.equal(man.gosidian, 1);
    assert.deepEqual(man.nodes[0].files, ["files"]);
    assert.equal(man.nodes[0].file_refs, true);
    assert.deepEqual(man.permissions.network, ["gosidian", "127.0.0.1:" + new URL(llm.url).port]);
    assert.deepEqual(man.nodes[0].input_schema.properties.model.enum, ["a", "b"]);

    const res: any = await client.callTool({ name: "run", arguments: { prompt: "scrivi", tools: ["write"] }, _meta: { "gosidian/llm_tokens_left": 5000 } });
    assert.ok(!res.isError, JSON.stringify(res.content));
    assert.equal(res.structuredContent.text, "ok ![](fig 1.md)");
    assert.equal(res.structuredContent.usage.total_tokens, 228);
    assert.equal(llm.requests[0].max_completion_tokens, 800);
    const resource = res.content.find((c: any) => c.type === "resource");
    assert.equal(decodeURIComponent(new URL(resource.resource.uri).pathname), "/fig 1.md");
    assert.equal(Buffer.from(resource.resource.blob, "base64").toString(), "x");

    const bad: any = await client.callTool({ name: "run", arguments: { prompt: "x", model: "nope" } });
    assert.ok(bad.isError);
    assert.match(bad.content[0].text, /allowed values/);
    const none: any = await client.callTool({ name: "run", arguments: { prompt: "x" }, _meta: { "gosidian/llm_tokens_left": 0 } });
    assert.match(none.content[0].text, /no language-model tokens left/);
    await client.close();
  } finally {
    await app.close();
    await llm.close();
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});
