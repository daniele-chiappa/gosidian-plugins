// The pieces without a process: the event stream (recorded from Claude Code
// 2.1.301 against a fake API), the preset and its node schema, the
// settings and arguments of a step, its repository and gosidian's MCP, the
// versions, the subscription's limits, the JSON of an answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Lines, StreamState, mainModel } from "../src/events.ts";
import { check, extractJSON } from "../src/schema.ts";
import { accessTools, aliasesOf, parsePreset, readSecret, readSecrets, runSchema, seconds } from "../src/preset.ts";
import { buildArgs, buildEnv, commitMessage, effortOf, mcpConfig, mcpOf, priceOf, settingsOf, systemPrompt, targetOf } from "../src/run.ts";
import { stepOf } from "../src/steps.ts";
import { compareVersions, isVersion, RWLock } from "../src/versions.ts";
import { effortLevels, findBinary } from "../src/npm.ts";
import { fromEndpoint, fromHeaders, rateLimitHeaderNames, Subscription } from "../src/subscription.ts";
import { safeName } from "../src/files.ts";
import { PRICES, preset, twoEndpoints } from "./helpers.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const withTools = (allowed: string) => parsePreset(`name: x\ncredentials: {oauth_token_file: /t}\ntools: {allowed: ${allowed}}\n`);
const fixture = (name: string) => {
  const st = new StreamState();
  const l = new Lines();
  const feed = (s: string) => st.feed(JSON.parse(s));
  l.push(fs.readFileSync(path.join(here, "fixtures", name)), feed);
  l.end(feed);
  return st;
};

test("Lines splits on LF only, across chunks", () => {
  const got: string[] = [];
  const l = new Lines();
  const enc = new TextEncoder();
  l.push(enc.encode('{"a":"x y"}\n{"b":'), (s) => got.push(s));
  l.push(enc.encode('1}\r\n\n{"c":2}'), (s) => got.push(s));
  l.end((s) => got.push(s));
  assert.deepEqual(got.map((s) => JSON.parse(s)), [{ a: "x y" }, { b: 1 }, { c: 2 }]);
});

test("a recorded session: the result, the structured output, the usage, the denials", () => {
  const st = fixture("success.jsonl");
  assert.equal(st.init?.model, "claude-haiku-5-5");
  assert.equal(st.init?.version, "2.1.301");
  assert.deepEqual(st.init?.tools, ["Glob", "Grep", "Read", "StructuredOutput", "Write"]);
  assert.deepEqual(st.init?.mcp, {});
  assert.equal(st.turns, 3);
  const o = st.outcome()!;
  assert.equal(o.subtype, "success");
  assert.equal(o.isError, false);
  assert.deepEqual(o.structured, { parole: 2 });
  assert.equal(o.turns, 4);
  assert.equal(o.model, "claude-haiku-5-5");
  assert.deepEqual(o.usage, { input: 300, output: 15, cache_read: 3000, cache_write: 150, total_tokens: 3465 });
  assert.ok(Math.abs(o.cost - 0.00008625) < 1e-12);
  assert.deepEqual(o.denials, [{ tool: "Write", input: '{"file_path":"/tmp/s/work/out/r.md","content":"x"}' }]);
  assert.equal(o.terminal, "completed");
  assert.equal(o.stop, "tool_use");
  assert.deepEqual(st.tools, { Read: 1, Write: 1, StructuredOutput: 1 }, "the calls, a denied one too");
});

test("a recorded session that stops at max_turns", () => {
  const o = fixture("max-turns.jsonl").outcome()!;
  assert.equal(o.subtype, "error_max_turns");
  assert.equal(o.isError, true);
  assert.deepEqual(o.errors, ["Reached maximum number of turns (1)"]);
  assert.equal(o.terminal, "max_turns");
  assert.equal(new StreamState().outcome(), undefined);
});

test("the init event: the state of each MCP server", () => {
  const st = new StreamState();
  st.feed({ type: "system", subtype: "init", model: "m", tools: ["Read", "mcp__gosidian__memory_get"], mcp_servers: [{ name: "gosidian", status: "connected", source: "dynamic" }] });
  assert.deepEqual(st.init?.mcp, { gosidian: "connected" });
});

test("mainModel: the init model when it was used, else the one that wrote the most", () => {
  const mu = { "claude-haiku-5-5": { outputTokens: 5 }, "claude-opus-5-5": { outputTokens: 900 } };
  assert.equal(mainModel(mu, "claude-haiku-5-5"), "claude-haiku-5-5");
  assert.equal(mainModel(mu, "claude-sonnet-5-5"), "claude-opus-5-5");
  assert.equal(mainModel({}, "x"), "x");
});

