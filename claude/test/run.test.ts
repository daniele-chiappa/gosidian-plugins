// A step with a fake Claude Code (fake-claude.ts) behind the real proxy and
// a fake API: the files in and out, the environment it gets, the answer as
// JSON, the effort, the limits, the subscription, the cleanup; and a step on
// a compatible endpoint, its model, environment, cost and limits; a
// repository on disk, cloned, edited and committed; gosidian's MCP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mockAPI, type MockOptions } from "./mock-api.ts";
import { bareRepo, fake, fileServer, git, LOCAL_KEY, mcpEndpoint, preset, stepDirs, testEnv, TOKEN, twoEndpoints } from "./helpers.ts";
import { runStep, StepError, VERSION, type Env } from "../src/run.ts";

const never = new AbortController().signal;

async function withStep(fn: (t: { api: Awaited<ReturnType<typeof mockAPI>>; env: Env; logs: string[] }) => Promise<void>, o: { api?: MockOptions; extra?: string } = {}) {
  const api = await mockAPI(o.api);
  const te = await testEnv(preset(api.url, o.extra));
  try {
    await fn({ api, env: te.env, logs: te.logs });
    assert.deepEqual(stepDirs(te.env), [], "the step's folder is removed");
    for (const l of te.logs) assert.ok(!l.includes(TOKEN), "the token is in no log");
  } finally {
    await te.close();
    await api.close();
  }
}

test("a step: files in in/, a file back from out/, only its environment, the proxy with the token", async () => {
  const files = await fileServer({ "procedura.md": "# Controllo\nPasso 1", "note.txt": "ciao" });
  try {
    await withStep(async ({ api, env }) => {
      const res = await runStep(env, {
        prompt: fake({ env: true, write: { "riassunto.md": "# Riassunto" }, text: "Fatto." }),
        system: "Sii breve.",
        files: files.refs(),
        model: "haiku",
        effort: "high",
        tools: ["Read", "Write"],
      }, 50_000, never);
      const o: any = res.output;
      assert.equal(o.text, "Fatto.");
      assert.deepEqual(o.model, { name: "haiku", id: "claude-haiku-5-5", endpoint: "anthropic" }, "the alias as this version resolves it");
      assert.deepEqual(o.effort, { requested: "high", applied: "high" });
      assert.equal(o.subtype, "success");
      assert.equal(o.stop, "done");
      assert.equal(o.turns, 1);
      assert.deepEqual(o.usage, { input: 100, output: 5, cache_read: 1000, cache_write: 50, total_tokens: 1155 });
      assert.equal(o.cost, 0.0123);
      assert.equal(o.cost_source, "agent");
      assert.deepEqual(o.denials, []);
      assert.deepEqual(o.tools, {}, "no tool called");
      assert.deepEqual(o.allowed_tools, ["Read", "Write"]);
      assert.deepEqual(o.executor, { plugin: "gosidian-claude", version: VERSION, agent: "claude-code", agent_version: "2.0.0" });
      assert.equal(o.claude_code, "2.0.0");
      assert.equal(o.subscription.source, "headers");
      assert.deepEqual(o.subscription.session, { used_percent: 25, left_percent: 75, resets_at: new Date(1792179600_000).toISOString(), status: "allowed" });
      assert.equal(o.subscription.week.left_percent, 50);
      const names = res.files.map((f) => f.name).sort();
      assert.deepEqual(names, ["env.json", "riassunto.md"]);
      const seen = JSON.parse(res.files.find((f) => f.name === "env.json")!.data.toString());
      // Only what it needs (the shell that starts it adds PWD and SHLVL).
      assert.deepEqual(Object.keys(seen.env).filter((k) => !["PWD", "SHLVL", "_"].includes(k)).sort(), [
        "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_AUTOUPDATER",
        "DISABLE_ERROR_REPORTING", "DISABLE_TELEMETRY", "HOME", "LANG", "PATH", "TMPDIR",
      ]);
      assert.ok(!JSON.stringify(seen).includes(TOKEN), "the token is not in Claude Code's environment or arguments");
      assert.match(seen.env.ANTHROPIC_API_KEY, /^sk-step-/);
      assert.match(seen.cwd, /step-[0-9a-f]+\/work$/);
      assert.deepEqual(seen.in.sort(), ["note.txt", "procedura.md"]);
      assert.match(seen.system, /in\/ of your working directory: procedura\.md, note\.txt/);
      assert.match(seen.system, /Rispondi in italiano\.\n\nSii breve\./);
      assert.ok(seen.argv.includes("--restricted"));
      assert.equal(seen.argv[seen.argv.indexOf("--effort") + 1], "high");
      assert.equal(seen.argv[seen.argv.indexOf("--max-budget-usd") + 1], "1", "Claude Code keeps the dollars on Anthropic's");
      const up = api.requests.filter((r) => r.path === "/v1/messages");
      assert.equal(up.at(-1)!.headers.authorization, `Bearer ${TOKEN}`, "the proxy put the token in");
      assert.equal(up.at(-1)!.headers["x-api-key"], undefined);
    });
  } finally {
    await files.close();
  }
});

