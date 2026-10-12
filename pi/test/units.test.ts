// The pieces without pi: the event stream, the JSON of an answer, the
// preset and its node schema, the proxy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Lines, RunState } from "../src/events.ts";
import { check, extractJSON } from "../src/schema.ts";
import { nodeSchema, parsePreset, seconds } from "../src/preset.ts";
import { LLMProxy } from "../src/proxy.ts";
import { safeName } from "../src/files.ts";
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
  assert.equal(p.thinking, "off");
  const s: any = nodeSchema(p);
  assert.deepEqual(s.properties.model.enum, ["a", "b"]);
  assert.deepEqual(s.properties.tools.items.enum, ["read", "ls", "write"]);
  assert.equal(s.properties.max_turns.maximum, 20);
  assert.equal(seconds("10m", "x"), 600);
  for (const [bad, why] of [
    ["name: Bad\nendpoint: {base_url: http://x}\nmodels: [{id: m}]", /pattern/],
    ["name: x\nendpoint: {base_url: http://x}\nmodels: [{id: m}]\ndefault_model: z", /default_model z/],
    ["name: x\nendpoint: {base_url: http://x}\nmodels: [{id: m}]\ntools: {allowed: [read], default: [bash]}", /default tool bash/],
    ["name: x\nendpoint: {base_url: http://x}\nmodels: [{id: m}]\ntools: {allowed: [curl]}", /allowed values/],
    ["name: x\nendpoint: {base_url: http://x}\nmodels: [{id: m}]\nlimits: {default: {max_turns: 50}, max: {max_turns: 10}}", /over limits.max.max_turns/],
    ["name: x\nendpoint: {base_url: http://x}\nmodels: [{id: m}, {id: n, name: m}]", /model name m twice/],
  ] as const) {
    assert.throws(() => parsePreset(bad), why);
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