test("a preset gets its defaults", () => {
  const p = parsePreset("name: claude\ncredentials: {oauth_token_file: /run/secrets/t}\n");
  assert.deepEqual(p.models.map((m) => m.name), ["haiku", "sonnet", "opus"]);
  assert.deepEqual(p.models[0], { name: "haiku", endpoint: "anthropic", id: "haiku", effort: true });
  assert.deepEqual(p.tools, { allowed: ["Read", "Grep", "Glob"], default: ["Read", "Grep", "Glob"] });
  assert.deepEqual(p.effort, { allowed: ["low", "medium", "high", "xhigh", "max"] });
  assert.equal(p.version, "latest");
  assert.deepEqual(p.endpoints, { anthropic: { name: "anthropic", url: "https://api.anthropic.com", auth: "oauth", key_file: "/run/secrets/t", key_env: undefined, headers: {} } }, "credentials and upstream are the endpoint anthropic");
  assert.deepEqual(p.limits.default, { max_turns: 20, max_seconds: 600, max_tokens: 3_000_000, max_cost: 1 });
  assert.deepEqual(p.limits.max, { max_turns: 100, max_seconds: 840, max_tokens: 6_000_000, max_cost: 10 });
  assert.deepEqual(p.limits.min_left_percent, { session: 0, week: 0 });
  assert.deepEqual(aliasesOf(p), ["haiku", "sonnet", "opus"]);
  const k = parsePreset("name: claude\ncredentials: {api_key_env: ANTHROPIC_KEY}\nupstream: http://api.lan/\ntools: {allowed: [Read, Write, Bash]}\nlimits: {default: {max_seconds: 5m, max_budget_usd: 0.5}}\n");
  assert.equal(k.endpoints.anthropic.auth, "api_key");
  assert.equal(k.endpoints.anthropic.key_env, "ANTHROPIC_KEY");
  assert.equal(k.endpoints.anthropic.url, "http://api.lan");
  assert.equal(k.limits.default.max_cost, 0.5, "max_budget_usd (deprecated) is max_cost");
  assert.deepEqual(k.tools.default, ["Read"], "the default tools are the read-only ones among those allowed");
  assert.equal(k.limits.default.max_seconds, 300);
  assert.equal(seconds("1h", "x"), 3600);
});

test("a preset refuses what does not hold", () => {
  const base = "name: x\ncredentials: {oauth_token_file: /t}\n";
  for (const [bad, why] of [
    ["name: X\ncredentials: {oauth_token_file: /t}", /pattern/],
    ["name: x", /credentials/],
    ["name: x\ncredentials: {oauth_token_file: /t, api_key_file: /k}", /more than 1/],
    ["name: x\ncredentials: {}", /fewer than 1/],
    [base + "version: newest", /pattern/],
    [base + "effort: {allowed: [low, high], default: max}", /effort.default max/],
    [base + "tools: {allowed: [Read], default: [Bash]}", /default tool Bash/],
    [base + "tools: {allowed: [read]}", /pattern/],
    [base + "limits: {default: {max_turns: 50}, max: {max_turns: 10}}", /over limits.max.max_turns/],
    [base + "limits: {min_left_percent: {session: 120}}", /must be <= 100/],
    ["name: x\ncredentials: {api_key_file: /k}\nlimits: {min_left_percent: {week: 10}}", /needs a subscription/],
    [base + "models: [sonnet, sonnet]", /duplicate/],
    [base + "limits: {default: {max_cost: 1, max_budget_usd: 1}}", /max_cost and max_budget_usd/],
    [base + "limits: {max: {max_tokens: 100000}}", /limits.default.max_tokens 3000000 is over limits.max.max_tokens 100000/],
    [base + "mcp: [admin]", /allowed values/],
    [base + "mcp: [none]", /allowed values/],
    [base + "repos: [{name: App, url: /srv/app.git}]", /pattern/],
    [base + "repos: [{name: app}]", /required property 'url'/],
    [base + "repos: [{name: app, url: /a.git}, {name: app, url: /b.git}]", /repos app twice/],
    [base + "repos: [{name: app, url: \"git@git.example.com:team/app.git\"}]", /deploy key/],
  ] as const) {
    assert.throws(() => parsePreset(bad), why, bad);
  }
});

