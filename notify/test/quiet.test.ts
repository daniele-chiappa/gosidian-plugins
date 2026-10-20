// Quiet hours and the digest, the grouping of a key: in the preset's time
// zone, low and normal held and sent as one digest a channel when the quiet
// hours end, high and urgent through; the held messages survive a restart;
// the same key within group_window counted, and its count sent at the
// window's end.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { at, fakes, ok, presetText, refused, startApp, until } from "./helpers.ts";
import { parsePreset } from "../src/preset.ts";

const quiet = (f: Awaited<ReturnType<typeof fakes>>, extra = "", tz = "Europe/Rome") =>
  parsePreset(
    presetText(f, extra)
      .replace("alice: {telegram: 1001, ntfy: alice-topic, email: alice@example.com}", 'alice: {telegram: 1001, ntfy: alice-topic, email: alice@example.com, quiet: "22:00-07:00"}')
      .replace("time_zone: Europe/Rome", tz ? `time_zone: ${tz}` : ""),
    "p",
    {},
  );

test("quiet hours: low and normal held, high and urgent through; one digest a channel at their end, after a restart too", async () => {
  const f = await fakes();
  const p = quiet(f);
  let t = await startApp(p, { now: at("23:00"), keepStore: true });
  try {
    const n = await ok(t, "send", { to: "alice", title: "Run fallita", text: "pipelines/import: step 3", link: "https://example.com/r/1" });
    assert.deepEqual(n.sent.map((e: any) => `${e.channel}/${e.status}`), ["telegram/held", "ntfy/held", "email/held"]);
    assert.deepEqual(n.counts, { sent: 0, held: 3, grouped: 0, failed: 0 });
    t.clock.now = at("23:10");
    await ok(t, "send", { to: "alice", title: "Backup ok", priority: "low", channels: ["telegram"] });
    t.clock.now = at("23:20");
    await ok(t, "send", { to: "alice", title: "Disco al 90%", key: "disk" });
    t.clock.now = at("23:25");
    const again = await ok(t, "send", { to: "alice", title: "Disco al 91%", key: "disk" });
    assert.equal(again.sent[0].status, "held");
    // Others are not quiet; high and urgent go through hers.
    assert.equal((await ok(t, "send", { to: "bob", title: "per bob" })).counts.sent, 3);
    assert.equal((await ok(t, "send", { to: "alice", title: "Produzione giù", priority: "urgent" })).counts.sent, 3);
    assert.equal((await ok(t, "send", { to: "alice", title: "Certificato in scadenza", priority: "high", channels: ["ntfy"] })).counts.sent, 1);
    const tgBefore = f.tg.of("sendMessage").filter((c) => c.body.chat_id === 1001).length;
    assert.equal(tgBefore, 1, "only the urgent one");
    assert.equal(t.app.env.store.data.held.length, 3);

    // Still quiet: nothing released. The held survive a restart.
    t.clock.now = at("06:59", "2026-10-21");
    await t.app.tick();
    await t.stop();
    const state = JSON.parse(fs.readFileSync(path.join(p.store_dir, "state.json"), "utf8"));
    assert.equal(state.held.length, 3);
    assert.equal((fs.statSync(path.join(p.store_dir, "state.json")).mode & 0o777).toString(8), "600");
    t = await startApp(p, { now: at("07:00", "2026-10-21") });
    await t.app.tick();
    assert.equal(t.app.env.store.data.held.length, 0);
    const digests = f.tg.of("sendMessage").filter((c) => c.body.chat_id === 1001).slice(1);
    assert.equal(digests.length, 1, "one digest on Telegram");
    const d = digests[0].body.text;
    assert.ok(d.startsWith("3 notifications while quiet\n\n23:00 Run fallita\npipelines/import: step 3\nhttps://example.com/r/1\n\n23:10 Backup ok\n\n23:20 Disco al 91% (+1)"), d);
    assert.equal(digests[0].body.disable_notification, undefined, "a digest with a normal one is not silent");
    // ntfy and email had two of the three (the low one was Telegram's only).
    const nd = f.ntfy.messages.filter((m) => m.topic === "alice-topic").at(-1);
    assert.equal(nd.title, "2 notifications while quiet");
    assert.match(nd.message, /^23:00 Run fallita\n.*\n\n23:20 Disco al 91% \(\+1\)$/s);
    await until("the digest mail", () => f.smtp.mails.some((m) => /2 notifications while quiet/.test(m.data)));
    // Once only.
    await t.app.tick();
    assert.equal(f.tg.of("sendMessage").filter((c) => c.body.chat_id === 1001).length, 2);
  } finally {
    await t.close();
    await f.close();
  }
});

