// waitOf: which of a provider's errors are limits that end by themselves
// or by their owner's hand, and when.
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitOf } from "../contract.ts";

test("a key's limit is a wait, with the time it resets", () => {
  const w = waitOf('403: {"message":"Key limit exceeded (weekly limit). $10.02 of $10.00 used; resets 2026-11-16T00:00:00.000Z.","code":403}');
  assert.deepEqual(w, { reason: "the provider answered 403", until: "2026-11-16T00:00:00.000Z" });
});

test("402, 429 and 529 are waits whatever they say", () => {
  assert.equal(waitOf("429 slow down")?.reason, "the provider answered 429");
  assert.equal(waitOf("something went wrong", 529)?.reason, "the provider answered 529");
  assert.equal(waitOf('{"error":{"code":402,"message":"pay"}}')?.reason, "the provider answered 402");
});

test("a status apart wins over the text", () => {
  assert.equal(waitOf("404 not found", 429)?.reason, "the provider answered 429");
  assert.equal(waitOf("429 in the text", 400), undefined);
});

test("403 and 503 only when the text names a limit", () => {
  assert.equal(waitOf("403: this model is not allowed for your key"), undefined);
  assert.equal(waitOf("503 service unavailable"), undefined);
  assert.ok(waitOf("503: the model is overloaded"));
  assert.ok(waitOf("You have reached your usage limit"));
});

test("other failures are no wait", () => {
  for (const t of ["400: invalid request", "401 no auth", "pi ended (1)", "500 internal error", "", "the model does not exist"]) {
    assert.equal(waitOf(t), undefined, t);
  }
});

test("a subscription's reset time reads", () => {
  const w = waitOf("429 the subscription has 16% of its session (5 hours) left, less than the preset's min_left_percent (20%): it resets at 2026-11-12T20:50:00.000Z");
  assert.equal(w?.until, "2026-11-12T20:50:00.000Z");
  assert.equal(waitOf("429 resets at some point")?.until, undefined);
});
