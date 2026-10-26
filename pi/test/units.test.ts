// The pieces without pi: the event stream, the JSON of an answer, the
// preset and its node schema, the settings of agent-run/1, pi's arguments
// and configuration, the commit message, the proxy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Lines, RunState } from "../src/events.ts";
import { check, extractJSON } from "../src/schema.ts";
import { loadPreset, nodeSchema, parsePreset, seconds } from "../src/preset.ts";
import { LLMProxy } from "../src/proxy.ts";
import { safeName } from "../src/files.ts";
import { commitMessage, MCP_TOKEN_ENV, mcpConfig, mcpOf, piArgs, piEnv, settingsOf, StepError, systemPrompt } from "../src/run.ts";
import { manifest } from "../src/server.ts";
import { mockLLM } from "./mock-llm.ts";
import { preset } from "./helpers.ts";

test("Lines splits on LF only, across chunks", () => {
  const got: string[] = [];
  const l = new Lines();
  const enc = new TextEncoder();
  l.push(enc.encode('{"a":"x y"}\n{"b":'), (s) => got.push(s));
  l.push(enc.encode('1}\r\n\n{"c":2}'), (s) => got.push(s));
  l.end((s) => got.push(s));
  assert.deepEqual(got.map((s) => JSON.parse(s)), [{ a: "x y" }, { b: 1 }, { c: 2 }]);
});

test("RunState adds up turns, usage, tools and the last answer", () => {
  const st = new RunState();
  const u = (i: number, o: number, c: number) => ({ input: i, output: o, cacheRead: 0, cacheWrite: 0, totalTokens: i + o, cost: { total: c } });
  for (const ev of [
    { type: "turn_start" },
    { type: "message_end", message: { role: "user", content: "q" } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "looking" }, { type: "toolCall" }], stopReason: "toolUse", usage: u(10, 2, 0.1), model: "m" } },
    { type: "tool_execution_end", toolName: "ls", isError: false },
    { type: "tool_execution_end", toolName: "read", isError: true },
    { type: "turn_start" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall" }], stopReason: "toolUse", usage: u(20, 1, 0.2) } },
    { type: "turn_start" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fatto" }], stopReason: "stop", usage: u(30, 3, 0.3) } },
    { type: "agent_settled" },
  ]) st.feed(ev);
  assert.equal(st.turns, 3);
  assert.equal(st.usage.total_tokens, 66);
  assert.ok(Math.abs(st.usage.cost - 0.6) < 1e-9);
  assert.deepEqual(st.tools, { ls: 1, read: 1 });
  assert.equal(st.toolErrors, 1);
  assert.equal(st.text, "fatto");
  assert.equal(st.stop, "stop");
  assert.ok(st.settled);
});

