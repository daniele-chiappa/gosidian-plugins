// A step with the real pi against a fake endpoint: the tools, the files in
// and out, the JSON of the answer, the limits, the repository, gosidian's
// MCP, the cleanup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mockLLM, type Reply } from "./mock-llm.ts";
import { mockMCP } from "./mock-mcp.ts";
import { fileServer, git, origin, preset, stepDirs, testEnv } from "./helpers.ts";
import { PI_VERSION, runStep, StepError, VERSION } from "../src/run.ts";

const never = new AbortController().signal;

async function withStep(replies: Reply[] | ((n: number, body: any) => Reply), fn: (t: { llm: Awaited<ReturnType<typeof mockLLM>>; env: Awaited<ReturnType<typeof testEnv>>["env"] }) => Promise<void>, extra = "") {
  const llm = await mockLLM(replies);
  const te = await testEnv(preset(llm.url, extra));
  try {
    await fn({ llm, env: te.env });
    assert.deepEqual(stepDirs(te.env), [], "the step's folder is removed");
  } finally {
    await te.close();
    await llm.close();
  }
}

test("a step reads its files, writes one, and answers; the proxy carries sampling and routing", async () => {
  const files = await fileServer({ "procedura.md": "# Controllo\nPasso 1", "note.txt": "ciao" });
  try {
    await withStep([
      { toolCalls: [{ name: "ls", args: { path: "in" } }], usage: { prompt: 1000, completion: 50 } },
      { toolCalls: [{ name: "write", args: { path: "out/riassunto.md", content: "# Riassunto\nUn passo." } }], usage: { prompt: 1200, completion: 60 } },
      { text: "Fatto: un passo.", usage: { prompt: 1300, completion: 10 } },
    ], async ({ llm, env }) => {
      const res = await runStep(env, { prompt: "Riassumi la procedura", files: files.refs(), tools: ["read", "ls", "write"] }, undefined, never);
      const o: any = res.output;
      assert.equal(o.text, "Fatto: un passo.");
      assert.deepEqual(o.model, { name: "a", id: "vendor/model-a", endpoint: new URL(llm.url).host });
      assert.equal(o.stop, "done");
      assert.equal(o.turns, 3);
      assert.deepEqual(o.tools, { ls: 1, write: 1 });
      assert.equal(o.usage.total_tokens, 3620);
      // $2 and $10 per million tokens: pi's sum at the preset's prices;
      // usage.cost (deprecated) is the same.
      assert.ok(Math.abs(o.cost - (3500 * 2 + 120 * 10) / 1e6) < 1e-9, String(o.cost));
      assert.equal(o.cost_source, "agent");
      assert.equal(o.usage.cost, o.cost);
      assert.deepEqual(o.executor, { plugin: "gosidian-pi", version: VERSION, agent: "pi", agent_version: PI_VERSION });
      assert.match(PI_VERSION, /^\d+\.\d+\.\d+/);
      assert.equal(o.denials, undefined);
      assert.equal(o.repo, undefined);
      assert.equal(o.mcp, undefined);
      assert.deepEqual(res.files.map((f) => [f.name, f.mime, f.data.toString()]), [["riassunto.md", "text/markdown", "# Riassunto\nUn passo."]]);
      const first = llm.requests[0];
      assert.equal(first.model, "vendor/model-a");
      assert.equal(first.temperature, 0.2);
      assert.deepEqual(first.provider, { data_collection: "deny" });
      assert.equal(first.max_completion_tokens, 800);
      const sys = JSON.stringify(first.messages[0]);
      assert.match(sys, /procedura\.md, note\.txt/);
      assert.match(sys, /Rispondi in italiano/);
      assert.deepEqual(first.tools.map((t: any) => t.function.name).sort(), ["ls", "read", "write"]);
      // ls ran in the workspace: it listed in/ and out/, nothing of the plugin's.
      assert.match(JSON.stringify(llm.requests[1].messages.at(-1)), /note\.txt|procedura\.md/);
    });
  } finally {
    await files.close();
  }
});

