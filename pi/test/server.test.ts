// The plugin as gosidian sees it: the bearer, the manifest, a call of run
// with the tokens left in its _meta, the files given back as resources; pr
// on a fake Gitea.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mockLLM } from "./mock-llm.ts";
import { fakeGitea, origin, PI_BIN, preset } from "./helpers.ts";
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
    assert.equal(man.nodes[0].contract, "agent-run/1");
    assert.equal(man.nodes[0].mcp, undefined);

    const res: any = await client.callTool({ name: "run", arguments: { prompt: "scrivi", access: "edit", tools: ["write"] }, _meta: { "gosidian/llm_tokens_left": 5000, "gosidian/project": "demo", "gosidian/run": "r1" } });
    assert.ok(!res.isError, JSON.stringify(res.content));
    assert.equal(res.structuredContent.text, "ok ![](fig 1.md)");
    assert.equal(res.structuredContent.model.name, "a");
    assert.equal(res.structuredContent.executor.plugin, "gosidian-pi");
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

test("pr: a step's pull request merged with the preset's token, its branch deleted; a refusal of Gitea's, or of the plugin's, fails the node", async () => {
  const gitea = await fakeGitea({ 7: "agent/r-7-0123456789abcdef", 8: "agent/r-7-fedcba9876543210" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-srv-"));
  const tokenFile = path.join(dir, "gitea-token");
  fs.writeFileSync(tokenFile, "gitea-test-token\n", { mode: 0o600 });
  const app = await start({
    preset: preset("http://127.0.0.1:9/v1", `repos:\n  - name: app\n    url: ${origin()}\n    pr: {kind: gitea, api: "${gitea.api}", repo: team/app, token_file: "${tokenFile}"}`),
    token: "",
    port: 0,
    workers: 1,
    env: { piBin: PI_BIN, runsDir: dir, maxFilesBytes: 1 << 20, maxOutFiles: 5, maxOutBytes: 1 << 20, log: () => {} },
  });
  const url = `http://127.0.0.1:${(app.server.address() as any).port}`;
  try {
    const client = new Client({ name: "gosidian-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["gosidian_manifest", "run", "pr"]);
    const man: any = (await client.callTool({ name: "gosidian_manifest", arguments: {} })).structuredContent;
    assert.deepEqual(man.nodes.map((n: any) => n.name), ["run", "pr"]);
    const res: any = await client.callTool({ name: "pr", arguments: { repo: "app", url: "https://git.example.com/team/app/pulls/7", action: "merge", style: "rebase" } });
    assert.ok(!res.isError, JSON.stringify(res.content));
    assert.deepEqual(res.structuredContent, {
      repo: "app", number: 7, url: "https://git.example.com/team/app/pulls/7", action: "merge", branch: "agent/r-7-0123456789abcdef",
      merged: true, closed: true, sha: "c0ffee".padEnd(40, "0"), branch_deleted: true,
    });
    assert.deepEqual(JSON.parse(res.content[0].text), res.structuredContent);
    assert.deepEqual(gitea.seen, ["GET /pulls/7", 'POST /pulls/7/merge {"Do":"rebase","delete_branch_after_merge":false}', "GET /pulls/7", "DELETE /branches/agent/r-7-0123456789abcdef"]);
    assert.ok(gitea.auths.every((a) => a === "token gitea-test-token"));
    gitea.merge = 409;
    const conflict: any = await client.callTool({ name: "pr", arguments: { repo: "app", number: 8, action: "merge" } });
    assert.ok(conflict.isError);
    assert.equal(conflict.content[0].text, "repository app: pull request #8: the merge: 409 merge conflict");
    const foreign: any = await client.callTool({ name: "pr", arguments: { repo: "app", url: "https://git.example.com/team/other/pulls/8", action: "close" } });
    assert.match(foreign.content[0].text, /is a pull request of team\/other, not of repository app/);
    const bad: any = await client.callTool({ name: "pr", arguments: { repo: "app", number: 8, action: "reopen" } });
    assert.ok(bad.isError);
    assert.match(bad.content[0].text, /with\/action must be equal to one of the allowed values/);
    assert.equal(gitea.seen.filter((s) => s.startsWith("DELETE")).length, 1, "only the merged one's branch");
    await client.close();
  } finally {
    await app.close();
    await gitea.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