test("a preset with endpoints: models on each, their ids, prices and effort", () => {
  const p = twoEndpoints("http://a.test", "http://b.test");
  assert.deepEqual(Object.keys(p.endpoints), ["anthropic", "local"]);
  assert.deepEqual(p.endpoints.local, { name: "local", url: "http://b.test/api", auth: "bearer", key_file: undefined, key_env: "LOCAL_KEY", headers: { "HTTP-Referer": "https://gosidian.test", "X-Title": "gosidian" } });
  assert.deepEqual(p.models, [
    { name: "sonnet", endpoint: "anthropic", id: "sonnet", effort: true },
    { name: "qwen", endpoint: "local", id: "qwen/qwen3-coder", context: 65536, max_output: 8192, cost: PRICES, effort: false },
    { name: "free", endpoint: "local", id: "llama:8b", effort: false },
  ]);
  assert.deepEqual(aliasesOf(p), ["sonnet"], "the aliases of Anthropic's endpoint only");
  const one = parsePreset("name: x\nendpoints: {or: {url: https://openrouter.ai/api, auth: bearer, key_file: /k}}\nmodels: [{name: sonnet-or, id: anthropic/claude-sonnet-4.5, effort: true, cost: {input: 3}}]\n");
  assert.deepEqual(one.models[0], { name: "sonnet-or", endpoint: "or", id: "anthropic/claude-sonnet-4.5", cost: { input: 3, output: 0, cache_read: 0, cache_write: 0 }, effort: true }, "the only endpoint; prices not given are 0");
  assert.deepEqual(aliasesOf(one), []);
  const both = parsePreset("name: x\nendpoints:\n  claude: {url: https://api.anthropic.com, auth: api_key, key_env: K}\n  ollama: {url: http://gpu.lan:11434, auth: none}\nmodels: [opus, {name: qwen, endpoint: ollama, id: \"qwen3-coder:30b\"}]\n");
  assert.deepEqual(both.models.map((m) => [m.name, m.endpoint, m.effort]), [["opus", "claude", true], ["qwen", "ollama", false]]);
  assert.deepEqual(readSecrets(both, { K: "sk-k" }), { claude: "sk-k", ollama: "" });
  assert.throws(() => readSecrets(both, {}), /endpoint claude: the preset's credential is in K, which is not set/);
  const ep = "name: x\nendpoints:\n  a: {url: http://a, auth: oauth, key_env: T}\n  b: {url: http://b, auth: none}\n";
  for (const [bad, why] of [
    [ep + "credentials: {oauth_token_file: /t}", /endpoints replaces credentials and upstream/],
    [ep + "upstream: http://x", /endpoints replaces credentials and upstream/],
    ["name: x\nendpoints: {}", /fewer than 1 properties/],
    ["name: x\nendpoints: {b: {url: ftp://b, auth: none}}", /pattern/],
    ["name: x\nendpoints: {b: {url: http://b, auth: token}}", /allowed values/],
    ["name: x\nendpoints: {b: {url: http://b, auth: bearer}}", /auth bearer needs its key in one of key_file and key_env/],
    ["name: x\nendpoints: {b: {url: http://b, auth: bearer, key_file: /k, key_env: K}}", /one of key_file and key_env/],
    ["name: x\nendpoints: {b: {url: http://b, auth: none, key_env: K}}", /auth none takes no key/],
    ["name: x\nendpoints: {b: {url: http://b, auth: none, headers: {Authorization: Bearer x}}}\nmodels: [{name: m}]", /Authorization is not a header a preset sets/],
    ["name: x\nendpoints: {b: {url: http://b, auth: none, headers: {X-Api-Key: x}}}\nmodels: [{name: m}]", /X-Api-Key is not a header/],
    ["name: x\nendpoints: {b: {url: http://b, auth: none}}", /no Anthropic endpoint.*list its models/],
    ["name: x\nendpoints: {b: {url: http://b, auth: none}}\nmodels: [sonnet]", /a name alone is a model of an Anthropic endpoint/],
    [ep + "models: [{name: m}]", /which endpoint\? one of a, b/],
    [ep + "models: [{name: m, endpoint: c}]", /no endpoint c/],
    [ep + "models: [{name: m, endpoint: b}, {name: m, endpoint: a}]", /duplicate name m/],
    [ep + "models: [{name: m, endpoint: b, id: a b}]", /pattern/],
    [ep + "models: [{name: anthropic/claude, endpoint: b}]", /pattern/],
    ["name: x\nendpoints:\n  a: {url: http://a, auth: oauth, key_env: T}\n  b: {url: http://b, auth: oauth, key_env: U}", /at most one has auth oauth/],
    ["name: x\nendpoints: {b: {url: http://b, auth: api_key, key_env: K}}\nlimits: {min_left_percent: {session: 10}}", /needs a subscription/],
  ] as const) {
    assert.throws(() => parsePreset(bad), why, bad);
  }
});

test("readSecret reads the credential from its file or variable, one line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-secret-"));
  const f = path.join(dir, "t");
  fs.writeFileSync(f, "sk-ant-oat01-abc\n");
  assert.equal(readSecret({ key_file: f }), "sk-ant-oat01-abc");
  assert.equal(readSecret({ key_env: "K" }, { K: " sk-x " }), "sk-x");
  assert.throws(() => readSecret({ key_env: "K" }, {}), /not set/);
  assert.equal(readSecret({}), "", "an endpoint without a key");
  fs.writeFileSync(f, "a b\n");
  assert.throws(() => readSecret({ key_file: f }), /one line/);
  fs.rmSync(dir, { recursive: true });
});

test("the run node's schema follows the preset", () => {
  const p = preset("http://api.test", "effort: {allowed: [low, high], default: low}");
  const s: any = runSchema(p);
  assert.deepEqual(s.properties.model, { enum: ["sonnet", "haiku"], default: "sonnet", description: s.properties.model.description });
  assert.deepEqual(s.properties.effort.enum, ["low", "high"]);
  assert.equal(s.properties.effort.default, "low");
  assert.deepEqual(s.properties.tools.items.enum, ["Read", "Grep", "Glob", "Write"]);
  assert.deepEqual(s.properties.tools.default, ["Read", "Grep", "Glob"]);
  assert.equal(s.properties.max_turns.maximum, 20);
  assert.equal(s.properties.max_tokens.maximum, 6_000_000);
  assert.equal(s.properties.max_tokens.default, 3_000_000);
  assert.equal(s.properties.max_cost.maximum, 2);
  assert.equal(s.properties.max_cost.default, 1);
  assert.equal(s.properties.max_budget_usd.deprecated, true);
  assert.deepEqual(s.properties.system_mode, { enum: ["append", "replace"], default: "append", description: s.properties.system_mode.description });
  assert.deepEqual(s.properties.access.enum, ["read", "edit"], "the levels the preset can give: no Bash, no exec");
  for (const k of ["repo", "mcp"]) assert.equal(s.properties[k], undefined, k);
  const all: any = runSchema(withTools("[Read, Grep, Glob, Write, Edit, Bash]"));
  assert.deepEqual(all.properties.access.enum, ["read", "edit", "exec"]);
  const none: any = runSchema(withTools("[WebFetch]"));
  assert.equal(none.properties.access, undefined, "no level at all");
});

