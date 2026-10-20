// The ask node and the answers: the reply page (GET shows, only POST
// decides; its headers), a token per person and question kept as a hash,
// single use, expired with the wait, another person's; Telegram's buttons,
// a press counted only from the people allowed; the POST to resume_url,
// tried again while the run does not wait; the second answer; cancel; who
// can answer, and the resume_url that is gosidian's only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { at, fakes, headersOf, KEY, ok, preset, presetText, raw, refused, resumeURL, startApp, textOf, until, words } from "./helpers.ts";
import { parsePreset } from "../src/preset.ts";
import { hashToken } from "../src/store.ts";

const tokenOf = (s: string) => /\/r\/([A-Za-z0-9_-]{22})/.exec(s)?.[1] ?? "";

test("the reply page: GET shows, POST decides once; the answer goes to resume_url", async () => {
  const f = await fakes();
  const t = await startApp(preset(f));
  try {
    const o = await ok(t, "ask", { to: ["alice", "bob"], title: "La PR è pronta", text: "3 file, i test passano", link: "https://example.com/pr/7", choices: ["approva", "rifiuta"], resume_url: resumeURL(f.gs.url) });
    assert.match(o.id, /^[a-z2-7]{16}$/);
    assert.deepEqual(o.approvers, ["alice", "bob"]);
    assert.deepEqual(o.can_answer, ["alice", "bob"]);
    assert.equal(Date.parse(o.expires_at) - t.clock.now, 86400_000);
    // ntfy: the action Answer; email: the line; the same token for a person, another for each.
    const na = f.ntfy.messages.find((m) => m.topic === "alice-topic");
    const ta = tokenOf(na.click);
    assert.ok(ta);
    assert.deepEqual(na.actions, [{ action: "view", label: "Answer", url: `${t.preset.public_url}/r/${ta}`, clear: true }, { action: "view", label: "Open the link", url: "https://example.com/pr/7" }]);
    await until("two mails", () => f.smtp.mails.length === 2);
    const mailA = f.smtp.mails.find((m) => m.to[0] === "<alice@example.com>")!;
    assert.equal(tokenOf(textOf(mailA)), ta);
    assert.match(textOf(mailA), /approva \/ rifiuta/);
    const tb = tokenOf(f.ntfy.messages.find((m) => m.topic === "bob-topic").click);
    assert.ok(tb && tb !== ta);
    // Telegram: the buttons, in each person's chat.
    const tg = f.tg.of("sendMessage").map((c) => c.body);
    assert.deepEqual(tg.map((m) => m.chat_id).sort(), [1001, 1002]);
    assert.deepEqual(tg[0].reply_markup, { inline_keyboard: [[{ text: "approva", callback_data: `a:${o.id}:0` }, { text: "rifiuta", callback_data: `a:${o.id}:1` }]] });
    // The tokens are kept as their hashes only.
    const state = fs.readFileSync(path.join(t.preset.store_dir, "state.json"), "utf8");
    assert.ok(!state.includes(ta) && !state.includes(tb));
    assert.ok(state.includes(hashToken(ta)));

    // GET: the question, who answers, the buttons; nothing decided.
    const g = await raw(t.pageURL, `/r/${ta}`);
    assert.equal(g.status, 200);
    assert.match(g.body, /<h1>La PR è pronta<\/h1><p class="text">3 file, i test passano<\/p><p><a href="https:\/\/example.com\/pr\/7" rel="noreferrer noopener" target="_blank">Open the link<\/a><\/p><p class="who">Answering as alice<\/p><form method="post"><button type="submit" name="choice" value="0" class="first">approva<\/button><button type="submit" name="choice" value="1">rifiuta<\/button><\/form>/);
    assert.match(g.headers["content-security-policy"] as string, /^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'; img-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'$/);
    assert.equal(g.headers["cache-control"], "no-store");
    assert.equal(g.headers["referrer-policy"], "no-referrer");
    assert.equal(g.headers["x-robots-tag"], "noindex, nofollow, noarchive");
    assert.equal(g.headers["x-frame-options"], "DENY");
    assert.match(g.body, /<meta name="robots" content="noindex, nofollow">/);
    assert.doesNotMatch(g.body, /<script/);
    assert.equal((await raw(t.pageURL, `/r/${ta}`, "HEAD")).status, 200);
    assert.equal((await raw(t.pageURL, "/robots.txt")).body, "User-agent: *\nDisallow: /\n");
    assert.equal(f.gs.resumes.length, 0, "a GET decides nothing");
    assert.equal(t.app.env.store.data.questions[o.id].status, "open");

    // A POST of no choice, of a choice that is not there: the page again.
    assert.equal((await raw(t.pageURL, `/r/${ta}`, "POST", "choice=7")).status, 400);
    assert.equal((await raw(t.pageURL, `/r/${ta}`, "POST", "x=1")).status, 400);
    assert.equal((await raw(t.pageURL, `/r/${ta}`, "POST", '{"choice":0}', { "content-type": "application/json" })).status, 400);
    assert.equal((await raw(t.pageURL, `/r/${ta}`, "PUT", "choice=0")).status, 405);
    // bob's token answers as bob.
    const pb = await raw(t.pageURL, `/r/${tb}`, "POST", "choice=1");
    assert.equal(pb.status, 200);
    assert.match(pb.body, /<p class="status">Recorded: rifiuta\. Thank you\.<\/p>/);
    await until("the resume", () => f.gs.resumes.length === 1);
    const r = f.gs.resumes[0];
    assert.deepEqual({ ...r, body: { ...r.body, at: "-" } }, { run: "r1", key: KEY, step: null, body: { choice: "rifiuta", choices: { approva: false, rifiuta: true }, by: "bob", channel: "page", at: "-" } });
    assert.equal(r.body.at, new Date(t.clock.now).toISOString());
    // alice's answer after: already decided, by bob; nothing more to gosidian.
    const pa = await raw(t.pageURL, `/r/${ta}`, "POST", "choice=0");
    assert.equal(pa.status, 409);
    assert.match(pa.body, /Already decided by bob: rifiuta\./);
    assert.doesNotMatch(pa.body, /<form/);
    // bob's token again: single use.
    assert.equal((await raw(t.pageURL, `/r/${tb}`, "POST", "choice=0")).status, 409);
    assert.match((await raw(t.pageURL, `/r/${ta}`)).body, /Already decided by bob/);
    // The Telegram buttons became the outcome.
    await until("the buttons edited", () => f.tg.of("editMessageReplyMarkup").length === 2);
    assert.deepEqual(f.tg.of("editMessageReplyMarkup")[0].body.reply_markup, { inline_keyboard: [[{ text: "rifiuta: bob", callback_data: `d:${o.id}` }]] });
    await new Promise((ok) => setTimeout(ok, 100));
    assert.equal(f.gs.resumes.length, 1);
    // A token that is not one: the same 404 as one forgotten.
    for (const p of ["/r/AAAAAAAAAAAAAAAAAAAAAA", "/r/short", `/r/${ta}x`, `/r/${ta}/x`, "/r/..%2fstate.json"]) {
      const x = await raw(t.pageURL, p);
      assert.equal(x.status, 404, p);
      assert.match(x.body, /This link is not valid, or it has expired\./);
    }
  } finally {
    await t.close();
    await f.close();
  }
});

