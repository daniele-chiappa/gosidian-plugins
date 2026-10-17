// The plugin as gosidian sees it: the bearer, the manifest (nodes for the
// pipelines, tools with their access for the agents), run with the tokens
// left in its _meta and a file given back as a resource, version, update
// and usage.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mockAPI } from "./mock-api.ts";
import { fake, FakeInstaller, FakeRegistry, preset, TOKEN } from "./helpers.ts";
import { start } from "../src/server.ts";

test("gosidian's view: bearer, manifest, run, version, update, usage", async () => {
  const api = await mockAPI();
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-srv-"));
  const versionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-srv-v-"));
  const logs: string[] = [];
  const registry = new FakeRegistry({ latest: "1.0.0" });
  const app = await start({
    preset: preset(api.url),
    credential: TOKEN,
    token: "t0k",
    port: 0,
    workers: 1,
    versionsDir,
    installer: new FakeInstaller(),
    registry,
    env: { runsDir, maxFilesBytes: 1 << 20, maxOutFiles: 5, maxOutBytes: 1 << 20, log: (m, f) => void logs.push(JSON.stringify({ m, ...f })) },
  });
  const url = `http://127.0.0.1:${(app.server.address() as any).port}`;
  try {
    assert.equal((await fetch(url + "/mcp", { method: "POST", body: "{}" })).status, 401);
    let health = await (await fetch(url + "/health")).json();
    assert.equal(health.agent, "claude-test");
    assert.equal(health.claude_code, null, "nothing installed before the first install");
    await app.versions.ensure();
    await app.versions.probing;
    health = await (await fetch(url + "/health")).json();
    assert.equal(health.claude_code, "1.0.0");

    const client = new Client({ name: "gosidian-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp"), { requestInit: { headers: { Authorization: "Bearer t0k" } } }));
    const man: any = (await client.callTool({ name: "gosidian_manifest", arguments: {} })).structuredContent;
    assert.equal(man.name, "claude-test");
    assert.equal(man.gosidian, 1);
    assert.deepEqual(man.nodes.map((n: any) => [n.name, n.tool]), [["run", "run"], ["version", "version"], ["update", "update"], ["usage", "usage"]]);
    assert.deepEqual(man.tools.map((n: any) => [n.name, n.access]), [["run", "write"], ["version", "read"], ["update", "write"], ["usage", "read"]]);
    assert.deepEqual(man.nodes[0].files, ["files"]);
    assert.equal(man.nodes[0].file_refs, true);
    assert.equal(man.nodes[1].files, undefined);
    assert.deepEqual(man.permissions, { files: true, network: ["gosidian", new URL(api.url).host, "registry.npmjs.org"] });
    assert.deepEqual(man.nodes[0].input_schema.properties.model.enum, ["sonnet", "haiku"]);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((t) => t.name), ["gosidian_manifest", "run", "version", "update", "usage"]);

    const res: any = await client.callTool({ name: "run", arguments: { prompt: fake({ write: { "fig 1.md": "x" }, text: "ok ![](fig 1.md)" }), tools: ["Write"] }, _meta: { "gosidian/llm_tokens_left": 5000, "gosidian/project": "rag", "gosidian/run": "r-1" } });
    assert.ok(!res.isError, JSON.stringify(res.content));
    assert.equal(res.structuredContent.text, "ok ![](fig 1.md)");
    assert.equal(res.structuredContent.usage.total_tokens, 1155);
    assert.equal(res.structuredContent.model, "claude-sonnet-4-5-20251001");
    const resource = res.content.find((c: any) => c.type === "resource");
    assert.equal(decodeURIComponent(new URL(resource.resource.uri).pathname), "/fig 1.md");
    assert.equal(Buffer.from(resource.resource.blob, "base64").toString(), "x");

    const bad: any = await client.callTool({ name: "run", arguments: { prompt: "x", model: "opus" } });
    assert.ok(bad.isError);
    assert.match(bad.content[0].text, /allowed values/);
    await new Promise((ok) => setTimeout(ok, 5)); // the steps differ by their time
    const none: any = await client.callTool({ name: "run", arguments: { prompt: "x" }, _meta: { "gosidian/llm_tokens_left": 0 } });
    assert.match(none.content[0].text, /no language-model tokens left/);

    registry.tags.latest = "2.0.0";
    const ver: any = (await client.callTool({ name: "version", arguments: {} })).structuredContent;
    assert.equal(ver.installed, "1.0.0");
    assert.equal(ver.latest, "2.0.0");
    assert.equal(ver.update_available, true);
    assert.deepEqual(ver.aliases, { sonnet: "claude-sonnet-4-5-20251001", haiku: "claude-haiku-4-5-20251001" });
    assert.deepEqual(ver.models, [
      { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", effort: ["low", "medium", "high", "xhigh", "max"] },
      { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", effort: [] },
    ]);

    const aside: any = (await client.callTool({ name: "update", arguments: { switch: false } })).structuredContent;
    assert.equal(aside.switched, false);
    assert.equal(aside.new_version, "2.0.0");
    assert.deepEqual(aside.new_aliases, { sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" });
    assert.equal(aside.release_notes, "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md");
    const sw: any = (await client.callTool({ name: "update", arguments: {} })).structuredContent;
    assert.equal(sw.switched, true);
    assert.equal(sw.current, "2.0.0");
    const badUpdate: any = await client.callTool({ name: "update", arguments: { version: "newest" } });
    assert.ok(badUpdate.isError);

    const usage: any = (await client.callTool({ name: "usage", arguments: { max_age: 0 } })).structuredContent;
    assert.equal(usage.applicable, true);
    assert.equal(usage.source, "headers");
    assert.equal(usage.session.left_percent, 75);
    assert.equal(usage.week.used_percent, 50);
    assert.equal(typeof usage.min_left_percent.session, "number");
    // The steps, newest first: the one that ran, then the two that failed.
    assert.deepEqual(usage.steps.map((s: any) => [s.model, s.error ? "error" : s.subtype]), [
      [undefined, "error"],
      ["opus", "error"],
      ["claude-sonnet-4-5-20251001", "success"],
    ]);
    assert.match(usage.steps[0].error, /no language-model tokens left/);
    assert.equal(usage.steps[2].tokens, 1155);
    assert.equal(usage.steps[2].project, "rag");
    assert.equal(usage.steps[2].run, "r-1");
    assert.equal(usage.steps[2].claude_code, "1.0.0");
    const one: any = (await client.callTool({ name: "usage", arguments: { steps: 1 } })).structuredContent;
    assert.equal(one.steps.length, 1);
    const since: any = (await client.callTool({ name: "usage", arguments: { since: usage.steps[1].at } })).structuredContent;
    assert.equal(since.steps.length, 1, "only those after since");
    assert.ok((await client.callTool({ name: "usage", arguments: { since: "ieri" } })).isError);
    assert.equal(JSON.parse(fs.readFileSync(path.join(versionsDir, "steps.json"), "utf8")).length, 3, "kept in the volume");
    await client.close();
    for (const l of logs) assert.ok(!l.includes(TOKEN));
  } finally {
    await app.close();
    await api.close();
    fs.rmSync(runsDir, { recursive: true, force: true });
    fs.rmSync(versionsDir, { recursive: true, force: true });
  }
});
