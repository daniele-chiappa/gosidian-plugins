// A step with a fake Claude Code (fake-claude.ts) behind the real proxy and
// a fake API: the files in and out, the environment it gets, the answer as
// JSON, the effort, the limits, the subscription, the cleanup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mockAPI, type MockOptions } from "./mock-api.ts";
import { fake, fileServer, preset, stepDirs, testEnv, TOKEN } from "./helpers.ts";
import { runStep, StepError, type Env } from "../src/run.ts";

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
      assert.equal(o.model, "claude-haiku-5-5", "the alias as this version resolves it");
      assert.deepEqual(o.effort, { requested: "high", applied: "high" });
      assert.equal(o.subtype, "success");
      assert.equal(o.turns, 1);
      assert.deepEqual(o.usage, { input: 100, output: 5, cache_read: 1000, cache_write: 50, total_tokens: 1155 });
      assert.equal(o.cost, 0.0123);
      assert.deepEqual(o.denials, []);
      assert.deepEqual(o.tools, ["Read", "Write"]);
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
    await assert.rejects(runStep(env, { prompt: fake({ subtype: "error_max_budget_usd" }), max_budget_usd: 0.5 }, undefined, never), /stopped at max_budget_usd \(\$0\.5\)/);
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
    assert.equal(o.model, "claude-haiku-4-5-20251001");
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