test("access: the tools of each level the preset allows, or those missing", () => {
  const p = withTools("[Read, Grep, Write, Bash]");
  assert.deepEqual(accessTools(p, "read"), { tools: ["Read", "Grep"], missing: [] });
  assert.deepEqual(accessTools(p, "edit"), { tools: ["Read", "Grep", "Write"], missing: [] });
  assert.deepEqual(accessTools(p, "exec"), { tools: ["Read", "Grep", "Write", "Bash"], missing: [] });
  const ro = withTools("[Read, Grep, Glob]");
  assert.deepEqual(accessTools(ro, "edit"), { tools: ["Read", "Grep", "Glob"], missing: ["Write", "Edit"] });
  assert.deepEqual(accessTools(ro, "exec").missing, ["Bash"]);
  assert.deepEqual(settingsOf(p, { prompt: "x", access: "edit" }).tools, ["Read", "Grep", "Write"]);
  assert.deepEqual(settingsOf(p, { prompt: "x", access: "exec", tools: ["Read", "Bash"] }).tools, ["Read", "Bash"], "tools narrow access");
  assert.deepEqual(settingsOf(p, { prompt: "x", tools: ["Bash"] }).tools, ["Bash"], "tools alone");
  assert.throws(() => settingsOf(ro, { prompt: "x", access: "edit" }), /with\.access edit needs Write or Edit, which the preset does not allow/);
  assert.throws(() => settingsOf(p, { prompt: "x", access: "edit", tools: ["Bash"] }), /with\.tools: Bash not within access edit \(Read, Grep, Write\)/);
  assert.throws(() => settingsOf(p, { prompt: "x", access: "all" }), /allowed values/);
});

test("settingsOf fills the defaults and refuses what the preset does not allow", () => {
  const p = preset("http://api.test");
  assert.deepEqual(settingsOf(p, { prompt: "x", files: [{ url: "u" }] }), { prompt: "x", system_mode: "append", model: "sonnet", tools: ["Read", "Grep", "Glob"], max_turns: 6, max_seconds: 60, max_tokens: 3_000_000, max_cost: 1 });
  assert.equal(settingsOf(p, { prompt: "x", max_budget_usd: 0.5 }).max_cost, 0.5, "max_budget_usd (deprecated) is max_cost");
  assert.equal((settingsOf(p, { prompt: "x", max_budget_usd: 0.5 }) as any).max_budget_usd, undefined);
  for (const [args, why] of [
    [{ prompt: "x", model: "opus" }, /allowed values/],
    [{ prompt: "x", tools: ["Bash"] }, /allowed values/],
    [{ prompt: "x", effort: "ultra" }, /allowed values/],
    [{ prompt: "x", max_turns: 99 }, /must be <= 20/],
    [{ prompt: "x", max_budget_usd: 0 }, /must be > 0/],
    [{ prompt: "x", max_budget_usd: 3 }, /max_cost must be <= 2/],
    [{ prompt: "x", max_cost: 1, max_budget_usd: 1 }, /max_cost and max_budget_usd/],
    [{ prompt: "x", max_tokens: 7_000_000 }, /must be <= 6000000/],
    [{ prompt: "x", system_mode: "prepend" }, /allowed values/],
    [{ prompt: "x", schema: { type: "nope" } }, /not a JSON Schema/],
    [{ prompt: "" }, /fewer than 1 characters/],
    [{ prompt: "x", other: 1 }, /additional properties/],
  ] as const) {
    assert.throws(() => settingsOf(p, args as any), why, JSON.stringify(args));
  }
});