test("extractJSON finds the value, bare, fenced or inside prose", () => {
  assert.deepEqual(extractJSON('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.deepEqual(extractJSON('Ecco:\n```json\n{"a":2}\n```\n'), { ok: true, value: { a: 2 } });
  assert.deepEqual(extractJSON('Il risultato è {"a":3} come chiesto'), { ok: true, value: { a: 3 } });
  assert.equal(extractJSON("niente").ok, false);
  const schema = { type: "object", required: ["n"], properties: { n: { type: "integer" } } };
  assert.deepEqual(check(schema, { n: 1 }), []);
  assert.match(check(schema, { n: "x" })[0], /must be integer/);
  assert.match(check(schema, {})[0], /must have required property 'n'/);
});

test("a preset gets its defaults and refuses what does not hold", () => {
  const p = preset("http://llm.test/v1");
  assert.equal(p.default_model, "a");
  assert.deepEqual(p.tools, { allowed: ["read", "ls", "write"], default: ["read", "ls"] });
  assert.equal(p.models[1].max_output, 16000);
  assert.equal(p.effort, "off");
  assert.deepEqual(p.repos, []);
  assert.deepEqual(p.mcp, []);
  const s: any = nodeSchema(p);
  assert.deepEqual(s.properties.model.enum, ["a", "b"]);
  assert.deepEqual(s.properties.tools.items.enum, ["read", "ls", "write"]);
  assert.equal(s.properties.max_turns.maximum, 20);
  assert.equal(parsePreset("name: x\nendpoint: {base_url: http://x}\nmodels: [{id: m}]\nthinking: high").effort, "high");
  assert.equal(seconds("10m", "x"), 600);
  for (const [bad, why] of [
    ["name: Bad\nendpoint: {base_url: http://x}\nmodels: [{id: m}]", /pattern/],
    ["name: x\nendpoint: {base_url: http://x}\nmodels: [{id: m}]\ndefault_model: z", /default_model z/],
    ["name: x\nendpoint: {base_url: http://x}\nmodels: [{id: m}]\ntools: {allowed: [read], default: [bash]}", /default tool bash/],
    ["name: x\nendpoint: {base_url: http://x}\nmodels: [{id: m}]\ntools: {allowed: [curl]}", /allowed values/],
    ["name: x\nendpoint: {base_url: http://x}\nmodels: [{id: m}]\nlimits: {default: {max_turns: 50}, max: {max_turns: 10}}", /over limits.max.max_turns/],
    ["name: x\nendpoint: {base_url: http://x}\nmodels: [{id: m}, {id: n, name: m}]", /model name m twice/],
    ["name: x\nendpoint: {base_url: http://x}\nmodels: [{id: m}]\neffort: low\nthinking: high", /effort and thinking/],
    ["name: x\nendpoint: {base_url: http://x}\nmodels: [{id: m}]\nmcp: [none]", /allowed values/],
    ["name: x\nendpoint: {base_url: http://x}\nmodels: [{id: m}]\nrepos: [{name: app, url: 'git@git.example.com:t/app.git'}]", /deploy key/],
  ] as const) {
    assert.throws(() => parsePreset(bad), why);
  }
});

test("the example presets hold", () => {
  for (const f of ["pi-locale", "pi-openrouter"]) {
    const p = loadPreset(new URL(`../presets/${f}.yaml`, import.meta.url).pathname);
    assert.equal(p.name, f);
    assert.equal(p.effort, "off");
    assert.deepEqual((nodeSchema(p) as any).properties.access.enum, ["read"]);
  }
});

test("safeName keeps a plain name", () => {
  assert.equal(safeName("../../etc/passwd", "f"), "passwd");
  assert.equal(safeName(".env", "f"), "env");
  assert.equal(safeName("", "f"), "f");
});

test("the proxy adds the key and the preset's body, caps a request to the budget, and counts the usage", async () => {
  const llm = await mockLLM([{ text: "uno", usage: { prompt: 100, completion: 20 } }, { text: "due" }]);
  const seen: string[] = [];
  const origin = await import("node:http").then((h) => {
    // An upstream in front of the mock that records the key it got.
    const s = h.createServer(async (req, res) => {
      seen.push(String(req.headers.authorization));
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c);
      const r = await fetch(llm.url + req.url!.slice("/v1".length), { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks) });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "" });
      res.end(Buffer.from(await r.arrayBuffer()));
    });
    return new Promise<import("node:http").Server>((ok) => s.listen(0, "127.0.0.1", () => ok(s)));
  });
  const port = (origin.address() as any).port;
  const proxy = new LLMProxy({ baseUrl: `http://127.0.0.1:${port}/v1`, key: "sk-real", body: { provider: { quantizations: ["fp8"] } } });
  await proxy.listen();
  let used = 0;
  const g = proxy.grant({ left: () => 500 - used, usage: (n) => (used += n) });
  const call = (token: string, body: object) =>
    fetch(proxy.url + "/chat/completions", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await call("wrong", {})).status, 401);
  const r = await call(g.token, { model: "m", stream: true, max_completion_tokens: 9999, provider: { order: ["x"] }, messages: [] });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /"content":"uno"/);
  assert.equal(seen[0], "Bearer sk-real");
  assert.deepEqual(llm.requests[0].provider, { quantizations: ["fp8"] });
  assert.equal(llm.requests[0].max_completion_tokens, 500);
  assert.equal(used, 120);
  used = 500;
  const over = await call(g.token, { model: "m", messages: [] });
  assert.equal(over.status, 400);
  assert.match(await over.text(), /token budget/);
  g.revoke();
  assert.equal((await call(g.token, {})).status, 401);
  await proxy.close();
  await new Promise((ok) => origin.close(ok));
  await llm.close();
});

