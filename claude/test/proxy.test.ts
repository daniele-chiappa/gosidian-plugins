// The proxy between Claude Code and the API: the step's key for the
// credential, the betas, the connection check, the paths it forwards, the
// budget, the usage and the effort it notes, and the token kept out of
// every log and answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProxy, MessageUsage, mergeBeta } from "../src/proxy.ts";
import { mockAPI, USAGE } from "./mock-api.ts";
import { TOKEN } from "./helpers.ts";

const total = USAGE.input_tokens + USAGE.cache_read_input_tokens + USAGE.cache_creation_input_tokens + USAGE.output_tokens;

async function setup(kind: "oauth" | "api_key" = "oauth") {
  const api = await mockAPI();
  const logs: string[] = [];
  const headers: Headers[] = [];
  const proxy = new AnthropicProxy({ baseUrl: api.url, kind, credential: TOKEN }, { log: (m, f) => logs.push(JSON.stringify({ m, ...f })), onHeaders: (h) => headers.push(h) });
  await proxy.listen();
  let used = 0;
  let left = 10_000;
  const seen: [string, string | null][] = [];
  const g = proxy.grant({ left: () => left - used, usage: (n) => (used += n), seen: (m, e) => seen.push([m, e]) });
  const call = (path: string, init: RequestInit & { key?: string } = {}) =>
    fetch(proxy.url + path, {
      method: init.method ?? "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(init.key !== undefined ? { "x-api-key": init.key } : { "x-api-key": g.key }), ...(init.headers as Record<string, string>) },
      body: init.body,
    });
  return {
    api, proxy, g, logs, headers, seen, call,
    used: () => used,
    setLeft: (n: number) => (left = n),
    close: async () => {
      await proxy.close();
      await api.close();
    },
  };
}

test("mergeBeta adds the OAuth beta once", () => {
  assert.equal(mergeBeta("claude-code-20250219, effort-2025-11-24", "oauth-2025-04-20"), "claude-code-20250219,effort-2025-11-24,oauth-2025-04-20");
  assert.equal(mergeBeta("oauth-2025-04-20", "oauth-2025-04-20"), "oauth-2025-04-20");
  assert.equal(mergeBeta(undefined, "oauth-2025-04-20"), "oauth-2025-04-20");
});