test("Telegram's buttons in a room: only the approvers count; the others get an alert", async () => {
  const f = await fakes();
  const t = await startApp(preset(f));
  try {
    const o = await ok(t, "ask", { to: "#team/agents", approvers: ["alice"], title: "Merge?", choices: ["sì", "no"], resume_url: resumeURL(f.gs.url) });
    assert.deepEqual(o.can_answer, ["alice"]);
    assert.deepEqual(o.sent.map((e: any) => `${e.channel}/${e.status}`), ["telegram/sent", "ntfy/sent"]);
    const m = f.tg.of("sendMessage")[0];
    assert.equal(m.body.message_thread_id, 15);
    // The room's ntfy topic: the question, no token of anyone's.
    const n = f.ntfy.messages[0];
    assert.equal(n.click, undefined);
    assert.equal(n.actions, undefined);
    const ref = { chat: -1009, message_id: 100 };
    // bob is a person of the preset, not an approver; 999 is no one.
    const answer = (id: string) => until(`the answer to ${id}`, () => f.tg.of("answerCallbackQuery").some((c) => c.body.callback_query_id === id)).then(() => f.tg.of("answerCallbackQuery").find((c) => c.body.callback_query_id === id)!.body);
    const b = f.tg.press(1002, ref, `a:${o.id}:0`);
    assert.deepEqual(await answer(b), { callback_query_id: b, text: "You cannot answer this question.", show_alert: true });
    const x = f.tg.press(999, ref, `a:${o.id}:1`);
    assert.deepEqual(await answer(x), { callback_query_id: x, text: "You cannot answer this question.", show_alert: true });
    // A button's data for a question not of this message, or made up: not found.
    const y = f.tg.press(1001, { chat: -1009, message_id: 4242 }, `a:${o.id}:0`);
    assert.equal((await answer(y)).text, "This link is not valid, or it has expired.");
    assert.equal(t.app.env.store.data.questions[o.id].status, "open");
    assert.ok(t.logs.some((l) => l.startsWith("telegram: a press by someone the question does not allow") && l.includes('"user_id":1002')));
    // alice's press decides.
    const a = f.tg.press(1001, ref, `a:${o.id}:0`);
    assert.deepEqual(await answer(a), { callback_query_id: a, text: "Recorded: sì. Thank you.", show_alert: false });
    await until("the resume", () => f.gs.resumes.length === 1);
    assert.deepEqual({ ...f.gs.resumes[0].body, at: "-" }, { choice: "sì", choices: { "sì": true, no: false }, by: "alice", channel: "telegram", at: "-" });
    await until("the outcome", () => f.tg.of("editMessageReplyMarkup").length === 1);
    assert.deepEqual(f.tg.of("editMessageReplyMarkup")[0].body, { chat_id: -1009, message_id: 100, reply_markup: { inline_keyboard: [[{ text: "sì: alice", callback_data: `d:${o.id}` }]] } });
    // A second press, of the old buttons or of the outcome: already decided.
    const a2 = f.tg.press(1001, ref, `a:${o.id}:1`);
    assert.deepEqual(await answer(a2), { callback_query_id: a2, text: "Already decided by alice: sì.", show_alert: true });
    const d = f.tg.press(1002, ref, `d:${o.id}`);
    assert.equal((await answer(d)).text, "Already decided by alice: sì.");
    assert.equal(f.gs.resumes.length, 1);
  } finally {
    await t.close();
    await f.close();
  }
});

