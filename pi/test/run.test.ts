// A step with the real pi against a fake endpoint: the tools, the files in
// and out, the JSON of the answer, the limits, the cleanup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mockLLM, type Reply } from "./mock-llm.ts";
import { fileServer, preset, stepDirs, testEnv } from "./helpers.ts";
import { runStep, StepError } from "../src/run.ts";

const never = new AbortController().signal;

async function withStep(replies: Reply[] | ((n: number, body: any) => Reply), fn: (t: { llm: Awaited<ReturnType<typeof mockLLM>>; env: Awaited<ReturnType<typeof testEnv>>["env"] }) => Promise<void>) {
  const llm = await mockLLM(replies);
  const te = await testEnv(preset(llm.url));
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
      assert.equal(o.model, "a");
      assert.equal(o.stop, "done");
      assert.equal(o.turns, 3);
      assert.deepEqual(o.tools, { ls: 1, write: 1 });
      assert.equal(o.usage.total_tokens, 3620);
      // $2 and $10 per million tokens
      assert.ok(Math.abs(o.usage.cost - (3500 * 2 + 120 * 10) / 1e6) < 1e-9, String(o.usage.cost));
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
