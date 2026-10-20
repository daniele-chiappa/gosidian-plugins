// The preset: its defaults, durations and sizes, the types merged with the
// safe defaults, the environment's addresses, and what it refuses.
import { test } from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";
import { bytes, DEFAULT_TYPES, hostOf, parsePreset, seconds } from "../src/preset.ts";

test("defaults", () => {
  const p = parsePreset("name: preview\n", "p", {});
  assert.equal(p.public_url, "");
  assert.equal(p.store_dir, "/var/lib/gosidian-preview");
  assert.deepEqual(p.limits, { ttl: 7 * 86400, max_ttl: 30 * 86400, max_files: 2000, max_bytes: 100 << 20, max_total_bytes: 2 * 2 ** 30, max_ratio: 100, max_depth: 16 });
  assert.equal(p.connect, "open");
  assert.deepEqual(p.playwright, { ws_endpoint: "", timeout: 60, max_steps: 50 });
  assert.deepEqual(p.types, DEFAULT_TYPES);
  assert.equal(p.types.html, "text/html; charset=utf-8");
  assert.equal(p.types.webmanifest, "application/manifest+json; charset=utf-8");
});

test("every field, and the environment's addresses", () => {
  const p = parsePreset(`
name: anteprime
description: Le anteprime
public_url: https://preview.example.com/base/
store_dir: /data/previews/
limits: {ttl: 3d, max_ttl: 14d, max_files: 500, max_bytes: 50MiB, max_total_bytes: 1GiB, max_ratio: 50, max_depth: 8}
types: {pdf: application/pdf, ico: null}
connect: self
playwright: {ws_endpoint: "ws://pw:3000/", timeout: 2m, max_steps: 20}
`, "p", { PREVIEW_PUBLIC_URL: "http://ignored", PREVIEW_PLAYWRIGHT_WS: "ws://ignored:1/" });
  assert.equal(p.public_url, "https://preview.example.com/base");
  assert.equal(p.store_dir, "/data/previews");
  assert.deepEqual(p.limits, { ttl: 3 * 86400, max_ttl: 14 * 86400, max_files: 500, max_bytes: 50 << 20, max_total_bytes: 1 << 30, max_ratio: 50, max_depth: 8 });
  assert.equal(p.types.pdf, "application/pdf");
  assert.equal(p.types.ico, undefined);
  assert.equal(p.connect, "self");
  assert.deepEqual(p.playwright, { ws_endpoint: "ws://pw:3000/", timeout: 120, max_steps: 20 });
  const q = parsePreset("name: x\n", "p", { PREVIEW_PUBLIC_URL: "http://preview.lan:8085/", PREVIEW_PLAYWRIGHT_WS: "ws://preview.lan:4000/" });
  assert.equal(q.public_url, "http://preview.lan:8085");
  assert.equal(q.playwright.ws_endpoint, "ws://preview.lan:4000/");
  assert.equal(hostOf(q.playwright.ws_endpoint), "preview.lan:4000");
  assert.equal(hostOf("wss://pw.example.com/x"), "pw.example.com:443");
});

test("durations and sizes", () => {
  assert.equal(seconds("90s", "x"), 90);
  assert.equal(seconds("12h", "x"), 43200);
  assert.equal(seconds(3600, "x"), 3600);
  assert.throws(() => seconds("3w", "x"), /not a duration/);
  assert.throws(() => seconds("0d", "x"), /zero/);
  assert.equal(bytes("512KiB", "x"), 512 << 10);
  assert.equal(bytes("2GiB", "x"), 2 * 2 ** 30);
  assert.equal(bytes("10MB", "x"), 10e6);
  assert.equal(bytes(1234, "x"), 1234);
  assert.throws(() => bytes("lots", "x"), /not a size/);
});

test("what a preset may not be", () => {
  const bad = (y: string, why: RegExp, env: Record<string, string> = {}) => assert.throws(() => parsePreset(y, "p", env), why);
  bad("description: x\n", /must have required property 'name'/);
  bad("name: Bad Name\n", /must match pattern/);
  bad("name: x\nextra: 1\n", /must NOT have additional properties/);
  bad("name: x\nlimits: {ttl: 40d}\n", /limits.ttl 3456000 s is over limits.max_ttl/);
  bad("name: x\nlimits: {max_bytes: 4GiB}\n", /max_bytes is over limits.max_total_bytes/);
  bad("name: x\npublic_url: ftp://x\n", /not http\(s\)/);
  bad("name: x\npublic_url: http://x/?a=1\n", /a query/);
  bad("name: x\n", /PREVIEW_PUBLIC_URL: "nope" is not an address/, { PREVIEW_PUBLIC_URL: "nope" });
  bad("name: x\nplaywright: {ws_endpoint: http://pw:3000}\n", /not ws\(s\)/);
  bad("name: x\nconnect: closed\n", /must be equal to one of the allowed values/);
  bad("name: x\ntypes: {php: text/html; drop table}\n", /must match pattern/);
  bad("name: x\ntypes: {html: null, htm: null}\n", /no page to serve/);
  bad("name: x\ntypes: {.js: text/javascript}\n", /must match pattern/);
});

test("the example preset, presets/preview.yaml, is a valid one", () => {
  const p = parsePreset(fs.readFileSync(new URL("../presets/preview.yaml", import.meta.url), "utf8"), "presets/preview.yaml", {});
  assert.equal(p.name, "preview");
  assert.equal(p.types.pdf, "application/pdf");
  assert.equal(p.playwright.ws_endpoint, "ws://preview.lan:4000/");
  assert.deepEqual(p.limits, parsePreset("name: x\n", "p", {}).limits);
});
