// Telegram against a fake Bot API: a person's chat, a room's topics, the
// topics the bot makes (auto_topics: once, a clean name, kept on the
// volume, past max_auto_topics to General, made again when deleted), the
// group always the preset's; getUpdates, its offset kept, the ids of who
// writes to the bot logged and nothing of their text, a second consumer
// said in the log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakes, ok, preset, presetText, refused, startApp, until } from "./helpers.ts";
import { parsePreset } from "../src/preset.ts";

test("a person's chat, a room's topics, the group the preset's", async () => {
  const f = await fakes();
  const t = await startApp(preset(f));
  try {
    await ok(t, "send", { to: ["carol", "#team/Releases", "#team"], title: "v1.2.0" });
    const calls = f.tg.of("sendMessage").map((c) => [c.body.chat_id, c.body.message_thread_id ?? null, c.body.text]).sort();
    assert.deepEqual(calls, [[-1009, null, "v1.2.0"], [-1009, 12, "v1.2.0"], [1003, null, "v1.2.0"]]);
    // A topic name is matched without case; the output says it as the preset does.
    const o = await ok(t, "send", { to: "#team/AGENTS", title: "x", channels: ["telegram"] });
    assert.equal(o.sent[0].to, "#team/agents");
    assert.equal(f.tg.of("sendMessage").at(-1)!.body.message_thread_id, 15);
    // A topic of the room's ntfy only: Telegram's General, named in the text.
    const q = await startApp(parsePreset(presetText(f).replace("    ntfy: team-topic\n", "    ntfy: {topic: team-topic, topics: {builds: team-builds}}\n").replace("auto_topics: true", "auto_topics: false"), "p", {}));
    try {
      await ok(q, "send", { to: "#team/builds", title: "build" });
      assert.deepEqual([f.tg.of("sendMessage").at(-1)!.body.message_thread_id, f.tg.of("sendMessage").at(-1)!.body.text], [undefined, "[builds] build"]);
      assert.equal(f.ntfy.messages.at(-1).topic, "team-builds");
      assert.match(await refused(q, "send", { to: "#team/errors", title: "x" }), /the room team has no topic errors/);
      assert.equal(f.tg.of("createForumTopic").length, 0);
    } finally {
      await q.close();
    }
  } finally {
    await t.close();
    await f.close();
  }
});

test("auto_topics: made once at first use, a clean name, kept after a restart; past max_auto_topics to General; made again when deleted", async () => {
  const f = await fakes();
  const p = preset(f);
  let t = await startApp(p, { keepStore: true });
  try {
    // Two sends at once to a new topic: one createForumTopic.
    const name = `  Errori   ${"x".repeat(140)}  `;
    const [a, b] = await Promise.all([
      ok(t, "send", { to: `#team/errori`, title: "e1", channels: ["telegram"] }),
      ok(t, "send", { to: `#team/Errori`, title: "e2", channels: ["telegram"] }),
    ]);
    assert.equal(a.counts.sent + b.counts.sent, 2);
    // Whichever came first names it.
    assert.deepEqual(f.tg.of("createForumTopic").map((c) => [c.body.chat_id, c.body.name.toLowerCase()]), [[-1009, "errori"]]);
    const thread = f.tg.of("sendMessage").at(-1)!.body.message_thread_id;
    assert.equal(thread, 500);
    // A name too long, with spaces around: refused, not cut; one with spaces inside is made clean.
    assert.match(await refused(t, "send", { to: `#team/${name}`, title: "x" }), /at most 128 characters/);
    await ok(t, "send", { to: "#team/  release   notes ", title: "r", channels: ["telegram"] });
    assert.equal(f.tg.of("createForumTopic").at(-1)!.body.name, "release notes");
    // Kept on the volume: a restart makes none again.
    await t.stop();
    t = await startApp(p, { keepStore: true });
    await ok(t, "send", { to: "#team/errori", title: "e3", channels: ["telegram"] });
    assert.equal(f.tg.of("createForumTopic").length, 2);
    assert.equal(f.tg.of("sendMessage").at(-1)!.body.message_thread_id, 500);
    // max_auto_topics (3): the fourth goes to General, named.
    await ok(t, "send", { to: "#team/terzo", title: "t", channels: ["telegram"] });
    await ok(t, "send", { to: "#team/quarto", title: "q", channels: ["telegram"] });
    assert.equal(f.tg.of("createForumTopic").length, 3);
    const last = f.tg.of("sendMessage").at(-1)!.body;
    assert.deepEqual([last.message_thread_id, last.text], [undefined, "[quarto] q"]);
    assert.ok(t.logs.some((l) => l.startsWith("telegram: the room has as many topics made by the bot as max_auto_topics")));
    // A topic deleted in the group: made again, once.
    f.tg.fail.sendMessage = [{ code: 400, description: "Bad Request: message thread not found" }];
    const again = await ok(t, "send", { to: "#team/errori", title: "e4", channels: ["telegram"] });
    assert.equal(again.counts.sent, 1);
    assert.equal(f.tg.of("createForumTopic").at(-1)!.body.name.toLowerCase(), "errori");
    assert.equal(f.tg.of("sendMessage").at(-1)!.body.message_thread_id, 503);
    // The preset's own topics are never made again.
    f.tg.fail.sendMessage = [{ code: 400, description: "Bad Request: message thread not found" }];
    const fixed = await ok(t, "send", { to: ["#team/agents", "carol"], title: "a", channels: ["telegram"] });
    assert.equal(fixed.counts.failed, 1);
    assert.equal(f.tg.of("createForumTopic").length, 4);
  } finally {
    await t.close();
    await f.close();
  }
});

