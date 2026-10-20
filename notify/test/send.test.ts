// The send node as gosidian sees it: the bearer, the manifest, the
// destinations only from the preset (an unknown name or an address
// refused, before anything goes), groups made into people, each one's
// channels, plain text and the cuts, a link and a note, the priorities, the
// require setting, the hourly caps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakes, headersOf, ok, preset, presetText, refused, startApp, textOf, until } from "./helpers.ts";
import { parsePreset } from "../src/preset.ts";

test("gosidian's view: bearer, health, manifest, tools", async () => {
  const f = await fakes();
  const t = await startApp(preset(f));
  try {
    assert.equal((await fetch(t.mcpURL, { method: "POST", body: "{}" })).status, 401);
    const health = await (await fetch(t.mcpURL.replace(/\/mcp$/, "/health"))).json();
    assert.deepEqual({ ...health, version: "-" }, { status: "ok", plugin: "notify", name: "notify-test", version: "-", channels: ["telegram", "ntfy", "email"], open_questions: 0, held: 0 });
    // The reply page's port: its own health, no MCP, nothing listed.
    assert.deepEqual(await (await fetch(`${t.pageURL}/health`)).json(), { status: "ok" });
    assert.equal((await fetch(`${t.pageURL}/mcp`)).status, 404);
    assert.equal((await fetch(`${t.pageURL}/`)).status, 404);
    assert.equal((await fetch(`${t.pageURL}/r/`)).status, 404);
    const c = await t.client();
    assert.deepEqual((await c.listTools()).tools.map((x) => x.name), ["gosidian_manifest", "send", "ask", "cancel"]);
    const man: any = (await c.callTool({ name: "gosidian_manifest", arguments: {} })).structuredContent;
    await c.close();
    assert.equal(man.name, "notify-test");
    assert.equal(man.gosidian, 1);
    assert.deepEqual(man.nodes.map((n: any) => n.name), ["send", "ask", "cancel"]);
    const u = (s: string) => new URL(s).host;
    assert.deepEqual(man.permissions, { files: true, network: [u(f.tg.url), u(f.ntfy.url), `127.0.0.1:${f.smtp.port}`, u(f.gs.url)] });
    const to = man.nodes[0].input_schema.properties.to.description;
    assert.match(to, /alice, bob, carol, dave, @ops, #team, #team\/agents, #team\/releases, #team\/<topic>, #alerts, #alerts\/errors/);
    assert.deepEqual(man.nodes[0].input_schema.properties.channels.items.enum, ["telegram", "ntfy", "email"]);
    assert.deepEqual(man.nodes[1].input_schema.required, ["to", "choices", "resume_url"]);
    // No address of a person in the manifest.
    assert.doesNotMatch(JSON.stringify(man), /example\.com|alice-topic|1001/);
  } finally {
    await t.close();
    await f.close();
  }
});

test("destinations only from the preset: an unknown name or an address is refused, nothing sent", async () => {
  const f = await fakes();
  const t = await startApp(preset(f));
  try {
    const no = async (to: unknown, why: RegExp) => assert.match(await refused(t, "send", { to, title: "x" }), why);
    await no("zed", /"zed" is not a person, a group \(@name\) or a room/);
    await no("alice@example.com", /"alice@example.com" is not a person/);
    await no("-1001234567890", /is not a person/);
    await no("https://evil.example/hook", /is not a person/);
    await no("@nobody", /"@nobody": no group nobody in the preset/);
    await no("#nowhere", /no room nowhere in the preset/);
    await no("#alerts/unknown", /the room alerts has no topic unknown/);
    await no("#team/a/b", /a topic's name holds no \/ or #/);
    await no(["alice", "zed", "#x"], /"zed" is not a person.*no room x/);
    await no("zed", /A node names the preset's destinations, never an address/);
    assert.match(await refused(t, "send", { to: "alice" }), /must match a schema in anyOf|must have required property/);
    assert.match(await refused(t, "send", { to: "alice", title: ` ${String.fromCharCode(0)} ` }), /a title or a text, and not empty once made plain/);
    assert.match(await refused(t, "send", { to: "alice", title: "x", chat_id: -100 }), /must NOT have additional properties/);
    assert.match(await refused(t, "send", { to: "alice", title: "x" }, null), /names no project/);
    // Nothing reached a channel.
    assert.equal(f.tg.of("sendMessage").length, 0);
    assert.equal(f.ntfy.messages.length, 0);
    assert.equal(f.smtp.mails.length, 0);
  } finally {
    await t.close();
    await f.close();
  }
});

test("send: groups made into people once, each one's channels, the output", async () => {
  const f = await fakes();
  const t = await startApp(preset(f));
  try {
    const o = await ok(t, "send", { to: ["@ops", "alice", "carol", "#team/agents"], title: "Build ok", text: "main is green" });
    assert.match(o.id, /^[a-z2-7]{16}$/);
    assert.equal(o.ok, true);
    const sent = o.sent.map((e: any) => `${e.to}/${e.channel}/${e.status}`).sort();
    assert.deepEqual(sent, [
      "#team/agents/ntfy/sent", "#team/agents/telegram/sent",
      "alice/email/sent", "alice/ntfy/sent", "alice/telegram/sent",
      "bob/email/sent", "bob/ntfy/sent", "bob/telegram/sent",
      "carol/telegram/sent",
    ]);
    assert.deepEqual(o.counts, { sent: 9, held: 0, grouped: 0, failed: 0 });
    const chats = f.tg.of("sendMessage").map((c) => [c.body.chat_id, c.body.message_thread_id ?? null]).sort();
    assert.deepEqual(chats, [[-1009, 15], [1001, null], [1002, null], [1003, null]]);
    assert.deepEqual(f.ntfy.messages.map((m) => m.topic).sort(), ["alice-topic", "bob-topic", "team-topic"]);
    // The room's topic on ntfy: the room's own, tagged.
    assert.deepEqual(f.ntfy.messages.find((m) => m.topic === "team-topic").tags, ["agents"]);
    await until("two mails", () => f.smtp.mails.length === 2);
    assert.deepEqual(f.smtp.mails.map((m) => m.to[0]).sort(), ["<alice@example.com>", "<bob@example.com>"]);

    // channels narrows them; a person with none of them: failed, the rest go.
    const n = await ok(t, "send", { to: ["alice", "dave"], title: "Solo Telegram", channels: ["telegram"] });
    assert.deepEqual(n.sent, [{ to: "alice", channel: "telegram", status: "sent" }, { to: "dave", channel: null, status: "failed", error: "dave has no channel of telegram in the preset" }]);
    assert.equal(n.ok, false);
    // The default require (any): it fails only when nothing went.
    assert.match(await refused(t, "send", { to: "dave", title: "x", channels: ["ntfy"] }), /^nothing went: dave: dave has no channel of ntfy in the preset/);
    assert.match(await refused(t, "send", { to: ["alice", "dave"], title: "x", channels: ["telegram"], require: "all" }), /not every channel went \(require: all\): dave/);
    // A room's topic, or the room itself: the group is always the preset's.
    await ok(t, "send", { to: "#team", title: "Generale" });
    const last = f.tg.of("sendMessage").at(-1)!.body;
    assert.equal(last.chat_id, -1009);
    assert.equal(last.message_thread_id, undefined);
    await ok(t, "send", { to: "#alerts/errors", title: "Errore" });
    assert.equal(f.ntfy.messages.at(-1).topic, "alerts-errors");
  } finally {
    await t.close();
    await f.close();
  }
});

test("plain text on every channel, the cuts, a link and a note, the priorities", async () => {
  const f = await fakes();
  const t = await startApp(preset(f, "limits: {title: 20, text: {telegram: 200, ntfy: 150, email: 300}}\n"));
  try {
    const text = `<b>grassetto</b> *md* [x](https://example.com)\r\n${String.fromCharCode(0x202e)}riga due\n${"è".repeat(400)}`;
    await ok(t, "send", { to: "alice", title: "Un titolo\nlungo, oltre il limite", text, link: "https://example.com/run/1", priority: "low" });
    const tg = f.tg.of("sendMessage")[0].body;
    assert.equal(tg.parse_mode, undefined);
    assert.equal(tg.disable_notification, true);
    assert.deepEqual(tg.link_preview_options, { is_disabled: true });
    assert.ok(tg.text.length <= 200, `${tg.text.length}`);
    assert.ok(tg.text.startsWith("Un titolo lungo, ol…\n\n<b>grassetto</b> *md* [x](https://example.com)\nriga due\nè"), tg.text);
    assert.ok(tg.text.endsWith("…\n\nhttps://example.com/run/1"), "the link stays whole");
    const nt = f.ntfy.messages[0];
    assert.equal(nt.markdown, undefined);
    assert.equal(nt.title, "Un titolo lungo, ol…");
    assert.equal(nt.priority, 2);
    assert.equal(nt.click, "https://example.com/run/1");
    assert.ok(Buffer.byteLength(nt.message) <= 150, `${Buffer.byteLength(nt.message)}`);
    assert.ok(nt.message.endsWith("https://example.com/run/1"));
    await until("the mail", () => f.smtp.mails.length === 1);
    const h = headersOf(f.smtp.mails[0]);
    assert.match(h["content-type"], /^text\/plain; charset=utf-8/);
    assert.equal(h["auto-submitted"], "auto-generated");
    assert.equal(h["x-priority"], undefined);
    const body = textOf(f.smtp.mails[0]);
    assert.ok(body.startsWith("<b>grassetto</b> *md*"), body);
    assert.ok(body.length <= 310);
    assert.ok(body.includes("https://example.com/run/1"));

    // High and urgent: ntfy's own priority, a label elsewhere.
    await ok(t, "send", { to: "alice", title: "Disco pieno", priority: "urgent" });
    assert.equal(f.tg.of("sendMessage")[1].body.text, "[URGENT] Disco pieno");
    assert.equal(f.tg.of("sendMessage")[1].body.disable_notification, undefined);
    assert.equal(f.ntfy.messages[1].priority, 5);
    await until("the second mail", () => f.smtp.mails.length === 2);
    assert.equal(headersOf(f.smtp.mails[1])["x-priority"], "1 (Highest)");
    assert.equal(headersOf(f.smtp.mails[1]).subject, "[URGENT] Disco pieno");

    // A note: its link in gosidian's web UI, relative to the project.
    await ok(t, "send", { to: "alice", title: "Nota", note: "tasks/r1 report", channels: ["ntfy"] });
    assert.equal(f.ntfy.messages[2].click, `${f.gs.url}/notes/demo/tasks/r1%20report.md`);
    await ok(t, "send", { to: "alice", title: "Nota", note: "demo/tasks/x.md", channels: ["ntfy"] });
    assert.equal(f.ntfy.messages[3].click, `${f.gs.url}/notes/demo/tasks/x.md`);
    const no = async (args: Record<string, unknown>, why: RegExp) => assert.match(await refused(t, "send", { to: "alice", title: "x", ...args }), why);
    await no({ note: "../other/secret" }, /a plain path inside the project/);
    await no({ link: "javascript:alert(1)" }, /with\.link: javascript: is not http\(s\)/);
    await no({ link: "https://user:pw@example.com/" }, /a link holds no credentials/);
    await no({ link: "https://example.com/", note: "a" }, /link or note, not both/);
    await no({ priority: "critical" }, /must be equal to one of the allowed values/);
  } finally {
    await t.close();
    await f.close();
  }
  // Without gosidian_url, a note has nowhere to point.
  const g = await fakes();
  const u = await startApp(parsePreset(presetText(g).replace(/gosidian_url: .*\n/, ""), "p", {}));
  try {
    assert.match(await refused(u, "send", { to: "alice", title: "x", note: "a" }), /the preset has no gosidian_url/);
  } finally {
    await u.close();
    await g.close();
  }
});

test("the hourly caps: a person's, a room's, a channel's; a failed send gives its count back", async () => {
  const f = await fakes();
  const t = await startApp(preset(f, "limits: {per_hour: {person: 2, room: 1, channel: 4}}\n"));
  try {
    const one = async (to: string) => (await ok(t, "send", { to, title: "x", channels: ["ntfy"] }).catch((e) => ({ error: String(e) }))) as any;
    assert.equal((await one("alice")).sent[0].status, "sent");
    assert.equal((await one("alice")).sent[0].status, "sent");
    assert.match((await one("alice")).error, /over the cap of 2 messages an hour for alice \(limits\.per_hour\.person\)/);
    assert.equal((await one("#team")).sent[0].status, "sent");
    assert.match((await one("#team/agents")).error, /over the cap of 1 messages an hour for the room #team \(limits\.per_hour\.room\)/);
    // A send that fails is not counted.
    f.ntfy.fail.push({ status: 400, error: "bad" });
    assert.match((await one("bob")).error, /ntfy answered 400: bad/);
    assert.equal((await one("bob")).sent[0].status, "sent");
    assert.match((await one("bob")).error, /over the cap of 4 messages an hour for ntfy \(limits\.per_hour\.channel\)/);
    // An hour later, room again.
    t.clock.now += 3600_001;
    assert.equal((await one("alice")).sent[0].status, "sent");
  } finally {
    await t.close();
    await f.close();
  }
});

test("a channel that fails: its error, the others go; once more on a busy server", async () => {
  const f = await fakes();
  const t = await startApp(preset(f));
  try {
    f.tg.fail.sendMessage = [{ code: 403, description: "Forbidden: bot was blocked by the user" }];
    const o = await ok(t, "send", { to: "alice", title: "x" });
    assert.deepEqual(o.sent.find((e: any) => e.channel === "telegram"), { to: "alice", channel: "telegram", status: "failed", error: "telegram sendMessage: 403 Forbidden: bot was blocked by the user" });
    assert.equal(o.sent.filter((e: any) => e.status === "sent").length, 2);
    // 429 with a short retry_after, a 502: tried again, and sent.
    f.tg.fail.sendMessage = [{ code: 429, description: "Too Many Requests: retry after 1", retry_after: 1 }];
    f.ntfy.fail.push({ status: 502, error: "bad gateway" });
    const r = await ok(t, "send", { to: "alice", title: "y", channels: ["telegram", "ntfy"] });
    assert.deepEqual(r.counts, { sent: 2, held: 0, grouped: 0, failed: 0 });
  } finally {
    await t.close();
    await f.close();
  }
});