// A preset with every tool, two repositories and gosidian's MCP.
const full = () =>
  preset("https://llm.example.com/v1", `repos:
  - name: app
    url: git@git.example.com:team/app.git
    key_file: /run/secrets/app_key
    known_hosts: "git.example.com ssh-ed25519 AAAA"
  - name: docs
    url: https://git.other.example/team/docs.git
mcp: [read, write]`, "[read, grep, find, ls, edit, write, bash]");

test("agent-run/1: the node's schema, from the preset", () => {
  const p = full();
  const s: any = nodeSchema(p);
  assert.deepEqual(s.properties.access.enum, ["read", "edit", "exec"]);
  assert.deepEqual(s.properties.effort.enum, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(s.properties.effort.default, "off");
  assert.equal(s.properties.thinking.deprecated, true);
  assert.deepEqual(s.properties.mcp.enum, ["none", "read", "write"]);
  assert.deepEqual(s.properties.repo.properties.name.enum, ["app", "docs"]);
  // A preset of read tools: no edit nor exec; no repositories: no repo;
  // no MCP: none only.
  const ro: any = nodeSchema(parsePreset("name: x\nendpoint: {base_url: http://x}\nmodels: [{id: m}]"));
  assert.deepEqual(ro.properties.access.enum, ["read"]);
  assert.equal(ro.properties.repo, undefined);
  assert.deepEqual(ro.properties.mcp.enum, ["none"]);
  // write without edit is still edit; nothing of exec is not exec.
  assert.deepEqual((nodeSchema(preset("http://x/v1")) as any).properties.access.enum, ["read", "edit"]);
});

test("agent-run/1: access gives the tools, tools narrow it, thinking is effort", () => {
  const p = full();
  assert.deepEqual(settingsOf(p, { prompt: "x", access: "read" }).tools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(settingsOf(p, { prompt: "x", access: "edit" }).tools, ["read", "grep", "find", "ls", "edit", "write"]);
  assert.deepEqual(settingsOf(p, { prompt: "x", access: "exec" }).tools, ["read", "grep", "find", "ls", "edit", "write", "bash"]);
  assert.deepEqual(settingsOf(p, { prompt: "x", access: "edit", tools: ["read", "write"] }).tools, ["read", "write"]);
  assert.throws(() => settingsOf(p, { prompt: "x", access: "read", tools: ["read", "bash"] }), /with.tools: bash not within access read/);
  // Without access: the preset's default.
  assert.deepEqual(settingsOf(p, { prompt: "x" }).tools, ["read", "ls"]);
  // The preset of the tests allows read, ls, write: exec lacks bash.
  assert.throws(() => settingsOf(preset("http://x/v1"), { prompt: "x", access: "exec" }), (e: Error) => e instanceof StepError && /access exec needs bash, which the preset does not allow/.test(e.message));
  assert.deepEqual(settingsOf(preset("http://x/v1"), { prompt: "x", access: "edit" }).tools, ["read", "ls", "write"]);
  const s = settingsOf(p, { prompt: "x", thinking: "high" });
  assert.equal(s.effort, "high");
  assert.equal((s as any).thinking, undefined);
  assert.equal(settingsOf(p, { prompt: "x" }).effort, "off");
  assert.throws(() => settingsOf(p, { prompt: "x", thinking: "high", effort: "low" }), /effort and thinking \(deprecated\)/);
  assert.equal(settingsOf(p, { prompt: "x" }).mcp, "none");
  assert.equal(settingsOf(p, { prompt: "x", mcp: "write" }).mcp, "write");
  assert.throws(() => settingsOf(preset("http://x/v1"), { prompt: "x", mcp: "read" }), /with.mcp read: the preset grants no access to gosidian's MCP/);
  assert.throws(() => settingsOf(preset("http://x/v1"), { prompt: "x", repo: { name: "app" } }), /with.repo: the preset has no repositories/);
  assert.throws(() => settingsOf(p, { prompt: "x", repo: { name: "nope" } }), /allowed values/);
  assert.deepEqual(settingsOf(p, { prompt: "x", repo: { name: "app", branch: "agent/x" } }).repo, { name: "app", branch: "agent/x", push: true });
});

test("the manifest declares agent-run/1, gosidian's MCP and the repositories' hosts; pr for the repositories with pull requests", () => {
  const m: any = manifest(full());
  assert.deepEqual(m.nodes.map((n: any) => n.name), ["run"], "no repository with pull requests: no pr");
  assert.equal(m.nodes[0].contract, "agent-run/1");
  assert.equal(m.nodes[0].mcp, true);
  assert.equal(m.nodes[0].output_schema.properties.repo.properties.files.type, "array");
  assert.deepEqual(m.permissions.mcp, ["read", "write"]);
  assert.deepEqual(m.permissions.network, ["gosidian", "llm.example.com", "git.example.com", "git.other.example"]);
  const plain: any = manifest(preset("http://llm.test:8080/v1"));
  assert.equal(plain.nodes[0].contract, "agent-run/1");
  assert.equal(plain.nodes[0].mcp, undefined);
  assert.equal(plain.permissions.mcp, undefined);
  assert.deepEqual(plain.permissions.network, ["gosidian", "llm.test:8080"]);
  const pulls: any = manifest(preset("http://llm.test:8080/v1", `repos:
  - name: app
    url: https://git.example.com/team/app.git
    pr: {kind: gitea, api: "https://git.example.com/api/v1", repo: team/app, token_file: /run/secrets/gitea}
  - name: docs
    url: https://git.other.example/team/docs.git`));
  assert.deepEqual(pulls.nodes.map((n: any) => [n.name, n.tool]), [["run", "run"], ["pr", "pr"]]);
  for (const k of ["contract", "files", "file_refs", "mcp"]) assert.equal(pulls.nodes[1][k], undefined, k);
  assert.deepEqual(pulls.nodes[1].input_schema.properties.repo.enum, ["app"]);
  assert.deepEqual(pulls.nodes[1].input_schema.properties.action.enum, ["merge", "close"]);
  assert.equal(pulls.nodes[1].output_schema.properties.branch_deleted.type, "boolean");
  assert.deepEqual(pulls.permissions.network, ["gosidian", "llm.test:8080", "git.example.com", "git.other.example"]);
});

test("pi's arguments and environment: gosidian's MCP only when asked, its token never in the arguments", () => {
  const p = full();
  const m = p.models[0];
  const none = piArgs(p, settingsOf(p, { prompt: "x", effort: "medium" }), m, "/s/system.md", "/s/session", false);
  assert.deepEqual(none.slice(0, 8), ["--mode", "json", "--model", "gosidian/vendor/model-a", "--thinking", "medium", "--tools", "read,ls"]);
  assert.ok(none.includes("--no-mcp") && none.includes("--no-extensions") && !none.includes("-e"));
  const s = settingsOf(p, { prompt: "x", mcp: "read" });
  const access = mcpOf(s.mcp, { "gosidian/mcp_url": "http://gosidian:8080/mcp", "gosidian/mcp_token": "gsd_secret-token" })!;
  assert.deepEqual(access, { level: "read", url: "http://gosidian:8080/mcp", token: "gsd_secret-token" });
  const args = piArgs(p, s, m, "/s/system.md", "/s/session", true);
  assert.ok(!args.includes("--no-mcp"));
  assert.equal(args[args.indexOf("-e") + 1], "builtin:mcp");
  assert.equal(args[args.indexOf("--tools") + 1], "read,ls,mcp__gosidian__*");
  assert.ok(!args.join(" ").includes("gsd_secret-token"));
  // No tools of pi's: gosidian's alone.
  const bare = piArgs(p, settingsOf(p, { prompt: "x", tools: [], mcp: "write" }), m, "/s/system.md", "/s/session", true);
  assert.equal(bare[bare.indexOf("--tools") + 1], "mcp__gosidian__*");
  assert.deepEqual(piArgs(p, settingsOf(p, { prompt: "x", tools: [] }), m, "/s/system.md", "/s/session", false).filter((a) => a.includes("tools")), ["--no-tools"]);
  // The token: in pi's environment, and in mcp.json by the variable's name.
  assert.equal(piEnv({ agent: "/a", home: "/h" }, access.token)[MCP_TOKEN_ENV], "gsd_secret-token");
  assert.equal(piEnv({ agent: "/a", home: "/h" })[MCP_TOKEN_ENV], undefined);
  const cfg = mcpConfig(access);
  assert.ok(!cfg.includes("gsd_secret-token"));
  const servers = JSON.parse(cfg).mcpServers;
  assert.deepEqual(servers.gosidian.headers, { Authorization: "Bearer ${GOSIDIAN_MCP_TOKEN}" });
  assert.equal(servers.gosidian.exposure, "direct");
  assert.equal(JSON.parse(cfg).autoEnableCodemode, false);
  // What gosidian must hand.
  assert.equal(mcpOf("none", {}), undefined);
  assert.throws(() => mcpOf("read", {}), /with.mcp read: the call carries no gosidian\/mcp_url and gosidian\/mcp_token/);
  assert.throws(() => mcpOf("write", { "gosidian/mcp_url": "http://g/mcp" }), /carries no/);
  assert.throws(() => mcpOf("read", { "gosidian/mcp_url": "file:///etc/x", "gosidian/mcp_token": "t" }), /not an http\(s\) address/);
  assert.throws(() => mcpOf("read", { "gosidian/mcp_url": "http://g/${HOME}", "gosidian/mcp_token": "t" }), /not an http\(s\) address/);
  assert.throws(() => mcpOf("read", { "gosidian/mcp_url": "http://g/mcp", "gosidian/mcp_token": "a b" }), /not a token/);
});

test("the commit message: the preset, the task's first line, the answer, gosidian's project and run", () => {
  const p = full();
  const long = "Aggiorna " + "x".repeat(100);
  const msg = commitMessage(p, `\n  ${long}\nsecond line`, "Fatto.\n", { "gosidian/project": "demo", "gosidian/run": "r-42" });
  const lines = msg.split("\n");
  assert.equal(lines[0], `pi-test: ${long.slice(0, 71)}…`);
  assert.equal(lines[0].length, "pi-test: ".length + 72);
  assert.deepEqual(lines.slice(1), ["", "Fatto.", "", "gosidian: project demo, run r-42", ""]);
  const big = commitMessage(p, "x", "y".repeat(5000), undefined);
  assert.match(big, /^pi-test: x\n\ny{4000}\n\[…\]\n\ngosidian: project -, run -\n$/);
});

test("the system prompt: a step whose MCP writes is told that notes go into the vault with its tools", () => {
  const p = preset("http://llm.test");
  const s = settingsOf(p, { prompt: "x", access: "read" });
  const w = systemPrompt(p, s, [], false, undefined, "write");
  assert.match(w, /## gosidian\nThe MCP server gosidian \(tools mcp__gosidian__memory_\*\) reads and writes/);
  assert.match(w, /memory_create, memory_update or memory_edit/);
  assert.match(systemPrompt(p, s, [], false, undefined, "read"), /reads the vault of the run's project: you cannot change its notes/);
  assert.doesNotMatch(systemPrompt(p, s, [], false), /## gosidian/);
  assert.doesNotMatch(systemPrompt(p, s, [], false, undefined, "none"), /## gosidian/);
});