test("buildArgs: print mode, the limits, only the node's tools, nothing from disk", () => {
  const p = preset("http://api.test");
  const s = settingsOf(p, { prompt: "x", model: "haiku", effort: "high", tools: ["Read", "Write"], schema: { type: "object" } });
  assert.deepEqual(buildArgs(s, targetOf(p, s.model), "/s/system.md"), [
    "-p",
    "--output-format", "stream-json", "--verbose",
    "--model", "haiku",
    "--effort", "high",
    "--max-turns", "6",
    "--max-budget-usd", "1",
    "--tools", "Read,Write",
    "--allowedTools", "Read,Write",
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--restricted",
    "--setting-sources", "",
    "--settings", '{"disableAllHooks":true}',
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
    "--append-system-prompt-file", "/s/system.md",
    "--json-schema", '{"type":"object"}',
  ]);
  const none = buildArgs(settingsOf(p, { prompt: "x", tools: [] }), targetOf(p, "sonnet"), "/s");
  assert.equal(none[none.indexOf("--tools") + 1], "", "no tools at all");
  assert.ok(!none.includes("--allowedTools"));
  assert.ok(!none.includes("--effort"), "no effort: Claude Code's own");
  assert.ok(!none.includes("--json-schema"));
  const replace = buildArgs(settingsOf(p, { prompt: "x", system_mode: "replace" }), targetOf(p, "sonnet"), "/s/system.md");
  assert.equal(replace[replace.indexOf("--system-prompt-file") + 1], "/s/system.md");
  assert.ok(!replace.includes("--append-system-prompt-file"));
  // A compatible endpoint: the model's name, no effort (the preset's
  // effort: false), no dollars of Claude Code's.
  const two = twoEndpoints("http://a.test", "http://b.test");
  const q = buildArgs(settingsOf(two, { prompt: "x", model: "qwen", effort: "high" }), targetOf(two, "qwen"), "/s");
  assert.equal(q[q.indexOf("--model") + 1], "qwen");
  assert.ok(!q.includes("--effort"));
  assert.ok(!q.includes("--max-budget-usd"));
  assert.throws(() => targetOf(two, "nope"), /no model nope/);
});

test("buildEnv is the whole environment of Claude Code", () => {
  assert.deepEqual(Object.keys(buildEnv("/h", "http://127.0.0.1:1", "sk-step")).sort(), [
    "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_AUTOUPDATER",
    "DISABLE_ERROR_REPORTING", "DISABLE_TELEMETRY", "HOME", "LANG", "PATH", "TMPDIR",
  ]);
  const e = buildEnv("/h", "http://127.0.0.1:1", "sk-step");
  assert.equal(e.ANTHROPIC_API_KEY, "sk-step");
  assert.equal(e.DISABLE_AUTOUPDATER, "1");
  const two = twoEndpoints("http://a.test", "http://b.test");
  assert.deepEqual(buildEnv("/h", "http://127.0.0.1:1", "sk-step", targetOf(two, "sonnet")), e, "Anthropic's endpoint adds nothing");
  const q = buildEnv("/h", "http://127.0.0.1:1", "sk-step", targetOf(two, "qwen"));
  assert.deepEqual(Object.fromEntries(Object.entries(q).filter(([k]) => !(k in e))), {
    ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "qwen",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "65536",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192",
  });
});

test("priceOf: tokens at a model's prices, per million", () => {
  assert.equal(priceOf({ input: 1_000_000, output: 500_000, cache_read: 2_000_000, cache_write: 0 }, PRICES), 1 + 1 + 0.2);
  assert.equal(priceOf({ input: 100, output: 5, cache_read: 1000, cache_write: 50 }, { input: 0, output: 0, cache_read: 0, cache_write: 0 }), 0);
});