test("quiet hours of a room, past limits.held the oldest dropped, the default time zone UTC", async () => {
  const f = await fakes();
  const p = parsePreset(presetText(f, "limits: {held: 2}\n").replace("    ntfy: team-topic\n", '    ntfy: team-topic\n    quiet: "12:00-14:00"\n'), "p", {});
  const t = await startApp(p, { now: at("13:00") });
  try {
    for (const n of [1, 2, 3]) await ok(t, "send", { to: "#team/agents", title: `n${n}`, channels: ["telegram"] });
    assert.equal(t.app.env.store.data.held.length, 2);
    t.clock.now = at("14:00");
    await t.app.tick();
    const d = f.tg.of("sendMessage").at(-1)!.body;
    assert.equal(d.chat_id, -1009);
    assert.equal(d.message_thread_id, 15, "the digest goes to the topic");
    assert.equal(d.text, "3 notifications while quiet\n\n13:00 n2\n\n13:00 n3\n\n… and 1 more");
  } finally {
    await t.close();
    await f.close();
  }
  // No time_zone: UTC. 23:30 in Rome is 21:30 UTC, not quiet.
  const g = await fakes();
  const u = await startApp(quiet(g, "", ""), { now: at("23:30") });
  try {
    assert.equal(u.preset.time_zone, "UTC");
    assert.equal((await ok(u, "send", { to: "alice", title: "x", channels: ["ntfy"] })).sent[0].status, "sent");
    u.clock.now = Date.parse("2026-10-20T22:30:00Z");
    assert.equal((await ok(u, "send", { to: "alice", title: "y", channels: ["ntfy"] })).sent[0].status, "held");
  } finally {
    await u.close();
    await g.close();
  }
});

test("grouping: the same key within group_window counted, its count sent at the window's end", async () => {
  const f = await fakes();
  const t = await startApp(parsePreset(presetText(f, "limits: {group_window: 5m}\n"), "p", {}), { now: at("10:00") });
  try {
    const first = await ok(t, "send", { to: "alice", title: "Disco pieno", text: "92%", key: "disk", channels: ["telegram", "ntfy"] });
    assert.equal(first.counts.sent, 2);
    for (const [m, pct] of [["10:01", 93], ["10:02", 94], ["10:03", 95]] as const) {
      t.clock.now = at(m);
      const g = await ok(t, "send", { to: "alice", title: "Disco pieno", text: `${pct}%`, key: "disk", channels: ["telegram", "ntfy"] });
      assert.deepEqual(g.sent.map((e: any) => e.status), ["grouped", "grouped"]);
    }
    // Another destination, another project: not the same group.
    assert.equal((await ok(t, "send", { to: "bob", title: "Disco pieno", key: "disk", channels: ["ntfy"] })).counts.sent, 1);
    assert.equal((await ok(t, "send", { to: "alice", title: "Disco pieno", key: "disk", channels: ["ntfy"] }, "other")).counts.sent, 1);
    const sentToAlice = () => f.tg.of("sendMessage").filter((c) => c.body.chat_id === 1001);
    assert.equal(sentToAlice().length, 1);
    t.clock.now = at("10:04");
    await t.app.tick();
    assert.equal(sentToAlice().length, 1, "the window is still open");
    t.clock.now = at("10:05");
    await t.app.tick();
    assert.equal(sentToAlice().length, 2);
    assert.equal(sentToAlice()[1].body.text, "Disco pieno (+3)\n\n95%");
    assert.equal(f.ntfy.messages.filter((m) => m.topic === "alice-topic").at(-1).title, "Disco pieno (+3)");
    // A window with no repeat ends with nothing; after it, the key goes again.
    t.clock.now = at("10:06");
    assert.equal((await ok(t, "send", { to: "alice", title: "Disco pieno", key: "disk", channels: ["telegram"] })).counts.sent, 1);
    t.clock.now = at("10:12");
    await t.app.tick();
    assert.equal(sentToAlice().length, 3);
    assert.deepEqual(t.app.env.store.data.groups, {});
  } finally {
    await t.close();
    await f.close();
  }
});

test("grouping: sends of the same key at the same time, one goes; a send that fails opens no window", async () => {
  const f = await fakes();
  const t = await startApp(parsePreset(presetText(f), "p", {}), { now: at("10:00") });
  try {
    const all = await Promise.all([1, 2, 3, 4].map((i) => ok(t, "send", { to: "carol", title: `Disco ${i}`, key: "disk" })));
    assert.deepEqual(all.map((o) => o.sent[0].status).sort(), ["grouped", "grouped", "grouped", "sent"]);
    assert.equal(f.tg.of("sendMessage").length, 1);
    f.tg.fail.sendMessage = [{ code: 400, description: "Bad Request: chat not found" }];
    assert.match(await refused(t, "send", { to: "carol", title: "Altro", key: "other" }), /chat not found/);
    assert.deepEqual(Object.values(t.app.env.store.data.groups).map((g) => [g.key, g.dest]), [["disk", "carol"]]);
    assert.equal((await ok(t, "send", { to: "carol", title: "Altro", key: "other" })).sent[0].status, "sent");
  } finally {
    await t.close();
    await f.close();
  }
});