test("the answer as JSON, after one turn that corrects it", async () => {
  await withStep([{ text: "Sono tre passi." }, { text: '```json\n{"passi": 3}\n```' }], async ({ llm, env }) => {
    const schema = { type: "object", required: ["passi"], properties: { passi: { type: "integer" } } };
    const res = await runStep(env, { prompt: "Quanti passi?", schema, model: "b", temperature: 0.7 }, undefined, never);
    assert.deepEqual((res.output as any).json, { passi: 3 });
    // Model b has no prices.
    assert.equal((res.output as any).cost, 0);
    assert.equal((res.output as any).cost_source, "none");
    assert.equal(llm.requests.length, 2);
    assert.equal(llm.requests[0].temperature, 0.7);
    // model b's body replaces the endpoint's provider block
    assert.deepEqual(llm.requests[0].provider, { order: ["first"] });
    assert.match(JSON.stringify(llm.requests[0].messages[0]), /JSON Schema/);
    const second = JSON.stringify(llm.requests[1].messages);
    assert.match(second, /Sono tre passi/, "the correction continues the session");
    assert.match(second, /not the JSON the task asks for/);
  });
});

test("inline_files puts the text files in the prompt", async () => {
  const files = await fileServer({ "a.md": "# Procedura A\nminimo 2600 rpm", "b.bin": "x\u0000y" });
  try {
    await withStep([{ text: "2600" }], async ({ llm, env }) => {
      const res = await runStep(env, { prompt: "Il minimo?", files: files.refs(), inline_files: true }, undefined, never);
      assert.equal((res.output as any).text, "2600");
      const user = JSON.stringify(llm.requests[0].messages.at(-1));
      assert.match(user, /<file name=\\"in\/a.md\\">/);
      assert.match(user, /minimo 2600 rpm/);
      assert.match(user, /in in\/ for your tools: b.bin/);
    });
  } finally {
    await files.close();
  }
});

test("an answer that stays no JSON fails the step", async () => {
  await withStep([{ text: "no" }], async ({ env }) => {
    await assert.rejects(runStep(env, { prompt: "x", json: true, json_retries: 0 }, undefined, never), (e: Error) => e instanceof StepError && /not the JSON asked for, after 1 tries/.test(e.message));
  });
});

test("the limits stop the agent: turns, tokens (the run's too), time, cancel", async () => {
  const loop = () => ({ toolCalls: [{ name: "ls", args: { path: "." } }], usage: { prompt: 300, completion: 10 } });
  await withStep(loop, async ({ env }) => {
    await assert.rejects(runStep(env, { prompt: "x", max_turns: 2 }, undefined, never), /stopped at max_turns \(2 turns\)/);
  });
  await withStep(loop, async ({ env }) => {
    await assert.rejects(runStep(env, { prompt: "x" }, 700, never), /stopped at max_tokens/);
  });
  await withStep([{ text: "x" }], async ({ llm, env }) => {
    await assert.rejects(runStep(env, { prompt: "x" }, 0, never), /no language-model tokens left/);
    assert.equal(llm.requests.length, 0);
  });
  await withStep([{ text: "tardi", delayMs: 8000 }], async ({ env }) => {
    const t0 = Date.now();
    await assert.rejects(runStep(env, { prompt: "x", max_seconds: 1 }, undefined, never), /stopped at max_seconds/);
    assert.ok(Date.now() - t0 < 6000);
  });
  await withStep([{ text: "tardi", delayMs: 8000 }], async ({ env }) => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    await assert.rejects(runStep(env, { prompt: "x" }, undefined, ac.signal), /canceled/);
  });
});