test("getUpdates: long polling from the offset kept, who writes logged by id only, a second consumer said", async () => {
  const f = await fakes();
  const p = preset(f);
  let t = await startApp(p, { keepStore: true });
  try {
    await until("the first getUpdates", () => f.tg.of("getUpdates").length >= 1);
    const first = f.tg.of("getUpdates")[0].body;
    assert.equal(first.offset, undefined);
    assert.equal(first.timeout, 1);
    assert.deepEqual(first.allowed_updates, ["callback_query", "message", "my_chat_member"]);
    f.tg.push({ message: { message_id: 1, from: { id: 777, is_bot: false, first_name: "Eve", username: "eve" }, chat: { id: 777, type: "private" }, text: "my private words" } });
    f.tg.push({ my_chat_member: { chat: { id: -1009, type: "supergroup", title: "Team" }, from: { id: 1001 }, new_chat_member: { status: "administrator" } } });
    await until("both logged", () => t.logs.filter((l) => l.startsWith("telegram: ")).length >= 2);
    const lines = t.logs.filter((l) => l.startsWith("telegram: "));
    assert.match(lines[0], /^telegram: a message to the bot \{"user_id":777,"username":"eve","chat_id":777,"chat_type":"private","chat_title":null,"thread_id":null\}$/);
    assert.match(lines[1], /"chat_id":-1009,"chat_type":"supergroup","chat_title":"Team".*"status":"administrator"/);
    assert.ok(!t.logs.join("\n").includes("my private words"));
    await until("the offset", () => t.app.env.store.data.telegram_offset === 3);
    await until("a getUpdates from 3", () => f.tg.of("getUpdates").some((c) => c.body.offset === 3));
    // A restart goes on from the offset kept.
    await t.stop();
    const n = f.tg.of("getUpdates").length;
    t = await startApp(p, { keepStore: true });
    await until("a getUpdates after the restart", () => f.tg.of("getUpdates").length > n);
    assert.equal(f.tg.of("getUpdates")[n].body.offset, 3);
    // Another consumer of the same bot: Telegram answers 409, the log says so.
    await t.stop();
    f.tg.fail.getUpdates = [{ code: 409, description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running" }];
    t = await startApp(p);
    await until("the conflict logged", () => t.logs.some((l) => l.startsWith("telegram: another consumer takes this bot's updates")));
  } finally {
    await t.close();
    await f.close();
  }
});

test("poll: false takes no updates; a question then has the reply page's link on Telegram", async () => {
  const f = await fakes();
  const t = await startApp(parsePreset(presetText(f).replace("poll_timeout: 1", "poll: false"), "p", {}));
  try {
    const o = await ok(t, "ask", { to: "carol", title: "Approvi?", choices: ["sì", "no"], resume_url: `${f.gs.url}/api/v1/runs/r1/resume?key=k` });
    assert.deepEqual(o.can_answer, ["carol"]);
    const m = f.tg.of("sendMessage")[0].body;
    assert.equal(m.reply_markup, undefined);
    assert.match(m.text, /^Approvi\?\n\nAnswer: http:\/\/127\.0\.0\.1:\d+\/r\/[A-Za-z0-9_-]{22}$/);
    assert.equal(f.tg.of("getUpdates").length, 0);
  } finally {
    await t.close();
    await f.close();
  }
});
