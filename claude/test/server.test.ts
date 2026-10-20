// The plugin as gosidian sees it: the bearer, the manifest (nodes for the
// pipelines, tools with their access for the agents), run with the tokens
// left in its _meta and a file given back as a resource, version, update
// and usage; a preset with repositories and gosidian's MCP.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mockAPI } from "./mock-api.ts";
import { bareRepo, fake, FakeInstaller, FakeRegistry, git, mcpEndpoint, preset, TOKEN } from "./helpers.ts";
import { parsePreset } from "../src/preset.ts";
import { manifest, start } from "../src/server.ts";

test("gosidian's view: bearer, manifest, run, version, update, usage", async () => {
  const api = await mockAPI();
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-srv-"));
  const versionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-srv-v-"));
  const logs: string[] = [];
  const registry = new FakeRegistry({ latest: "1.0.0" });
  const app = await start({
    preset: preset(api.url),
    credentials: { anthropic: TOKEN },
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
    assert.equal(man.nodes[0].contract, "agent-run/1");
    assert.equal(man.nodes[1].contract, undefined);
    assert.equal(man.nodes[0].mcp, undefined, "no MCP in the preset");
    for (const k of ["repo", "mcp"]) {
      assert.equal(man.nodes[0].input_schema.properties[k], undefined, k);
      assert.equal(man.nodes[0].output_schema.properties[k], undefined, k);
    }
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
    assert.deepEqual(res.structuredContent.model, { name: "sonnet", id: "claude-sonnet-4-5-20251001", endpoint: "anthropic" });
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
    assert.equal(usage.steps[2].endpoint, "anthropic");
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

test("a preset without Anthropic's endpoints: its hosts, no probe, no subscription, the steps on its models", async () => {
  const local = await mockAPI();
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-srv-"));
  const versionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-srv-v-"));
  const p = parsePreset(`
name: claude-local
endpoints:
  ollama: {url: ${local.url}, auth: none}
  vllm: {url: "http://vllm.lan:8000", auth: bearer, key_env: VLLM_KEY}
models:
  - {name: qwen3-coder, endpoint: ollama, id: "qwen3-coder:30b", context: 65536}
  - {name: glm, endpoint: vllm, id: glm-4.6}
tools: {allowed: [Read, Grep, Glob, Write]}
`);
  const app = await start({
    preset: p,
    credentials: { ollama: "", vllm: "vllm-key" },
    token: "",
    port: 0,
    workers: 1,
    versionsDir,
    installer: new FakeInstaller(),
    registry: new FakeRegistry({ latest: "2.0.0" }),
    env: { runsDir, maxFilesBytes: 1 << 20, maxOutFiles: 5, maxOutBytes: 1 << 20, log: () => {} },
  });
  const url = `http://127.0.0.1:${(app.server.address() as any).port}`;
  try {
    await app.versions.ensure();
    await app.versions.probing;
    const client = new Client({ name: "gosidian-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));
    const man: any = (await client.callTool({ name: "gosidian_manifest", arguments: {} })).structuredContent;
    assert.deepEqual(man.permissions.network, ["gosidian", new URL(local.url).host, "vllm.lan:8000", "registry.npmjs.org"]);
    assert.deepEqual(man.nodes[0].input_schema.properties.model.enum, ["qwen3-coder", "glm"]);
    const ver: any = (await client.callTool({ name: "version", arguments: {} })).structuredContent;
    assert.equal(ver.installed, "2.0.0");
    assert.deepEqual(ver.aliases, {});
    assert.match(ver.probe_skipped, /no Anthropic endpoint/);
    assert.deepEqual(ver.models, []);
    assert.equal(local.requests.length, 0, "no probe, no list of models");
    const run: any = (await client.callTool({ name: "run", arguments: { prompt: fake({}) } })).structuredContent;
    assert.deepEqual(run.model, { name: "qwen3-coder", id: "qwen3-coder:30b", endpoint: "ollama" });
    assert.equal(run.cost_source, "none");
    assert.equal(run.subscription, undefined);
    assert.equal(local.requests[0].body.model, "qwen3-coder:30b");
    assert.equal(local.requests[0].headers.authorization, undefined);
    const usage: any = (await client.callTool({ name: "usage", arguments: {} })).structuredContent;
    assert.equal(usage.applicable, false);
    assert.match(usage.reason, /no endpoint of the preset is a subscription/);
    assert.deepEqual([usage.steps[0].model, usage.steps[0].endpoint], ["qwen3-coder:30b", "ollama"]);
    await client.close();
  } finally {
    await app.close();
    await local.close();
    fs.rmSync(runsDir, { recursive: true, force: true });
    fs.rmSync(versionsDir, { recursive: true, force: true });
  }
});

test("repositories and gosidian's MCP: the manifest, a run with both, its steps' log", async () => {
  const api = await mockAPI();
  const bare = bareRepo();
  const token = "gsd_mcp_SERVER-TEST-TOKEN";
  const mcp = await mcpEndpoint(token);
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-srv-"));
  const versionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-srv-v-"));
  const p = preset(api.url, `repos:
  - {name: app, url: "${bare}"}
  - {name: web, url: "git@git.example.com:team/web.git", key_file: /run/secrets/web-key, known_hosts: "git.example.com ssh-ed25519 AAAA", pr: {kind: gitea, api: "https://gitea.example.com/api/v1", repo: team/web, token_file: /run/secrets/gitea}}
mcp: [read]`);
  const man: any = manifest(p);
  assert.equal(man.nodes[0].mcp, true);
  assert.equal(man.tools[0].mcp, undefined, "a tool of the agents takes no MCP of its own");
  assert.deepEqual(man.permissions, { files: true, network: ["gosidian", new URL(api.url).host, "git.example.com", "gitea.example.com", "registry.npmjs.org"], mcp: ["read"] });
  assert.deepEqual(man.nodes[0].input_schema.properties.mcp.enum, ["none", "read"]);
  assert.deepEqual(man.nodes[0].input_schema.properties.repo.properties.name.enum, ["app", "web"]);
  assert.ok(man.nodes[0].output_schema.properties.repo && man.nodes[0].output_schema.properties.mcp);
  const app = await start({
    preset: p,
    credentials: { anthropic: TOKEN },
    token: "",
    port: 0,
    workers: 1,
    versionsDir,
    installer: new FakeInstaller(),
    registry: new FakeRegistry({ latest: "2.0.0" }),
    env: { runsDir, maxFilesBytes: 1 << 20, maxOutFiles: 5, maxOutBytes: 1 << 20, log: () => {} },
  });
  const url = `http://127.0.0.1:${(app.server.address() as any).port}`;
  try {
    await app.versions.ensure();
    await app.versions.probing;
    const client = new Client({ name: "gosidian-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));
    const meta = { "gosidian/project": "rag", "gosidian/run": "r-9", "gosidian/mcp_url": mcp.url, "gosidian/mcp_token": token };
    const res: any = await client.callTool({ name: "run", arguments: { prompt: fake({ edit: { "repo/c.txt": "c\n" }, text: "Added c." }), tools: ["Write"], repo: { name: "app" }, mcp: "read" }, _meta: meta });
    assert.ok(!res.isError, JSON.stringify(res.content));
    const o = res.structuredContent;
    assert.deepEqual(o.mcp, { level: "read", url: mcp.url, status: "connected" });
    assert.match(o.repo.branch, /^agent\/r-9-[0-9a-f]{16}$/);
    assert.equal(git(bare, "rev-parse", o.repo.branch).trim(), o.repo.commit);
    assert.ok(!JSON.stringify(res).includes(token), "the token is not in the answer");
    const bad: any = await client.callTool({ name: "run", arguments: { prompt: fake({}), mcp: "read" }, _meta: { "gosidian/run": "r-10" } });
    assert.ok(bad.isError);
    assert.match(bad.content[0].text, /^with\.mcp read: the call carries no gosidian\/mcp_url/);
    const failed: any = await client.callTool({ name: "run", arguments: { prompt: fake({}), repo: { name: "app", branch: "main" } } });
    assert.match(failed.content[0].text, /branch main: a step commits under agent\//);
    const usage: any = (await client.callTool({ name: "usage", arguments: {} })).structuredContent;
    assert.deepEqual(usage.steps.map((s: any) => s.repo ?? null), [{ name: "app" }, null, { name: "app", branch: o.repo.branch, commit: o.repo.commit }]);
    await client.close();
  } finally {
    await app.close();
    await api.close();
    await mcp.close();
    fs.rmSync(runsDir, { recursive: true, force: true });
    fs.rmSync(versionsDir, { recursive: true, force: true });
  }
});