test("Claude Code's environment has no variable of the server's", async () => {
  process.env.SERVER_ONLY_SECRET = "do-not-pass";
  try {
    await withStep(async ({ env }) => {
      const res = await runStep(env, { prompt: fake({ env: true }), tools: ["Write"] }, undefined, never);
      const seen = JSON.parse(res.files[0].data.toString());
      assert.equal(seen.env.SERVER_ONLY_SECRET, undefined);
      assert.equal(seen.env.TEST_TOKEN, undefined);
      for (const k of Object.keys(seen.env)) {
        assert.ok(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_AUTOUPDATER", "DISABLE_ERROR_REPORTING", "DISABLE_TELEMETRY", "HOME", "LANG", "PATH", "TMPDIR", "PWD", "SHLVL", "_"].includes(k), k);
      }
    });
  } finally {
    delete process.env.SERVER_ONLY_SECRET;
  }
});

test("the answer as JSON: the structured output, checked; the text read as JSON", async () => {
  await withStep(async ({ env }) => {
    const schema = { type: "object", required: ["passi"], properties: { passi: { type: "integer" } } };
    const ok = await runStep(env, { prompt: fake({ structured: { passi: 3 }, text: '{"passi":3}' }), schema }, undefined, never);
    assert.deepEqual((ok.output as any).json, { passi: 3 });
    await assert.rejects(runStep(env, { prompt: fake({ text: "tre" }), schema }, undefined, never), /did not follow the schema: Claude Code gave no structured output; it began: tre/);
    await assert.rejects(runStep(env, { prompt: fake({ structured: { passi: "tre" } }), schema }, undefined, never), /does not follow the schema: \/passi must be integer/);
    const text = await runStep(env, { prompt: fake({ text: 'Ecco: {"a": [1, 2]}' }), json: true }, undefined, never);
    assert.deepEqual((text.output as any).json, { a: [1, 2] });
    await assert.rejects(runStep(env, { prompt: fake({ text: "no" }), json: true }, undefined, never), /the answer is not JSON/);
  });
});

test("a result that is not success fails the step with its reason", async () => {
  await withStep(async ({ env }) => {
    await assert.rejects(runStep(env, { prompt: fake({ subtype: "error_max_turns", errors: ["Reached maximum number of turns (6)"], turns: 7 }) }, undefined, never), (e: Error) => e instanceof StepError && /stopped at max_turns \(6 turns\) after 7 turns, 1155 tokens, \$0\.0123/.test(e.message));
    await assert.rejects(runStep(env, { prompt: fake({ subtype: "error_max_budget_usd" }), max_cost: 0.5 }, undefined, never), /stopped at max_cost \(\$0\.5\)/);
    await assert.rejects(runStep(env, { prompt: fake({ subtype: "error_max_budget_usd" }), max_budget_usd: 0.25 }, undefined, never), /stopped at max_cost \(\$0\.25\)/, "max_budget_usd is max_cost");
    await assert.rejects(runStep(env, { prompt: fake({ subtype: "error_during_execution", errors: ["boom"] }) }, undefined, never), /ended with error_during_execution: boom/);
    await assert.rejects(runStep(env, { prompt: fake({ noresult: true }) }, undefined, never), /ended without a result \(exit 1\): Error: something went wrong/);
  });
  await withStep(async ({ env }) => {
    await assert.rejects(runStep(env, { prompt: fake({}) }, undefined, never), /ended with success \(the API answered 529\): API Error: 529/);
  }, { api: { messageStatus: 529 } });
});

test("effort: a model without levels runs without one, and the output says so", async () => {
  await withStep(async ({ env }) => {
    // A version 1.x resolves haiku to a model of the 4.5 generation.
    await env.versions.update("1.0.0", true);
    const res = await runStep(env, { prompt: fake({}), model: "haiku", effort: "high" }, undefined, never);
    const o: any = res.output;
    assert.equal(o.model.id, "claude-haiku-4-5-20251001");
    assert.deepEqual(o.effort, { requested: "high", applied: null, note: "claude-haiku-4-5-20251001 takes no effort level: Claude Code sent its requests without one" });
    const dflt = await runStep(env, { prompt: fake({}), model: "sonnet" }, undefined, never);
    assert.deepEqual((dflt.output as any).effort, { requested: null, applied: null });
  });
  await withStep(async ({ env }) => {
    // The preset allows a level the version does not take.
    await assert.rejects(runStep(env, { prompt: fake({}), effort: "ultra" }, undefined, never), /Claude Code 2\.0\.0 takes no effort ultra: it takes low, medium, high, xhigh, max/);
  }, { extra: "effort: {allowed: [low, ultra]}" });
});

test("the limits stop Claude Code: time, the run's tokens, cancel", async () => {
  await withStep(async ({ env }) => {
    const t0 = Date.now();
    await assert.rejects(runStep(env, { prompt: fake({ sleep: 10 }), max_seconds: 1 }, undefined, never), /stopped at max_seconds \(1 s\)/);
    assert.ok(Date.now() - t0 < 6000);
  });
  await withStep(async ({ api, env }) => {
    const before = api.requests.length;
    await assert.rejects(runStep(env, { prompt: fake({ sleep: 2 }) }, 500, never), /stopped at max_tokens \(the run's max_llm_tokens\) after \d+ turns, 1155 tokens/);
    await assert.rejects(runStep(env, { prompt: fake({}) }, 0, never), /no language-model tokens left/);
    assert.equal(api.requests.slice(before).filter((r) => r.path === "/v1/messages").length, 1);
    // The step's own max_tokens, under the run's.
    // It says what it spent: gosidian counts it in the task and the budget.
    await assert.rejects(runStep(env, { prompt: fake({ sleep: 2 }), max_tokens: 600 }, 50_000, never), (e: Error) => {
      const usage = (e as StepError).spent?.usage as { total_tokens?: number } | undefined;
      return e instanceof StepError && /stopped at max_tokens \(600 tokens\)/.test(e.message) && (usage?.total_tokens ?? 0) > 600;
    });
  });
  await withStep(async ({ env }) => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    await assert.rejects(runStep(env, { prompt: fake({ sleep: 10 }) }, undefined, ac.signal), /stopped at canceled \(the call was canceled\)/);
  });
});

test("min_left_percent: a step does not start when the subscription has less left", async () => {
  await withStep(async ({ api, env }) => {
    // The probe at the install saw the headers: forget them.
    env.subscription.latest = undefined;
    const before = api.requests.length;
    await assert.rejects(runStep(env, { prompt: fake({}) }, undefined, never), (e: Error) => /the subscription has 25% of its session \(5 hours\) left, less than the preset's min_left_percent \(30%\): it resets at /.test(e.message));
    // The endpoint (403 for this token), then a ping of one token for the headers.
    const asked = api.requests.slice(before);
    assert.deepEqual(asked.map((r) => r.path), ["/api/oauth/usage", "/v1/messages"]);
    assert.equal(asked[1].body.max_tokens, 1);
    api.opts.fiveHour = 0.5;
    env.subscription.latest = undefined;
    const ok = await runStep(env, { prompt: fake({}) }, undefined, never);
    assert.equal((ok.output as any).subscription.session.left_percent, 50);
  }, { api: { fiveHour: 0.75 }, extra: "  min_left_percent: {session: 30, week: 10}" });
});

test("settings outside the preset, and files that are not what gosidian said, fail before Claude Code", async () => {
  const files = await fileServer({ "a.txt": "aaa" });
  try {
    await withStep(async ({ api, env }) => {
      const before = api.requests.length;
      await assert.rejects(runStep(env, { prompt: "x", model: "opus" }, undefined, never), /allowed values/);
      await assert.rejects(runStep(env, { prompt: "x", tools: ["Bash"] }, undefined, never), /allowed values/);
      await assert.rejects(runStep(env, { prompt: "x", max_turns: 99 }, undefined, never), /must be <= 20/);
      await assert.rejects(runStep(env, { prompt: "x", files: ["in/a.txt"] }, undefined, never), /by reference/);
      await assert.rejects(runStep(env, { prompt: "x", files: files.refs({ "a.txt": { sha256: "0".repeat(64) } }) }, undefined, never), /SHA-256 differs/);
      assert.equal(api.requests.length, before);
    });
  } finally {
    await files.close();
  }
});

// withTwo runs fn with a preset of two endpoints: Anthropic's (a
// subscription) and a compatible one under /api.
async function withTwo(fn: (t: { anthropic: Awaited<ReturnType<typeof mockAPI>>; local: Awaited<ReturnType<typeof mockAPI>>; env: Env; logs: string[] }) => Promise<void>, o: { api?: MockOptions; extra?: string } = {}) {
  const anthropic = await mockAPI(o.api);
  const local = await mockAPI({ prefix: "/api" });
  const te = await testEnv(twoEndpoints(anthropic.url, local.url, o.extra));
  try {
    await fn({ anthropic, local, env: te.env, logs: te.logs });
    assert.deepEqual(stepDirs(te.env), [], "the step's folder is removed");
    for (const l of te.logs) assert.ok(!l.includes(TOKEN) && !l.includes(LOCAL_KEY), "no key is in a log");
  } finally {
    await te.close();
    await anthropic.close();
    await local.close();
  }
}

test("a compatible endpoint: its model in every message, Claude Code's environment, the cost at the preset's prices", async () => {
  await withTwo(async ({ anthropic, local, env }) => {
    const before = anthropic.requests.length;
    const res = await runStep(env, { prompt: fake({ env: true, background: true, calls: ["Read", "Grep", "Read"] }), model: "qwen", effort: "high", tools: ["Read", "Write"] }, 50_000, never);
    const o: any = res.output;
    assert.deepEqual(o.model, { name: "qwen", id: "qwen/qwen3-coder", endpoint: "local" });
    assert.equal(anthropic.requests.length, before, "nothing went to Anthropic");
    const up = local.requests.filter((r) => r.path === "/api/v1/messages");
    assert.equal(up.length, 2, "the step's message and a background task's");
    for (const r of up) {
      assert.equal(r.body.model, "qwen/qwen3-coder");
      assert.equal(r.body.output_config, undefined, "the proxy drops the effort Claude Code sends to a model without one");
      assert.equal(r.headers.authorization, `Bearer ${LOCAL_KEY}`);
      assert.equal(r.headers["x-api-key"], undefined);
      assert.ok(!String(r.headers["anthropic-beta"] ?? "").includes("oauth"));
      assert.equal(r.headers["x-title"], "gosidian");
    }
    // Two answers of 100 + 5 + 1000 + 50 tokens, at 1, 2, 0.1 and 1.25 dollars a million.
    assert.equal(o.usage.total_tokens, 2310, "the proxy's count: Claude Code's result has one answer");
    assert.equal(o.cost, 0.000545);
    assert.equal(o.cost_source, "prices");
    assert.deepEqual(o.tools, { Read: 2, Grep: 1 });
    assert.deepEqual(o.effort, { requested: "high", applied: null, note: "qwen takes no effort level in the preset: the step ran without --effort" });
    assert.equal(o.subscription, undefined, "a subscription only on its own endpoint");
    assert.equal(o.stop, "done");
    const seen = JSON.parse(res.files.find((f) => f.name === "env.json")!.data.toString());
    for (const k of ["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL"]) assert.equal(seen.env[k], "qwen", k);
    assert.equal(seen.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, "1");
    assert.equal(seen.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "65536");
    assert.equal(seen.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "8192");
    assert.ok(!JSON.stringify(seen).includes(LOCAL_KEY), "the endpoint's key is not in Claude Code's environment");
    assert.equal(seen.argv[seen.argv.indexOf("--model") + 1], "qwen");
    assert.ok(!seen.argv.includes("--effort"), "a model without effort gets no --effort");
    assert.ok(!seen.argv.includes("--max-budget-usd"), "Claude Code knows no price of the endpoint's models");
  });
});

test("a compatible model without prices costs nothing; a cut answer stops with length; replace puts the system prompt in place of Claude Code's", async () => {
  await withTwo(async ({ env }) => {
    const free: any = (await runStep(env, { prompt: fake({ env: true, stop_reason: "max_tokens" }), model: "free", system: "Sei un revisore.", system_mode: "replace", tools: ["Write"] }, undefined, never));
    assert.equal(free.output.cost, 0);
    assert.equal(free.output.cost_source, "none");
    assert.equal(free.output.stop, "length");
    const seen = JSON.parse(free.files[0].data.toString());
    assert.ok(seen.argv.includes("--system-prompt-file"));
    assert.ok(!seen.argv.includes("--append-system-prompt-file"));
    assert.match(seen.system, /## Workspace[\s\S]*Sei un revisore\./);
    assert.equal(seen.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined, "a model without context leaves Claude Code's");
  });
});

test("max_cost on a compatible endpoint: the plugin stops Claude Code at the preset's prices", async () => {
  await withTwo(async ({ env }) => {
    await assert.rejects(runStep(env, { prompt: fake({ sleep: 2 }), model: "qwen", max_cost: 0.0001 }, undefined, never), /stopped at max_cost \(\$0\.0001 at the preset's prices\)/);
    // No prices: nothing to stop at.
    const free: any = await runStep(env, { prompt: fake({}), model: "free", max_cost: 0.0001 }, undefined, never);
    assert.equal(free.output.cost, 0);
  });
});

test("min_left_percent holds only the steps on the subscription's endpoint", async () => {
  await withTwo(async ({ env }) => {
    env.subscription.latest = undefined;
    await assert.rejects(runStep(env, { prompt: fake({}), model: "sonnet" }, undefined, never), /less than the preset's min_left_percent/);
    const ok: any = await runStep(env, { prompt: fake({}), model: "qwen" }, undefined, never);
    assert.equal(ok.output.model.endpoint, "local");
    const sub: any = await runStep(env, { prompt: fake({}), model: "sonnet" }, undefined, never).catch((e) => e);
    assert.ok(sub instanceof StepError);
  }, { api: { fiveHour: 0.75 }, extra: "  min_left_percent: {session: 30}" });
});

test("access gives the tools its level has, within the preset's", async () => {
  await withStep(async ({ env }) => {
    const res = await runStep(env, { prompt: fake({ env: true }), access: "edit" }, undefined, never);
    const o: any = res.output;
    assert.deepEqual(o.allowed_tools, ["Read", "Grep", "Glob", "Write"], "the preset allows no Edit");
    await assert.rejects(runStep(env, { prompt: "x", access: "exec" }, undefined, never), /access exec needs Bash, which the preset does not allow/);
    await assert.rejects(runStep(env, { prompt: "x", access: "read", tools: ["Write"] }, undefined, never), /with\.tools: Write not within access read \(Read, Grep, Glob\)/);
  });
});

// withRepo runs fn with a preset whose repository app is a bare one on disk.
async function withRepo(fn: (t: { api: Awaited<ReturnType<typeof mockAPI>>; env: Env; bare: string }) => Promise<void>, more = "") {
  const bare = bareRepo();
  await withStep(({ api, env }) => fn({ api, env, bare }), { extra: `repos:\n  - {name: app, url: "${bare}"${more}}` });
}

const branches = (bare: string) => git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads/").trim().split("\n").filter(Boolean);

test("a repository: cloned on the step's branch, the agent's edits committed and pushed, the prompt says where", async () => {
  await withRepo(async ({ env, bare }) => {
    const meta = { "gosidian/project": "rag", "gosidian/run": "r-7" };
    const res = await runStep(env, {
      prompt: fake({ env: true, edit: { "repo/a.txt": "one\ntwo\nthree\n", "repo/src/b.txt": "new\n" }, text: "Added three, and b." }),
      tools: ["Read", "Write"],
      repo: { name: "app" },
    }, undefined, never, 0, meta);
    const o: any = res.output;
    assert.match(o.repo.branch, /^agent\/r-7-[0-9a-f]{16}$/);
    assert.match(o.repo.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(o.repo, { name: "app", base: "main", branch: o.repo.branch, commit: o.repo.commit, changed: 2, files: ["a.txt", "src/b.txt"], insertions: 2, deletions: 0, pushed: true });
    assert.deepEqual(branches(bare), [o.repo.branch, "main"].sort());
    assert.equal(git(bare, "rev-parse", o.repo.branch).trim(), o.repo.commit);
    assert.equal(git(bare, "rev-list", "--count", "main").trim(), "1", "main did not move");
    assert.deepEqual(git(bare, "show", "--name-only", "--format=", o.repo.branch).trim().split("\n"), ["a.txt", "src/b.txt"]);
    const msg = git(bare, "log", "-1", "--format=%B", o.repo.branch).trim().split("\n");
    assert.match(msg[0], /^claude-test: FAKE:\{/);
    assert.ok(msg[0].length <= "claude-test: ".length + 72, msg[0]);
    assert.deepEqual(msg.slice(1), ["", "Added three, and b.", "", "gosidian: project rag, run r-7"]);
    assert.deepEqual(res.files.map((f) => f.name), ["env.json"], "the repository's files are not given back");
    const seen = JSON.parse(res.files[0].data.toString());
    assert.match(seen.system, new RegExp(`## Repository\nThe repository app is checked out in the folder repo/ of your working directory, on the branch ${o.repo.branch}, from main\\.`));
    assert.match(seen.system, /Do not commit, push or change branches: when the task ends, the plugin commits what you changed\./);
    assert.match(seen.system, /Change nothing elsewhere, but in repo\//);
    assert.equal(seen.cwd_mode, 0o1777, "work/ is sticky: repo/ stays where it is");
    assert.match(seen.gitconfig, /\[safe\]\n\tdirectory = .*\/work\/repo\n/);
  });
});

test("a repository: a step that fails commits nothing; without a run, the branch is run-<step>; nothing changed, no commit", async () => {
  await withRepo(async ({ env, bare }) => {
    await assert.rejects(runStep(env, { prompt: fake({ edit: { "repo/a.txt": "x\n" }, subtype: "error_during_execution", errors: ["boom"] }), tools: ["Write"], repo: { name: "app" } }, undefined, never), /boom/);
    assert.deepEqual(branches(bare), ["main"], "nothing pushed");
    const none: any = await runStep(env, { prompt: fake({}), repo: { name: "app" } }, undefined, never);
    assert.match(none.output.repo.branch, /^agent\/run-[0-9a-f]{16}$/);
    assert.equal(none.output.repo.commit, undefined);
    assert.deepEqual(none.output.repo.files, []);
    assert.equal(none.output.repo.pushed, false);
    assert.match(none.output.repo.note, /nothing changed/);
    const ro = JSON.parse((await runStep(env, { prompt: fake({ env: true }), access: "read", repo: { name: "app" } }, undefined, never)).files[0].data.toString());
    assert.match(ro.system, /## Repository\n.*\nRead its files there: you cannot change them in this task\.\n/);
  });
});

test("a repository: what the preset forbids fails the node, and commits nothing", async () => {
  await withRepo(async ({ api, env, bare }) => {
    const before = api.requests.length;
    await assert.rejects(runStep(env, { prompt: fake({}), repo: { name: "app", branch: "agent/keep" } }, undefined, never), (e: Error) => e instanceof StepError && /branch agent\/keep is protected/.test(e.message));
    await assert.rejects(runStep(env, { prompt: fake({}), repo: { name: "app", branch: "main" } }, undefined, never), /branch main: a step commits under agent\//);
    await assert.rejects(runStep(env, { prompt: fake({}), repo: { name: "other" } }, undefined, never), /allowed values/);
    assert.equal(api.requests.length, before, "Claude Code did not start");
    await assert.rejects(runStep(env, { prompt: fake({ edit: { "repo/x.txt": "x", "repo/y.txt": "y" } }), tools: ["Write"], repo: { name: "app" } }, undefined, never), (e: Error) => e instanceof StepError && /2 files changed, at most 1: nothing committed/.test(e.message));
    assert.deepEqual(branches(bare), ["main"]);
  }, ", max_files: 1, protected: [agent/keep]");
  // A preset without repositories takes no repo.
  await withStep(async ({ env }) => {
    await assert.rejects(runStep(env, { prompt: "x", repo: { name: "app" } }, undefined, never), /additional properties/);
  });
});

test("gosidian's MCP: its server in --mcp-config, the token only in Claude Code's environment, its tools approved", async () => {
  const token = "gsd_mcp_TEST-CALL-TOKEN-42";
  const mcp = await mcpEndpoint(token);
  try {
    await withStep(async ({ api, env }) => {
      const meta = { "gosidian/mcp_url": mcp.url, "gosidian/mcp_token": token };
      const res = await runStep(env, { prompt: fake({ env: true }), tools: ["Read", "Write"], mcp: "read" }, undefined, never, 0, meta);
      const o: any = res.output;
      assert.deepEqual(o.mcp, { level: "read", url: mcp.url, status: "connected" });
      assert.ok(!JSON.stringify(o).includes(token), "the token is not in the output");
      assert.deepEqual([...new Set(mcp.auths)], [`Bearer ${token}`], "Claude Code reached gosidian with the token");
      const seen = JSON.parse(res.files[0].data.toString());
      assert.equal(seen.env.GOSIDIAN_MCP_TOKEN, token);
      assert.ok(!JSON.stringify(seen.argv).includes(token), "the token is not in Claude Code's arguments");
      assert.deepEqual(JSON.parse(seen.argv[seen.argv.indexOf("--mcp-config") + 1]), { mcpServers: { gosidian: { type: "http", url: mcp.url, headers: { Authorization: "Bearer ${GOSIDIAN_MCP_TOKEN}" } } } });
      assert.ok(seen.argv.includes("--strict-mcp-config"));
      assert.ok(seen.argv.includes("--restricted"));
      assert.equal(seen.argv[seen.argv.indexOf("--allowedTools") + 1], "Read,Write,mcp__gosidian__*");
      // none: no server, no token.
      const none = JSON.parse((await runStep(env, { prompt: fake({ env: true }), tools: ["Write"], mcp: "none" }, undefined, never, 0, meta)).files[0].data.toString());
      assert.equal(none.argv[none.argv.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
      assert.equal(none.env.GOSIDIAN_MCP_TOKEN, undefined);
      // Asked for, and the call carries none: the node fails before Claude Code.
      const before = api.requests.length;
      await assert.rejects(runStep(env, { prompt: fake({}), mcp: "read" }, undefined, never), /with\.mcp read: the call carries no gosidian\/mcp_url and gosidian\/mcp_token in its _meta/);
      await assert.rejects(runStep(env, { prompt: fake({}), mcp: "read" }, undefined, never, 0, { "gosidian/mcp_url": "file:///x", "gosidian/mcp_token": token }), /is not an http\(s\) address/);
      await assert.rejects(runStep(env, { prompt: fake({}), mcp: "read" }, undefined, never, 0, { "gosidian/mcp_url": mcp.url, "gosidian/mcp_token": "a b" }), (e: Error) => /is not a token/.test(e.message) && !e.message.includes("a b"));
      await assert.rejects(runStep(env, { prompt: fake({}), mcp: "write" }, undefined, never, 0, meta), /allowed values/, "the preset allows read only");
      assert.equal(api.requests.length, before);
    }, { extra: "mcp: [read]" });
    // A preset without mcp takes no mcp.
    await withStep(async ({ env }) => {
      await assert.rejects(runStep(env, { prompt: "x", mcp: "read" }, undefined, never), /additional properties/);
    });
  } finally {
    await mcp.close();
  }
});