test("settings outside the preset, and files that are not what gosidian said, fail before pi", async () => {
  const files = await fileServer({ "a.txt": "aaa" });
  try {
    await withStep([{ text: "x" }], async ({ llm, env }) => {
      await assert.rejects(runStep(env, { prompt: "x", model: "z" }, undefined, never), /allowed values/);
      await assert.rejects(runStep(env, { prompt: "x", tools: ["bash"] }, undefined, never), /allowed values/);
      await assert.rejects(runStep(env, { prompt: "x", max_turns: 99 }, undefined, never), /must be <= 20/);
      await assert.rejects(runStep(env, { prompt: "x", schema: { type: "nope" } }, undefined, never), /not a JSON Schema/);
      await assert.rejects(runStep(env, { prompt: "x", files: ["in/a.txt"] }, undefined, never), /by reference/);
      await assert.rejects(runStep(env, { prompt: "x", files: files.refs({ "a.txt": { sha256: "0".repeat(64) } }) }, undefined, never), /SHA-256 differs/);
      assert.equal(llm.requests.length, 0);
    });
  } finally {
    await files.close();
  }
});

test("an endpoint that refuses fails the step with its reason", async () => {
  await withStep([{ status: 400 }, { status: 400 }, { status: 400 }], async ({ env }) => {
    await assert.rejects(runStep(env, { prompt: "x" }, undefined, never), /the agent failed/);
  });
});

const META = { "gosidian/project": "demo", "gosidian/run": "r-7" };

test("a step on a repository: the agent edits repo/, the plugin commits on the step's branch and pushes", async () => {
  const bare = origin();
  await withStep([
    { toolCalls: [{ name: "write", args: { path: "repo/b.txt", content: "nuovo\n" } }] },
    { toolCalls: [{ name: "write", args: { path: "repo/a.txt", content: "one\ntwo\nthree\n" } }] },
    { text: "Fatto: b.txt aggiunto, a.txt allungato." },
  ], async ({ llm, env }) => {
    const res = await runStep(env, { prompt: "Aggiungi b.txt\ne allunga a.txt", access: "edit", repo: { name: "app" } }, undefined, never, 0, META);
    const r: any = (res.output as any).repo;
    assert.equal(r.name, "app");
    assert.equal(r.base, "main");
    assert.match(r.branch, /^agent\/r-7-[0-9a-f]{16}$/);
    assert.equal(r.changed, 2);
    assert.equal(r.insertions, 2);
    assert.equal(r.pushed, true);
    assert.match(r.commit, /^[0-9a-f]{40}$/);
    assert.equal(git(bare, "rev-parse", r.branch).trim(), r.commit);
    assert.equal(git(bare, "log", "-1", "--format=%B", r.branch), "pi-test: Aggiungi b.txt\n\nFatto: b.txt aggiunto, a.txt allungato.\n\ngosidian: project demo, run r-7\n\n");
    assert.equal(git(bare, "show", `${r.branch}:b.txt`), "nuovo\n");
    assert.equal(git(bare, "rev-list", "--count", "main").trim(), "1", "main moved");
    const sys = JSON.stringify(llm.requests[0].messages[0]);
    assert.match(sys, /The repository app is checked out in the folder repo\/ of your working directory, on the branch agent\/r-7-[0-9a-f]{16}, from main/);
    assert.match(sys, /Do not commit, push or change branches/);
  }, `repos:\n  - name: app\n    url: ${bare}`);
});

test("a step on a repository that fails commits nothing; a branch the preset protects fails before pi", async () => {
  const bare = origin();
  const extra = `repos:\n  - name: app\n    url: ${bare}\n    protected: [release]`;
  await withStep([
    { toolCalls: [{ name: "write", args: { path: "repo/b.txt", content: "x\n" } }] },
    { text: "non è JSON" },
  ], async ({ env }) => {
    await assert.rejects(runStep(env, { prompt: "x", access: "edit", repo: { name: "app" }, json: true, json_retries: 0 }, undefined, never, 0, META), /not the JSON asked for/);
    assert.equal(git(bare, "branch", "--list", "agent/*").trim(), "");
  }, extra);
  await withStep([{ text: "x" }], async ({ llm, env }) => {
    await assert.rejects(runStep(env, { prompt: "x", repo: { name: "app", branch: "release" } }, undefined, never, 0, META), (e: Error) => e instanceof StepError && /branch release: a step commits under agent\/|protected/.test(e.message));
    await assert.rejects(runStep(env, { prompt: "x", repo: { name: "app", branch: "agent/ok", base: "nope" } }, undefined, never, 0, META), (e: Error) => e instanceof StepError && /repository app/.test(e.message));
    assert.equal(llm.requests.length, 0);
  }, extra);
});