test("expiry: the page says expired, the buttons too; a decision after is refused", async () => {
  const f = await fakes();
  const t = await startApp(preset(f, "limits: {expires: 1h, max_expires: 1d}\n"));
  try {
    const no = async (args: Record<string, unknown>, why: RegExp) => assert.match(await refused(t, "ask", { to: "alice", title: "x", choices: ["a", "b"], resume_url: resumeURL(f.gs.url), ...args }), why);
    await no({ expires: "2d" }, /with\.expires 2d: more than the preset's 1d/);
    await no({ expires: "soon" }, /not a duration/);
    await no({ choices: ["a"] }, /must NOT have fewer than 2 items/);
    await no({ choices: ["a", "b", "c", "d", "e"] }, /must NOT have more than 4 items/);
    await no({ choices: ["a", "a"] }, /must NOT have duplicate items/);
    await no({ choices: ["a", ` ${String.fromCharCode(0)} `] }, /with\.choices: each one plain, not empty/);
    const o = await ok(t, "ask", { to: "alice", title: "Rilascio?", choices: ["sì", "no"], resume_url: resumeURL(f.gs.url), expires: "30m" });
    assert.equal(Date.parse(o.expires_at) - t.clock.now, 1800_000);
    const tok = tokenOf(f.ntfy.messages[0].click);
    t.clock.now += 1800_000;
    const g = await raw(t.pageURL, `/r/${tok}`);
    assert.equal(g.status, 410);
    assert.match(g.body, /This question has expired\./);
    assert.equal((await raw(t.pageURL, `/r/${tok}`, "POST", "choice=0")).status, 410);
    await until("the buttons say so", () => f.tg.of("editMessageReplyMarkup").length === 1);
    assert.equal(f.tg.of("editMessageReplyMarkup")[0].body.reply_markup.inline_keyboard[0][0].text, "Expired");
    const p = f.tg.press(1001, { chat: 1001, message_id: 100 }, `a:${o.id}:0`);
    await until("the press answered", () => f.tg.of("answerCallbackQuery").some((c) => c.body.callback_query_id === p));
    assert.equal(f.tg.of("answerCallbackQuery").at(-1)!.body.text, "This question has expired.");
    assert.equal(f.gs.resumes.length, 0);
    // A day after it closed, it is forgotten: its link is as any other.
    t.clock.now += 86400_000;
    await t.app.tick();
    assert.equal(t.app.env.store.data.questions[o.id], undefined);
    assert.equal((await raw(t.pageURL, `/r/${tok}`)).status, 404);
  } finally {
    await t.close();
    await f.close();
  }
});

test("cancel withdraws a question of the project only: links dead, buttons say so", async () => {
  const f = await fakes();
  const t = await startApp(preset(f));
  try {
    const o = await ok(t, "ask", { to: "alice", title: "Deploy?", choices: ["sì", "no"], resume_url: resumeURL(f.gs.url) });
    const tok = tokenOf(f.ntfy.messages[0].click);
    assert.deepEqual(await ok(t, "cancel", { id: o.id }, "other"), { canceled: false, status: "unknown" });
    assert.equal((await raw(t.pageURL, `/r/${tok}`)).status, 200);
    assert.deepEqual(await ok(t, "cancel", { id: o.id }), { canceled: true, status: "canceled" });
    const g = await raw(t.pageURL, `/r/${tok}`);
    assert.equal(g.status, 410);
    assert.match(g.body, /This question was withdrawn\./);
    await until("the buttons say so", () => f.tg.of("editMessageReplyMarkup").length === 1);
    assert.equal(f.tg.of("editMessageReplyMarkup")[0].body.reply_markup.inline_keyboard[0][0].text, "Withdrawn");
    assert.deepEqual(await ok(t, "cancel", { id: o.id }), { canceled: false, status: "canceled" });
    assert.deepEqual(await ok(t, "cancel", { id: "a".repeat(16) }), { canceled: false, status: "unknown" });
    assert.match(await refused(t, "cancel", { id: "../x" }), /must match pattern/);
    // Decided, then canceled: it stays decided.
    const q = await ok(t, "ask", { to: "alice", title: "Ancora?", choices: ["sì", "no"], resume_url: resumeURL(f.gs.url) });
    await raw(t.pageURL, `/r/${tokenOf(f.ntfy.messages[1].click)}`, "POST", "choice=0");
    assert.deepEqual(await ok(t, "cancel", { id: q.id }), { canceled: false, status: "decided" });
    assert.equal(f.gs.resumes.length, 1);
  } finally {
    await t.close();
    await f.close();
  }
});

test("resume_url is gosidian's, of the call's run; the answer tried again while the run does not wait", async () => {
  const f = await fakes();
  const t = await startApp(preset(f));
  try {
    const no = async (url: string, why: RegExp, run = "r1") => assert.match(await refused(t, "ask", { to: "alice", title: "x", choices: ["a", "b"], resume_url: url }, "demo", run), why);
    await no("https://evil.example/api/v1/runs/r1/resume?key=k", /not an address of gosidian's/);
    await no(`${f.gs.url.replace("127.0.0.1", "localhost")}/api/v1/runs/r1/resume?key=k`, /not an address of gosidian's/);
    await no(`${f.gs.url}/api/v1/runs/r2/resume?key=k`, /another run's/);
    await no(`${f.gs.url}/api/v1/runs/r1/resume`, /not the resume address of a run/);
    await no(`${f.gs.url}/api/v1/runs/r1/cancel?key=k`, /not the resume address of a run/);
    await no(`${f.gs.url}/api/v1/runs/r1/resume?key=k&callback=https://evil.example`, /not the resume address of a run/);
    // A path is gosidian's too; step is kept.
    f.gs.answers.push(409, 503);
    const o = await ok(t, "ask", { to: "alice", title: "x", choices: ["a", "b"], resume_url: `/api/v1/runs/r1/resume?key=${KEY}&step=wait` });
    await raw(t.pageURL, `/r/${tokenOf(f.ntfy.messages[0].click)}`, "POST", "choice=0");
    await until("the first try logged", () => t.logs.some((l) => l.startsWith("the answer did not reach gosidian: again later") && l.includes('"status":409')));
    assert.equal(f.gs.resumes.length, 0);
    assert.equal(t.app.env.store.data.outbox.length, 1);
    // The resume's key is not in the log.
    assert.ok(!t.logs.join("\n").includes(KEY));
    t.clock.now += 2_000;
    await t.app.tick();
    assert.equal(f.gs.resumes.length, 0, "503: again later");
    t.clock.now += 4_000;
    await t.app.tick();
    assert.equal(f.gs.resumes.length, 1);
    assert.deepEqual([f.gs.resumes[0].run, f.gs.resumes[0].step, f.gs.resumes[0].body.choice], ["r1", "wait", "a"]);
    assert.equal(t.app.env.store.data.outbox.length, 0);
    assert.ok(t.logs.some((l) => l.startsWith("run resumed") && l.includes(o.id)));
    // A run that no longer waits (404): given up at once.
    f.gs.answers.push(404);
    await ok(t, "ask", { to: "alice", title: "y", choices: ["a", "b"], resume_url: resumeURL(f.gs.url) });
    await raw(t.pageURL, `/r/${tokenOf(f.ntfy.messages[1].click)}`, "POST", "choice=1");
    await until("the 404 logged", () => t.logs.some((l) => l.startsWith("the run no longer waits for this answer")));
    assert.equal(t.app.env.store.data.outbox.length, 0);
  } finally {
    await t.close();
    await f.close();
  }
  // Without gosidian_url, there is nowhere to hand an answer.
  const g = await fakes();
  const u = await startApp(parsePreset(presetText(g).replace(/gosidian_url: .*\n/, ""), "p", {}));
  try {
    assert.match(await refused(u, "ask", { to: "alice", title: "x", choices: ["a", "b"], resume_url: "/api/v1/runs/r1/resume?key=k" }), /the preset names no gosidian_url \(nor gosidian_api\)/);
  } finally {
    await u.close();
    await g.close();
  }
});

test("who can answer: approvers for a room, a way for them; quiet hours hold a question but an urgent one", async () => {
  const f = await fakes();
  const p = parsePreset(presetText(f).replace("dave: {email: dave@example.com}", 'dave: {email: dave@example.com, quiet: "22:00-07:00"}'), "p", {});
  const t = await startApp(p, { now: at("23:00") });
  try {
    const q = (args: Record<string, unknown>) => ({ title: "x", choices: ["a", "b"], resume_url: resumeURL(f.gs.url), ...args });
    assert.match(await refused(t, "ask", q({ to: "#team" })), /a question to rooms names who may answer it/);
    assert.match(await refused(t, "ask", q({ to: "#alerts", approvers: ["alice"] })), /no one can answer: alice would need/);
    assert.match(await refused(t, "ask", q({ to: "#team", approvers: ["dave"] })), /no one can answer: dave/);
    assert.match(await refused(t, "ask", q({ to: "#team", approvers: ["zed"] })), /with\.approvers: "zed" is not a person or a group/);
    // A group as approvers.
    const g = await ok(t, "ask", q({ to: "#team", approvers: ["@ops", "dave"] }));
    assert.deepEqual(g.approvers, ["alice", "bob", "dave"]);
    assert.deepEqual(g.can_answer, ["alice", "bob"]);
    // A person in to who is not an approver: the question, no buttons, no link.
    await ok(t, "ask", q({ to: ["alice", "bob"], approvers: ["alice"], channels: ["telegram", "ntfy"] }));
    const toBob = f.tg.of("sendMessage").find((c) => c.body.chat_id === 1002)!.body;
    assert.equal(toBob.reply_markup, undefined);
    assert.equal(f.ntfy.messages.find((m) => m.topic === "bob-topic").click, undefined);
    // dave is quiet: a normal question waits (high too), an urgent one goes.
    const h = await ok(t, "ask", q({ to: "dave", priority: "high", title: "Più tardi" }));
    assert.deepEqual(h.sent, [{ to: "dave", channel: "email", status: "held" }]);
    assert.deepEqual(h.can_answer, ["dave"]);
    const u = await ok(t, "ask", q({ to: "dave", priority: "urgent", title: "Subito" }));
    assert.deepEqual(u.sent, [{ to: "dave", channel: "email", status: "sent" }]);
    await until("the urgent mail", () => f.smtp.mails.some((m) => m.to[0] === "<dave@example.com>"));
    assert.equal(f.smtp.mails.filter((m) => m.to[0] === "<dave@example.com>").length, 1);
    // At the end of quiet hours: the held question, with dave's link.
    t.clock.now = at("07:00", "2026-10-21");
    await t.app.tick();
    await until("the held question", () => f.smtp.mails.filter((m) => m.to[0] === "<dave@example.com>").length === 2);
    const mail = f.smtp.mails.filter((m) => m.to[0] === "<dave@example.com>")[1];
    assert.equal(words(headersOf(mail).subject), "[high] Più tardi");
    const tok = tokenOf(textOf(mail));
    assert.equal((await raw(t.pageURL, `/r/${tok}`, "POST", "choice=0")).status, 200);
    await until("the resume", () => f.gs.resumes.some((r) => r.body.by === "dave"));
  } finally {
    await t.close();
    await f.close();
  }
});
