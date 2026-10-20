// The plugin as gosidian sees it: the bearer, the manifest, a call of run
// with its _meta, the files given back as resources, a failing script as
// an error of the tool, the health.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { start } from "../src/server.ts";
import { preset, stepDirs, testEnv } from "./helpers.ts";

test("gosidian's view: bearer, manifest, run, files as resources, errors", async () => {
  const te = testEnv(preset(), { image: "ghcr.io/daniele-chiappa/gosidian-exec:0.1.0" });
  const app = await start({ env: te.env, token: "t0k", port: 0, workers: 2 });
  const url = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const client = new Client({ name: "gosidian-test", version: "0" });
  try {
    assert.equal((await fetch(url + "/mcp", { method: "POST", body: "{}" })).status, 401);
    const health = await (await fetch(url + "/health")).json();
    assert.deepEqual({ ...health, version: "-" }, { status: "ok", plugin: "exec", name: "exec-test", version: "-", running: 0 });

    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp"), { requestInit: { headers: { Authorization: "Bearer t0k" } } }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.deepEqual(tools, ["gosidian_manifest", "run"]);
    const man: any = (await client.callTool({ name: "gosidian_manifest", arguments: {} })).structuredContent;
    assert.equal(man.name, "exec-test");
    assert.equal(man.nodes[0].contract, "command-run/1");
    assert.deepEqual(man.permissions, { files: true, network: ["gosidian"] });

    const meta = { "gosidian/project": "demo", "gosidian/run": "r1" };
    const res: any = await client.callTool({ name: "run", arguments: { script: "echo ok\necho '# Rapporto' > 'out/rapporto 1.md'" }, _meta: meta });
    assert.ok(!res.isError, JSON.stringify(res.content));
    assert.equal(res.structuredContent.stdout, "ok\n");
    assert.equal(res.structuredContent.exit_code, 0);
    assert.equal(res.structuredContent.executor.image, "ghcr.io/daniele-chiappa/gosidian-exec:0.1.0");
    assert.match(res.content[0].text, /^exit 0 in [\d.]+ s on local$/);
    const resource = res.content.find((c: any) => c.type === "resource");
    assert.equal(decodeURIComponent(new URL(resource.resource.uri).pathname), "/rapporto 1.md");
    assert.equal(resource.resource.mimeType, "text/markdown");
    assert.equal(Buffer.from(resource.resource.blob, "base64").toString(), "# Rapporto\n");

    const failed: any = await client.callTool({ name: "run", arguments: { script: "echo 'FAIL: TestX' >&2; exit 1" }, _meta: meta });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /^exit 1 after [\d.]+ s: FAIL: TestX$/);
    const kept: any = await client.callTool({ name: "run", arguments: { command: ["false"], fail_on_error: false }, _meta: meta });
    assert.equal(kept.isError, undefined);
    assert.equal(kept.structuredContent.exit_code, 1);

    const bad: any = await client.callTool({ name: "run", arguments: { script: "x", env: { LD_PRELOAD: "/x.so" } } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /LD_\* variables are the plugin's/);
    const far: any = await client.callTool({ name: "run", arguments: { script: "x", target: "elsewhere" } });
    assert.match(far.content[0].text, /not local nor a host of the preset/);

    // Two steps at once, on two slots.
    const both = await Promise.all([1, 2].map((i) => client.callTool({ name: "run", arguments: { script: `sleep 0.5; echo ${i}` } }) as Promise<any>));
    assert.deepEqual(both.map((r) => r.structuredContent.stdout), ["1\n", "2\n"]);
    assert.deepEqual(stepDirs(te.env), []);
  } finally {
    await client.close();
    await app.close();
    te.close();
  }
});