test("gosidian's MCP: pi reaches it with the call's token as a bearer, and calls its tools", async () => {
  const mcp = await mockMCP();
  const token = "gsd_run_token-0123456789";
  try {
    await withStep((_n, body) => {
      const done = (body.messages ?? []).some((m: any) => m.role === "tool");
      return done ? { text: "La nota dice hello." } : { toolCalls: [{ name: "mcp__gosidian__memory_get", args: { path: "a.md" } }] };
    }, async ({ llm, env }) => {
      const res = await runStep(env, { prompt: "Leggi la nota a.md", mcp: "read" }, undefined, never, 0, { ...META, "gosidian/mcp_url": mcp.url, "gosidian/mcp_token": token });
      const o: any = res.output;
      assert.equal(o.text, "La nota dice hello.");
      assert.deepEqual(o.tools, { mcp__gosidian__memory_get: 1 });
      assert.deepEqual(o.mcp, { level: "read", url: mcp.url });
      assert.ok(!JSON.stringify(o).includes(token), "the token is in the output");
      assert.ok(mcp.seen.length > 0 && mcp.seen.every((r) => r.auth === `Bearer ${token}`), JSON.stringify(mcp.seen));
      const methods = mcp.seen.map((r) => r.method);
      // The plugin's check, then pi's session.
      assert.equal(methods.filter((m) => m === "initialize").length, 2, methods.join());
      assert.ok(methods.includes("tools/list"));
      assert.deepEqual(mcp.seen.filter((r) => r.method === "tools/call").map((r) => r.tool), ["memory_get"]);
      assert.deepEqual(llm.requests[0].tools.map((t: any) => t.function.name).sort(), ["ls", "mcp__gosidian__memory_get", "read"]);
      assert.match(JSON.stringify(llm.requests[1].messages), /the note a.md: hello/);
    }, "mcp: [read]");
    // Without mcp in the call, pi has no MCP.
    mcp.seen.length = 0;
    await withStep([{ text: "ok" }], async ({ llm, env }) => {
      await runStep(env, { prompt: "x" }, undefined, never, 0, { ...META, "gosidian/mcp_url": mcp.url, "gosidian/mcp_token": token });
      assert.deepEqual(mcp.seen, []);
      assert.deepEqual(llm.requests[0].tools.map((t: any) => t.function.name).sort(), ["ls", "read"]);
    }, "mcp: [read]");
  } finally {
    await mcp.close();
  }
});

test("gosidian's MCP that refuses the token, or a call without it, fails the step before pi", async () => {
  const mcp = await mockMCP({ status: 401 });
  try {
    await withStep([{ text: "x" }], async ({ llm, env }) => {
      await assert.rejects(runStep(env, { prompt: "x", mcp: "write" }, undefined, never, 0, { "gosidian/mcp_url": mcp.url, "gosidian/mcp_token": "t" }), /gosidian's MCP at http:\/\/127.0.0.1:\d+\/mcp answered 401/);
      await assert.rejects(runStep(env, { prompt: "x", mcp: "read" }, undefined, never, 0, {}), /the call carries no gosidian\/mcp_url and gosidian\/mcp_token/);
      await assert.rejects(runStep(env, { prompt: "x", mcp: "read" }, undefined, never, 0, { "gosidian/mcp_url": "http://127.0.0.1:1/mcp", "gosidian/mcp_token": "t" }), /gosidian's MCP at http:\/\/127.0.0.1:1\/mcp cannot be reached/);
      assert.equal(llm.requests.length, 0);
    }, "mcp: [read, write]");
  } finally {
    await mcp.close();
  }
});