test("a subscription: the step's key becomes the token, the betas gain OAuth's, the answer streams back", async () => {
  const t = await setup("oauth");
  try {
    const r = await t.call("/v1/messages?beta=true", {
      headers: { "anthropic-beta": "claude-code-20250219,effort-2025-11-24", "x-claude-code-session-id": "s1" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", stream: true, output_config: { effort: "high" }, messages: [] }),
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type")!, /event-stream/);
    assert.equal(r.headers.get("anthropic-ratelimit-unified-5h-utilization"), "0.25", "Claude Code sees the limits too");
    const text = await r.text();
    assert.match(text, /"text":"ok"/);
    const up = t.api.requests[0];
    assert.equal(up.path, "/v1/messages");
    assert.equal(up.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(up.headers["x-api-key"], undefined, "the step's key does not go on");
    assert.equal(up.headers["anthropic-beta"], "claude-code-20250219,effort-2025-11-24,oauth-2025-04-20");
    assert.equal(up.headers["x-claude-code-session-id"], "s1");
    assert.equal(up.headers.host, new URL(t.api.url).host);
    assert.deepEqual(up.body.output_config, { effort: "high" }, "the body goes on as it is");
    assert.equal(t.used(), total, "the usage of the stream is counted");
    assert.deepEqual(t.seen, [["claude-sonnet-5-5", "high"]]);
    assert.equal(t.headers.length, 1, "the rate-limit headers are handed on");
    assert.equal(t.logs.filter((l) => l.includes("rate-limit headers")).length, 1);
    await (await t.call("/v1/messages", { body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }) })).text();
    assert.equal(t.used(), 2 * total, "the usage of a JSON answer is counted");
    assert.deepEqual(t.seen[1], ["claude-haiku-4-5", null], "a request without effort");
    assert.equal(t.logs.filter((l) => l.includes("rate-limit headers")).length, 1, "the names are logged once");
  } finally {
    await t.close();
  }
});

test("an API key goes as x-api-key, with no OAuth beta", async () => {
  const t = await setup("api_key");
  try {
    await (await t.call("/v1/messages", { headers: { "anthropic-beta": "claude-code-20250219" }, body: JSON.stringify({ model: "m", messages: [] }) })).text();
    const up = t.api.requests[0];
    assert.equal(up.headers["x-api-key"], TOKEN);
    assert.equal(up.headers.authorization, undefined);
    assert.equal(up.headers["anthropic-beta"], "claude-code-20250219");
  } finally {
    await t.close();
  }
});

test("a wrong, missing or revoked key gets 401; the connection check gets 200 without one", async () => {
  const t = await setup();
  try {
    for (const key of ["sk-wrong", ""]) {
      const r = await t.call("/v1/messages", { key, body: "{}" });
      assert.equal(r.status, 401);
      assert.equal((await r.json()).error.type, "authentication_error");
    }
    const bearer = await fetch(t.proxy.url + "/v1/models", { headers: { authorization: `Bearer ${t.g.key}` } });
    assert.equal(bearer.status, 200, "the step's key as a bearer works too");
    await bearer.text();
    for (const method of ["HEAD", "GET"]) {
      const hello = await fetch(t.proxy.url + "/api/hello", { method });
      assert.equal(hello.status, 200);
      await hello.text();
    }
    assert.equal(t.api.requests.filter((r) => r.path === "/api/hello").length, 0, "the check does not reach the API");
    t.g.revoke();
    assert.equal((await t.call("/v1/models", { method: "GET" })).status, 401);
  } finally {
    await t.close();
  }
});

test("only messages and models are forwarded; a spent budget refuses a message", async () => {
  const t = await setup();
  try {
    for (const [method, path] of [["GET", "/api/oauth/usage"], ["POST", "/api/oauth/claude_cli/create_api_key"], ["GET", "/v1/files"], ["DELETE", "/v1/messages"]]) {
      const r = await t.call(path, { method, ...(method === "POST" ? { body: "{}" } : {}) });
      assert.equal(r.status, 404, `${method} ${path}`);
      await r.text();
    }
    assert.equal(t.api.requests.length, 0);
    assert.ok(t.logs.some((l) => l.includes('"path":"/api/oauth/usage"')), "a refused path is logged");
    const models = await t.call("/v1/models?limit=10", { method: "GET" });
    assert.equal((await models.json()).data[0].id, "claude-haiku-5-5");
    const count = await t.call("/v1/messages/count_tokens", { body: JSON.stringify({ model: "m", messages: [] }) });
    assert.equal(count.status, 404, "forwarded: the fake API has no count_tokens");
    await count.text();
    t.setLeft(0);
    const r = await t.call("/v1/messages", { body: JSON.stringify({ model: "m", messages: [] }) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error.message, /token budget/);
    assert.equal(t.api.requests.filter((x) => x.path === "/v1/messages").length, 0);
  } finally {
    await t.close();
  }
});

test("call: the plugin's own requests carry the credential", async () => {
  const t = await setup();
  try {
    const r = await t.proxy.call("GET", "/api/oauth/usage");
    assert.equal(r.status, 403);
    await r.text();
    const up = t.api.requests[0];
    assert.equal(up.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(up.headers["anthropic-beta"], "oauth-2025-04-20");
  } finally {
    await t.close();
  }
});

test("the token is in no log and no answer", async () => {
  const t = await setup();
  const seen: string[] = [];
  try {
    for (const [path, init] of [
      ["/v1/messages", { body: JSON.stringify({ model: "m", stream: true, messages: [] }) }],
      ["/v1/messages", { key: "sk-wrong", body: "{}" }],
      ["/api/oauth/profile", { method: "GET" }],
      ["/v1/messages", { body: "not json" }],
    ] as const) {
      const r = await t.call(path, init as any);
      seen.push(JSON.stringify([...r.headers]), await r.text());
    }
    await t.proxy.close();
    // A request to a closed upstream fails: its error is logged too.
    const dead = new AnthropicProxy({ baseUrl: "http://127.0.0.1:1", kind: "oauth", credential: TOKEN }, { log: (m, f) => t.logs.push(JSON.stringify({ m, ...f })) });
    await dead.listen();
    const g = dead.grant({ left: () => 1, usage: () => {} });
    const r = await fetch(dead.url + "/v1/messages", { method: "POST", headers: { "x-api-key": g.key }, body: "{}" });
    assert.equal(r.status, 502);
    seen.push(await r.text());
    await dead.close();
    assert.ok(t.logs.length >= 3);
    for (const s of [...t.logs, ...seen]) assert.ok(!s.includes(TOKEN), `the token leaked: ${s.slice(0, 200)}`);
  } finally {
    await t.api.close();
  }
});

test("MessageUsage adds message_start's and message_delta's usage of a stream", () => {
  const u = new MessageUsage("text/event-stream; charset=utf-8");
  const enc = new TextEncoder();
  u.push(enc.encode('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":200,"cache_creation_input_tokens":3,"output_tokens":1}}}\n\nevent: ping\ndata: {"type":"ping"}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"out'));
  u.push(enc.encode('put_tokens":40}}\n\n'));
  assert.equal(u.total(), 10 + 200 + 3 + 40);
  const j = new MessageUsage("application/json");
  j.push(enc.encode(JSON.stringify({ usage: { input_tokens: 5, output_tokens: 6 } })));
  assert.equal(j.total(), 11);
});
