// The secrets never leave the plugin: the channels' credentials, the
// resume key, the tokens of the reply page are in no node's output (its
// structured content, its text, its _meta), no error, no log line, no
// health answer, no manifest; the state on the volume holds the tokens as
// hashes and no credential. The channels here fail on purpose, with errors
// that would carry them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fakes, KEY, preset, presetText, raw, resumeURL, SECRETS, startApp, until } from "./helpers.ts";
import { parsePreset } from "../src/preset.ts";

test("no secret in outputs, errors, logs, health, manifest or state", async () => {
  const f = await fakes();
  const t = await startApp(preset(f));
  const results: string[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await t.call(name, args);
    results.push(JSON.stringify(r));
    return r;
  };
  const pageTokens: string[] = [];
  try {
    // Errors that carry the credentials back: ntfy's and Telegram's.
    f.ntfy.fail.push({ status: 401, error: `the token ${SECRETS.ntfy_token} is not valid` });
    f.tg.fail.sendMessage = [{ code: 401, description: `Unauthorized: ${SECRETS.telegram_token} at /bot${SECRETS.telegram_token}/sendMessage` }];
    const r = await call("send", { to: "alice", title: "x" });
    const out = JSON.stringify(r);
    assert.match(out, /ntfy answered 401: the token \[secret\] is not valid/);
    assert.match(out, /telegram sendMessage: 401 Unauthorized: \[secret\] at \/bot\[secret\]\/sendMessage/);
    // A question, answered: the resume key and the page's tokens.
    const q = await call("ask", { to: ["alice", "bob"], title: "ok?", choices: ["sì", "no"], resume_url: resumeURL(f.gs.url) });
    assert.ok(!q.isError, JSON.stringify(q));
    for (const m of f.ntfy.messages) pageTokens.push(/\/r\/([A-Za-z0-9_-]{22})/.exec(m.click ?? "")?.[1] ?? "");
    assert.equal(pageTokens.filter(Boolean).length, 2);
    await raw(t.pageURL, `/r/${pageTokens[0]}`, "POST", "choice=0");
    await until("the resume", () => f.gs.resumes.length === 1);
    // A refused one that names a key, and gosidian that refuses the answer.
    await call("ask", { to: "alice", title: "x", choices: ["a", "b"], resume_url: `https://evil.example/api/v1/runs/r1/resume?key=${KEY}` });
    f.gs.answers.push(400);
    await call("ask", { to: "alice", title: "y", choices: ["a", "b"], resume_url: resumeURL(f.gs.url) });
    const tok = /\/r\/([A-Za-z0-9_-]{22})/.exec(f.ntfy.messages.at(-1).click)![1];
    pageTokens.push(tok);
    await raw(t.pageURL, `/r/${tok}`, "POST", "choice=1");
    await until("the refusal logged", () => t.logs.some((l) => l.startsWith("gosidian refused the answer")));
    await call("cancel", { id: "a".repeat(16) });
    results.push(JSON.stringify(await (await t.client()).callTool({ name: "gosidian_manifest", arguments: {} })));
    results.push(await (await fetch(t.mcpURL.replace(/\/mcp$/, "/health"))).text());
    results.push((await raw(t.pageURL, "/health")).body);
  } finally {
    await t.stop();
  }
  const state = fs.readFileSync(path.join(t.preset.store_dir, "state.json"), "utf8");
  const everything = [...results, ...t.logs].join("\n");
  for (const [what, v] of [
    ["the bot's token", SECRETS.telegram_token],
    ["the bot token's secret part", SECRETS.telegram_token.split(":")[1]],
    ["ntfy's token", SECRETS.ntfy_token],
    ["the SMTP password", SECRETS.smtp_password],
    ["the resume key", KEY],
    ...pageTokens.map((p, i) => [`page token ${i}`, p]),
  ] as const) {
    assert.ok(!everything.includes(v), `${what} leaked: ${everything.split("\n").find((l) => l.includes(v))}`);
    if (what !== "the resume key") assert.ok(!state.includes(v), `${what} in the state`);
  }
  // The resume key is in the state only where it must be: the address the
  // answer goes to.
  const s = JSON.parse(state);
  const where = JSON.stringify(Object.values<any>(s.questions).map(({ resume, ...rest }) => rest)) + JSON.stringify({ ...s, questions: {} });
  assert.ok(!where.includes(KEY));
  assert.equal((fs.statSync(path.join(t.preset.store_dir, "state.json")).mode & 0o777).toString(8), "600");
  fs.rmSync(t.preset.store_dir, { recursive: true, force: true });
  await f.close();
});

test("a channel that cannot be reached says why without its address", async () => {
  const f = await fakes();
  // A port nothing listens on any more.
  const s = net.createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  const t = await startApp(parsePreset(presetText(f).replace(`api_url: "${f.tg.url}"`, `api_url: "http://127.0.0.1:${port}"`).replace(`server: "${f.ntfy.url}"`, `server: "http://127.0.0.1:${port}"`), "p", {}));
  try {
    const r = await t.call("send", { to: "alice", title: "x", channels: ["telegram", "ntfy"] });
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, "nothing went: alice/telegram: telegram sendMessage: ECONNREFUSED; alice/ntfy: ntfy: ECONNREFUSED");
    assert.ok(!t.logs.join("\n").includes(SECRETS.telegram_token));
    assert.ok(!t.logs.join("\n").includes("/bot"));
  } finally {
    await t.close();
    await f.close();
  }
});