test("the system prompt: the workspace, the preset's, the node's", () => {
  const p = preset("http://api.test");
  const ro = systemPrompt(p, settingsOf(p, { prompt: "x", system: "Sii breve." }), ["a.md"]);
  assert.match(ro, /in\/ of your working directory: a\.md/);
  assert.match(ro, /cannot write files/);
  assert.match(ro, /Rispondi in italiano\.\n\nSii breve\./);
  assert.match(systemPrompt(p, settingsOf(p, { prompt: "x", tools: ["Write"] }), []), /No files come.*\n.*out\//);
  assert.match(systemPrompt(p, settingsOf(p, { prompt: "x", json: true }), []), /## Answer\nAnswer with a single JSON value/);
  assert.doesNotMatch(systemPrompt(p, settingsOf(p, { prompt: "x", json: true, schema: { type: "object" } }), []), /## Answer/);
});

test("the system prompt: a step that writes notes of the vault, not files, is told so", () => {
  const p = preset("http://api.test");
  const s = settingsOf(p, { prompt: "x" });
  const w = systemPrompt(p, s, [], undefined, "write");
  assert.match(w, /You cannot write files in this task: the notes it asks for go into gosidian's vault/);
  assert.doesNotMatch(w, /answer with text/);
  assert.match(w, /## gosidian\nThe MCP server gosidian \(tools mcp__gosidian__memory_\*\) reads and writes/);
  assert.match(w, /memory_create, memory_update or memory_edit/);
  const r = systemPrompt(p, s, [], undefined, "read");
  assert.match(r, /cannot write files in this task: answer with text/);
  assert.match(r, /reads the vault of the run's project: you cannot change its notes/);
  assert.doesNotMatch(systemPrompt(p, s, []), /## gosidian/);
  assert.doesNotMatch(systemPrompt(p, s, [], undefined, "none"), /## gosidian/);
});

test("effortOf: the effort the requests carried, or a note", () => {
  const seen = new Map([["claude-sonnet-5-5", new Set<string | null>(["high"])], ["claude-haiku-4-5", new Set<string | null>([null])]]);
  assert.deepEqual(effortOf("high", "claude-sonnet-5-5", seen), { requested: "high", applied: "high" });
  assert.deepEqual(effortOf("high", "claude-haiku-4-5", seen), { requested: "high", applied: null, note: "claude-haiku-4-5 takes no effort level: Claude Code sent its requests without one" });
  assert.deepEqual(effortOf(undefined, "claude-sonnet-5-5", seen), { requested: null, applied: "high" });
  assert.match(effortOf("low", "claude-sonnet-5-5", seen).note!, /sent the effort high, not low/);
  assert.deepEqual(effortOf("high", "qwen", new Map([["qwen", new Set<string | null>([null])]]), false), { requested: "high", applied: null, note: "qwen takes no effort level in the preset: the step ran without --effort" });
  assert.deepEqual(effortOf(undefined, "qwen", new Map(), false), { requested: null, applied: null });
});

test("versions: comparing, and the effort levels of a --help", () => {
  assert.ok(isVersion("2.1.301") && isVersion("2.1.302-beta.1") && !isVersion("latest") && !isVersion("2.1"));
  assert.ok(compareVersions("2.1.301", "2.1.292") > 0);
  assert.ok(compareVersions("2.1.9", "2.1.10") < 0);
  assert.ok(compareVersions("10.0.0", "9.9.9") > 0);
  assert.equal(compareVersions("2.1.301", "2.1.301"), 0);
  assert.ok(compareVersions("2.1.302-beta", "2.1.302") < 0);
  assert.throws(() => compareVersions("latest", "1.0.0"), /not a version/);
  const help = `  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --environment <environment_id>        Create a new cloud session (ccpool_...).`;
  assert.deepEqual(effortLevels(help), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(effortLevels("no such flag"), []);
});

test("findBinary takes the platform package's native binary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bin-"));
  const scope = path.join(dir, "node_modules", "@anthropic-ai");
  fs.mkdirSync(path.join(scope, "claude-code", "bin"), { recursive: true });
  fs.writeFileSync(path.join(scope, "claude-code", "bin", "claude.exe"), "#!/usr/bin/env node\n");
  assert.equal(findBinary(dir), undefined, "a script is not the binary");
  fs.mkdirSync(path.join(scope, "claude-code-linux-x64-musl"));
  fs.writeFileSync(path.join(scope, "claude-code-linux-x64-musl", "claude"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]));
  assert.equal(findBinary(dir), "node_modules/@anthropic-ai/claude-code-linux-x64-musl/claude");
  fs.rmSync(dir, { recursive: true });
});

test("RWLock: readers together, a writer alone and before later readers", async () => {
  const l = new RWLock();
  const order: string[] = [];
  let endA!: () => void;
  const a = l.read(() => new Promise<void>((ok) => { order.push("a"); endA = ok; }));
  const b = l.read(async () => void order.push("b"));
  await b;
  const w = l.write(async () => void order.push("w"));
  const c = l.read(async () => void order.push("c"));
  await new Promise((ok) => setTimeout(ok, 20));
  assert.deepEqual(order, ["a", "b"], "the writer waits for a, c waits for the writer");
  endA();
  await Promise.all([a, w, c]);
  assert.deepEqual(order, ["a", "b", "w", "c"]);
});

test("the subscription's headers: session, week, resets; and the endpoint's answer", () => {
  const h = new Headers({
    "anthropic-ratelimit-unified-5h-utilization": "0.01",
    "anthropic-ratelimit-unified-5h-reset": "1792179600",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-7d-utilization": "0.875",
    "anthropic-ratelimit-unified-7d-reset": "1792605600",
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-7d_opus-utilization": "0.3",
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-overage-status": "rejected",
    "anthropic-ratelimit-unified-fallback-percentage": "0.5",
    "request-id": "req_1",
  });
  assert.equal(rateLimitHeaderNames(h).length, 11);
  const now = new Date("2026-10-16T18:00:00Z");
  assert.deepEqual(fromHeaders(h, now), {
    applicable: true,
    source: "headers",
    read_at: "2026-10-16T18:00:00.000Z",
    status: "allowed",
    representative_claim: "five_hour",
    overage_status: "rejected",
    session: { used_percent: 1, left_percent: 99, resets_at: new Date(1792179600_000).toISOString(), status: "allowed" },
    week: { used_percent: 87.5, left_percent: 12.5, resets_at: new Date(1792605600_000).toISOString(), status: "allowed" },
    week_models: { opus: { used_percent: 30, left_percent: 70 } },
  });
  assert.equal(fromHeaders(new Headers({ "content-type": "x" })), undefined);
  const e = fromEndpoint({ five_hour: { utilization: 12, resets_at: "2026-10-16T20:00:00Z" }, seven_day: { utilization: 40.5, resets_at: null }, seven_day_sonnet: { utilization: 3 }, seven_day_oauth_apps: null }, now)!;
  assert.deepEqual(e.session, { used_percent: 12, left_percent: 88, resets_at: "2026-10-16T20:00:00.000Z" });
  assert.deepEqual(e.week, { used_percent: 40.5, left_percent: 59.5 });
  assert.deepEqual(e.week_models, { sonnet: { used_percent: 3, left_percent: 97 } });
  assert.equal(fromEndpoint({ error: "x" }), undefined);
});

test("Subscription: the last values, the endpoint once, a ping, and min_left_percent", async () => {
  let now = new Date("2026-10-16T18:00:00Z");
  let pings = 0;
  let usageCalls = 0;
  const util = { "5h": "0.25", "7d": "0.95" };
  const sub: Subscription = new Subscription({
    kind: "oauth",
    now: () => now,
    usage: async () => {
      usageCalls++;
      return { status: 403, body: { error: "scope" } };
    },
    ping: async () => {
      pings++;
      sub.note({ "anthropic-ratelimit-unified-5h-utilization": util["5h"], "anthropic-ratelimit-unified-7d-utilization": util["7d"], "anthropic-ratelimit-unified-7d-reset": "1792605600" });
    },
  });
  const first: any = await sub.read(60_000);
  assert.equal(first.session.left_percent, 75);
  assert.equal(first.source, "headers");
  assert.equal(usageCalls, 1);
  assert.equal(pings, 1);
  assert.match(sub.endpointOff, /403/);
  await sub.read(60_000);
  assert.equal(pings, 1, "fresh values are not read again");
  assert.equal(await sub.shortfall({ session: 50, week: 0 }, 60_000), "");
  const short = await sub.shortfall({ session: 0, week: 10 }, 60_000);
  assert.match(short, /5% of its week left, less than the preset's min_left_percent \(10%\): it resets at /);
  assert.ok(short.endsWith(new Date(1792605600_000).toISOString()));
  now = new Date(now.getTime() + 120_000);
  util["7d"] = "0.5";
  assert.equal(await sub.shortfall({ session: 0, week: 10 }, 60_000), "", "old values are read again");
  assert.equal(pings, 2);
  assert.equal(usageCalls, 1, "the endpoint that refused is not asked again");
  const key = new Subscription({ kind: "api_key", usage: async () => ({ status: 200, body: {} }), ping: async () => {} });
  assert.deepEqual(await key.read(0), { applicable: false, reason: "an API key: the limits of a subscription do not apply" });
  assert.equal(await key.shortfall({ session: 50, week: 50 }, 0), "");
  const none = new Subscription({ kind: "none", usage: async () => ({ status: 200, body: {} }), ping: async () => {} });
  assert.match((await none.read(0) as any).reason, /no endpoint of the preset is a subscription/);
  none.note({ "anthropic-ratelimit-unified-5h-utilization": "0.5" });
  assert.equal(none.latest, undefined);
});

test("extractJSON finds the value, bare, fenced or inside prose; check validates it", () => {
  assert.deepEqual(extractJSON('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.deepEqual(extractJSON('Ecco:\n```json\n{"a":2}\n```\n'), { ok: true, value: { a: 2 } });
  assert.equal(extractJSON("niente").ok, false);
  const schema = { type: "object", required: ["n"], properties: { n: { type: "integer" } } };
  assert.deepEqual(check(schema, { n: 1 }), []);
  assert.match(check(schema, { n: "x" })[0], /must be integer/);
});

test("safeName keeps a plain name", () => {
  assert.equal(safeName("../../etc/passwd", "f"), "passwd");
  assert.equal(safeName(".env", "f"), "env");
});

test("a preset's repositories and gosidian's MCP: the node's settings", () => {
  const p = preset("http://api.test", `repos:
  - {name: app, url: "https://git.example.com/team/app.git", branch_prefix: bots/}
  - {name: docs, url: /srv/docs.git}
mcp: [read, write]`);
  assert.deepEqual(p.repos.map((r) => [r.name, r.base, r.branch_prefix]), [["app", "main", "bots/"], ["docs", "main", "agent/"]]);
  assert.deepEqual(p.mcp, ["read", "write"]);
  const s: any = runSchema(p);
  assert.deepEqual(s.properties.repo.properties.name.enum, ["app", "docs"]);
  assert.deepEqual(s.properties.repo.required, ["name"]);
  assert.deepEqual(s.properties.mcp, { enum: ["none", "read", "write"], default: "none", description: s.properties.mcp.description });
  assert.deepEqual(settingsOf(p, { prompt: "x", repo: { name: "docs", pr: { title: "t" } }, mcp: "write" }).repo, { name: "docs", push: true, pr: { title: "t" } });
  assert.equal(settingsOf(p, { prompt: "x" }).mcp, "none");
  assert.equal(settingsOf(p, { prompt: "x" }).repo, undefined);
  assert.throws(() => settingsOf(p, { prompt: "x", repo: { name: "app", force: true } }), /additional properties/);
  assert.throws(() => settingsOf(p, { prompt: "x", repo: {} }), /required property 'name'/);
  const ro: any = runSchema(preset("http://api.test", "mcp: [read]"));
  assert.deepEqual(ro.properties.mcp.enum, ["none", "read"]);
  assert.equal(ro.properties.repo, undefined);
  assert.deepEqual(preset("http://api.test").mcp, []);
  assert.deepEqual(preset("http://api.test").repos, []);
});

test("gosidian's MCP: the call's _meta, the server and its rule in Claude Code's arguments, the token in its environment", () => {
  const meta = { "gosidian/mcp_url": "http://gosidian:8080/mcp", "gosidian/mcp_token": "tok-123" };
  assert.equal(mcpOf(undefined, meta), undefined);
  assert.equal(mcpOf("none", meta), undefined);
  assert.deepEqual(mcpOf("write", meta), { level: "write", url: "http://gosidian:8080/mcp", token: "tok-123" });
  assert.throws(() => mcpOf("read", {}), /with\.mcp read: the call carries no gosidian\/mcp_url and gosidian\/mcp_token in its _meta: gosidian is too old for it, or the manifest is not accepted with its permissions\.mcp/);
  assert.throws(() => mcpOf("read", { ...meta, "gosidian/mcp_token": "" }), /carries no/);
  assert.throws(() => mcpOf("read", { ...meta, "gosidian/mcp_url": "http://x/${HOME}" }), /not an http\(s\) address/);
  assert.throws(() => mcpOf("read", { ...meta, "gosidian/mcp_token": "tok\n123" }), /not a token/);
  assert.equal(mcpConfig(), '{"mcpServers":{}}');
  const p = preset("http://api.test", "mcp: [read]");
  const args = buildArgs(settingsOf(p, { prompt: "x", tools: [] }), targetOf(p, "sonnet"), "/s", { url: meta["gosidian/mcp_url"] });
  assert.equal(args[args.indexOf("--tools") + 1], "", "no built-in tool");
  assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__gosidian__*", "every tool of gosidian's server");
  assert.ok(args.includes("--strict-mcp-config") && args.includes("--restricted"));
  assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]), { mcpServers: { gosidian: { type: "http", url: "http://gosidian:8080/mcp", headers: { Authorization: "Bearer ${GOSIDIAN_MCP_TOKEN}" } } } });
  assert.ok(!args.join(" ").includes("tok-123"));
  const e = buildEnv("/h", "http://127.0.0.1:1", "sk-step", undefined, "tok-123");
  assert.equal(e.GOSIDIAN_MCP_TOKEN, "tok-123");
  assert.equal(buildEnv("/h", "http://127.0.0.1:1", "sk-step").GOSIDIAN_MCP_TOKEN, undefined);
});

test("a step's repository: the system prompt, the commit message, the steps' log", () => {
  const p = preset("http://api.test", "repos: [{name: app, url: /srv/app.git}]");
  const repo = { name: "app", branch: "agent/r-1-0a1b", base: "main" };
  const edit = systemPrompt(p, settingsOf(p, { prompt: "x", tools: ["Read", "Write"], repo: { name: "app" } }), [], repo);
  assert.match(edit, /## Workspace\n.*\nWrite the files you produce in the folder out\/: they are handed back with your answer\. Change nothing elsewhere, but in repo\/\.\n\n## Repository\nThe repository app is checked out in the folder repo\/ of your working directory, on the branch agent\/r-1-0a1b, from main\. The folders in\/ and out\/ are not part of it: they are as above\.\nMake your changes to its files there\. Do not commit, push or change branches: when the task ends, the plugin commits what you changed\.\n\nRispondi/);
  assert.doesNotMatch(edit, /git log/, "no Bash, no git");
  const bash = systemPrompt(p, { ...settingsOf(p, { prompt: "x" }), tools: ["Read", "Bash"] }, [], repo);
  assert.match(bash, /git log, git diff and git status work in repo\/; its git folder is read-only\./);
  assert.match(systemPrompt(p, settingsOf(p, { prompt: "x", access: "read" }), [], repo), /Read its files there: you cannot change them in this task\./);
  assert.doesNotMatch(systemPrompt(p, settingsOf(p, { prompt: "x" }), []), /Repository|repo\//);

  const meta = { "gosidian/project": "rag", "gosidian/run": "r-1" };
  const long = "Fix the parser of the dates in every module of the application, and add its tests";
  const msg = commitMessage(p, `\n  ${long}\nThen run them.`, "Done: 3 files.\n", meta).split("\n");
  assert.equal(msg[0], `claude-test: ${long.slice(0, 71)}…`);
  assert.equal(msg[0].length, "claude-test: ".length + 72);
  assert.deepEqual(msg.slice(1), ["", "Done: 3 files.", "", "gosidian: project rag, run r-1", ""]);
  const big = commitMessage(p, "Short", "x".repeat(5000), undefined).split("\n");
  assert.equal(big[0], "claude-test: Short");
  assert.equal(big[2], "x".repeat(4000));
  assert.deepEqual(big.slice(3), ["[…]", "", "gosidian: project -, run -", ""]);
  assert.deepEqual(commitMessage(p, "Short", "", meta).split("\n"), ["claude-test: Short", "", "gosidian: project rag, run r-1", ""]);

  const st = stepOf({ model: { id: "m" }, usage: {}, repo: { name: "app", branch: "agent/r-1-0a1b", commit: "c0ffee", changed: 1 } }, meta, 0, 1000);
  assert.deepEqual(st.repo, { name: "app", branch: "agent/r-1-0a1b", commit: "c0ffee" });
  assert.deepEqual(stepOf({ repo: { name: "app", branch: "agent/x" } }, undefined, 0, 1).repo, { name: "app", branch: "agent/x" }, "nothing changed: no commit");
  assert.equal(stepOf({}, undefined, 0, 1).repo, undefined);
});
