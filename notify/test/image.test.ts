// The image of send and ask (with.image): one file of the project, which
// gosidian hands by reference and the plugin fetches from gosidian only
// (the ticket's path at gosidian_api), within limits.image, its size and
// SHA-256 checked, a PNG, JPEG, WebP or GIF by its first bytes. On
// Telegram a photo uploaded (multipart), the text its caption when it fits
// 1024 characters, else the title and the text after it, the buttons on the
// message with the whole text; on ntfy an attachment (a PUT, the fields in
// headers), a server without attachments said in sent[]; by email an
// attachment beside the text. Held in quiet hours: a notice's image
// dropped (the digest says so), a question's kept on the volume until it
// goes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { at, fakes, GIF, JPEG, ok, partsOf, PNG, preset, presetText, refused, resumeURL, SECRETS, sha256, startApp, textOf, until, WEBP } from "./helpers.ts";
import { parsePreset } from "../src/preset.ts";

const tokenOf = (s: string) => /\/r\/([A-Za-z0-9_-]{22})/.exec(s)?.[1] ?? "";

test("the manifest reads files: send and ask take an image by reference, cancel none", async () => {
  const f = await fakes();
  const t = await startApp(preset(f));
  try {
    const c = await t.client();
    const man: any = (await c.callTool({ name: "gosidian_manifest", arguments: {} })).structuredContent;
    const tools = (await c.listTools()).tools;
    await c.close();
    assert.equal(man.permissions.files, true);
    // The network is the preset's hosts and gosidian, as before: the files come from gosidian_api.
    assert.equal(man.permissions.network.at(-1), new URL(f.gs.url).host);
    assert.deepEqual(man.nodes.map((n: any) => [n.name, n.files ?? null, n.file_refs ?? null]), [["send", ["image"], true], ["ask", ["image"], true], ["cancel", null, null]]);
    // As a pipeline writes it: a vault path; not required (gosidian then hands none).
    const img = man.nodes[0].input_schema.properties.image;
    assert.match(img.description, /PNG, JPEG, WebP or GIF by its first bytes, at most 8 MiB/);
    assert.deepEqual(img.anyOf.map((x: any) => x.type), ["string", "object", "array"]);
    assert.ok(!man.nodes[0].input_schema.required.includes("image"));
    assert.ok(!man.nodes[1].input_schema.required.includes("image"));
    // The tool gosidian calls gets a reference in its place.
    const send = tools.find((x) => x.name === "send")!;
    assert.equal((send.inputSchema.properties as any).image.anyOf, undefined);
    assert.equal((tools.find((x) => x.name === "cancel")!.inputSchema.properties as any).image, undefined);
  } finally {
    await t.close();
    await f.close();
  }
});

test("send with an image: a photo on Telegram, an attachment on ntfy and by email; fetched once, from gosidian", async () => {
  const f = await fakes();
  const t = await startApp(preset(f));
  try {
    const ref = f.gs.ref("prova 1 · schermata.png", PNG);
    const o = await ok(t, "send", { to: ["alice", "#team/agents"], title: "Anteprima pronta", text: "3 passi su 3, nessun errore", link: "https://example.com/p/1/", image: ref });
    assert.equal(f.gs.fetched.length, 1, "fetched once for every destination and channel");
    assert.deepEqual(o.sent.map((e: any) => `${e.to}/${e.channel}/${e.status}/${e.image}`).sort(), [
      "#team/agents/ntfy/sent/sent", "#team/agents/telegram/sent/sent",
      "alice/email/sent/sent", "alice/ntfy/sent/sent", "alice/telegram/sent/sent",
    ]);
    // Telegram: a photo, uploaded; the text its caption; no other message.
    const photos = f.tg.of("sendPhoto");
    assert.deepEqual(photos.map((c) => [c.body.chat_id, c.body.message_thread_id ?? null]).sort(), [[-1009, 15], [1001, null]]);
    assert.equal(f.tg.of("sendMessage").length, 0);
    for (const p of photos) {
      assert.match(p.type!, /^multipart\/form-data; boundary=/);
      assert.deepEqual([p.file!.name, p.file!.type, sha256(p.file!.data)], ["prova-1-schermata.png", "image/png", sha256(PNG)]);
      assert.equal(p.body.caption, "Anteprima pronta\n\n3 passi su 3, nessun errore\n\nhttps://example.com/p/1/");
      assert.equal(p.body.parse_mode, undefined);
      assert.equal(p.body.photo, "<file>");
    }
    // ntfy: a PUT to the topic, the bytes and the fields in headers.
    assert.deepEqual(f.ntfy.puts.sort(), ["alice-topic", "team-topic"]);
    const na = f.ntfy.messages.find((m) => m.topic === "alice-topic");
    assert.deepEqual([na.title, na.message, na.priority, na.click], ["Anteprima pronta", "3 passi su 3, nessun errore\n\nhttps://example.com/p/1/", 3, "https://example.com/p/1/"]);
    assert.deepEqual(na.actions, [{ action: "view", label: "Open the link", url: "https://example.com/p/1/" }]);
    assert.deepEqual([na.attachment.name, na.attachment.type, sha256(na.attachment.data)], ["prova-1-schermata.png", "image/png", sha256(PNG)]);
    assert.deepEqual(f.ntfy.messages.find((m) => m.topic === "team-topic").tags, ["agents"]);
    // Email: the text as without an image, the image attached.
    await until("the mail", () => f.smtp.mails.length === 1);
    const parts = partsOf(f.smtp.mails[0]);
    assert.equal(textOf(f.smtp.mails[0]), "3 passi su 3, nessun errore\n\nhttps://example.com/p/1/\n");
    const att = parts.find((p) => /^image\//.test(p.headers["content-type"] ?? ""))!;
    assert.match(att.headers["content-type"], /^image\/png; name="?prova-1-schermata\.png"?/);
    assert.match(att.headers["content-disposition"], /^attachment; filename="?prova-1-schermata\.png"?/);
    assert.equal(sha256(att.data), sha256(PNG));
    assert.ok(!parts.some((p) => /text\/html/.test(p.headers["content-type"] ?? "")), "no HTML part");
    // The ticket is a key: in no output and no log line.
    const ticket = f.gs.ticketOf(ref);
    assert.ok(!JSON.stringify(o).includes(ticket));
    assert.ok(!t.logs.join("\n").includes(ticket));
    assert.ok(t.logs.some((l) => l.startsWith("notice ") && l.includes('"image":{"mime":"image/png","size":')));
  } finally {
    await t.close();
    await f.close();
  }
});

test("the image by its first bytes, within limits.image, its size and SHA-256 checked, from gosidian only", async () => {
  const f = await fakes();
  const outside: string[] = [];
  const out = http.createServer((req, res) => {
    outside.push(`${req.method} ${req.url}`);
    res.writeHead(200).end(PNG);
  });
  await new Promise<void>((ok) => out.listen(0, "127.0.0.1", ok));
  const outURL = `http://127.0.0.1:${(out.address() as AddressInfo).port}`;
  const t = await startApp(preset(f, "limits: {image: 1KiB}\n"));
  try {
    const no = async (image: unknown, why: RegExp) => assert.match(await refused(t, "send", { to: "alice", title: "x", image }), why);
    const png = (n: number) => Buffer.concat([PNG.subarray(0, 16), Buffer.alloc(n - 16, 0)]);
    await no(f.gs.ref("shot.png", Buffer.from("not an image at all, whatever its name says")), /^with\.image "shot\.png": not a PNG, JPEG, WebP or GIF image \(by its first bytes/);
    await no(f.gs.ref("logo.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), /not a PNG, JPEG, WebP or GIF image/);
    await no(f.gs.ref("shot.png", Buffer.from("%PDF-1.7\n")), /not a PNG, JPEG, WebP or GIF image/);
    // Too big: said by gosidian, refused before it is fetched; or found so while it comes.
    const before = f.gs.fetched.length;
    await no(f.gs.ref("big.png", png(2048)), /^with\.image "big\.png": 2 KiB, more than 1 KiB \(limits\.image\)$/);
    assert.equal(f.gs.fetched.length, before, "not fetched");
    await no(f.gs.ref("big.png", png(1500), { size: 100 }), /^with\.image "big\.png": more than 1 KiB \(limits\.image\)$/);
    await no(f.gs.ref("shot.png", png(500), { size: 400 }), /500 bytes came, gosidian said 400/);
    await no(f.gs.ref("shot.png", png(500), { sha256: "0".repeat(64) }), /what came is not the file gosidian named \(its SHA-256 differs\)/);
    // Only gosidian's tickets, at gosidian_api: no other host, no other address of gosidian's.
    const ref = f.gs.ref("shot.png", PNG);
    await no({ ...ref, url: ref.url.replace(f.gs.url, outURL) }, /its url is not an address of gosidian's \(the preset's gosidian_url or gosidian_api\)/);
    await no({ ...ref, url: ref.url.replace("127.0.0.1", "localhost") }, /not an address of gosidian's/);
    await no({ ...ref, url: ref.url.replace("http://", "http://user:pw@") }, /not an address of gosidian's/);
    await no({ ...ref, url: `${f.gs.url}/api/v1/runs/r1/resume?key=k` }, /its url is not a file gosidian handed \(\/api\/v1\/run-files\/<ticket>\)/);
    await no({ ...ref, url: `${ref.url}?redirect=${outURL}` }, /not a file gosidian handed/);
    await no({ ...ref, url: `${f.gs.url}/api/v1/run-files/../../etc/passwd` }, /not a file gosidian handed/);
    await no({ ...ref, url: "file:///etc/passwd" }, /not an address of gosidian's/);
    // Not a reference: a path gosidian did not resolve, two files, nothing.
    await no("attachments/shot.png", /with\.image is not a file gosidian handed by reference/);
    await no([ref, ref], /with\.image: one image, not 2 files/);
    await no([], /with\.image: one image, not 0 files/);
    // A ticket gone (the step's time over, the run ended): its 404.
    const gone = f.gs.ref("shot.png", PNG);
    f.gs.files.delete(f.gs.ticketOf(gone));
    await no(gone, /fetching it from gosidian answered 404 \(a ticket lasts while the step may run\)/);
    // Nothing went anywhere, nothing reached the host outside.
    assert.equal(f.tg.calls.filter((c) => c.method !== "getUpdates").length, 0);
    assert.equal(f.ntfy.messages.length, 0);
    assert.equal(f.smtp.mails.length, 0);
    assert.deepEqual(outside, []);

    // JPEG and WebP: photos; GIF: a file, which Telegram shows moving. The
    // name's extension is the one the bytes say.
    for (const [data, name, method, sent] of [[JPEG, "a.png", "sendPhoto", "a.jpg"], [WEBP, "b", "sendPhoto", "b.webp"], [GIF, "c.gif", "sendDocument", "c.gif"]] as const) {
      const r = await ok(t, "send", { to: "carol", title: name, image: f.gs.ref(name, data) });
      assert.equal(r.sent[0].image, "sent");
      const call = f.tg.calls.at(-1)!;
      assert.deepEqual([call.method, call.file!.name, sha256(call.file!.data)], [method, sent, sha256(data)]);
    }
    assert.equal(f.tg.of("sendDocument")[0].body.document, "<file>");
  } finally {
    await t.close();
    await f.close();
    out.close();
  }
  // gosidian_url another address of gosidian's: the ticket fetched at gosidian_api.
  const g = await fakes();
  const u = await startApp(parsePreset(presetText(g).replace(/gosidian_url: .*\n/, `gosidian_url: https://gosidian.example.com\ngosidian_api: ${g.gs.url}\n`), "p", {}));
  try {
    const ref = g.gs.ref("shot.png", PNG);
    const r = await ok(u, "send", { to: "carol", title: "x", image: { ...ref, url: ref.url.replace(g.gs.url, "https://gosidian.example.com") } });
    assert.equal(r.sent[0].image, "sent");
    assert.equal(g.gs.fetched.length, 1);
  } finally {
    await u.close();
    await g.close();
  }
  // No gosidian in the preset: nowhere to fetch an image from.
  const h = await fakes();
  const v = await startApp(parsePreset(presetText(h).replace(/gosidian_url: .*\n/, ""), "p", {}));
  try {
    assert.match(await refused(v, "send", { to: "carol", title: "x", image: h.gs.ref("shot.png", PNG) }), /with\.image: the preset names no gosidian_url \(nor gosidian_api\): the plugin fetches files from gosidian only/);
  } finally {
    await v.close();
    await h.close();
  }
});

test("limits.image from the preset: a size, from 1 KiB to 50 MB", async () => {
  const f = await fakes();
  try {
    assert.equal(preset(f).limits.image, 8 * 2 ** 20);
    assert.equal(preset(f, "limits: {image: 512KiB}\n").limits.image, 512 * 1024);
    assert.equal(preset(f, "limits: {image: 20MB}\n").limits.image, 20e6);
    assert.equal(preset(f, "limits: {image: 4096}\n").limits.image, 4096);
    assert.throws(() => preset(f, "limits: {image: 51MB}\n"), /limits\.image 48\.6 MiB: from 1 KiB to 50 MB/);
    assert.throws(() => preset(f, "limits: {image: 100}\n"), /limits\.image 100 bytes: from 1 KiB/);
    assert.throws(() => preset(f, "limits: {image: lots}\n"), /limits\.image: "lots" is not a size/);
  } finally {
    await f.close();
  }
});

test("Telegram: the caption within 1024 characters, a longer text after the photo; the buttons and their outcome on the message with the whole text", async () => {
  const f = await fakes();
  const t = await startApp(preset(f));
  try {
    // A short question: one message, the photo, its caption the text, the buttons on it.
    const q = await ok(t, "ask", { to: "alice", title: "Approvi la pagina?", text: "La prova: 7 passi su 7.", choices: ["approva", "rifai", "scarta"], resume_url: resumeURL(f.gs.url), channels: ["telegram"], image: f.gs.ref("shot.png", PNG) });
    assert.equal(q.sent[0].image, "sent");
    const [photo] = f.tg.of("sendPhoto");
    assert.equal(photo.body.caption, "Approvi la pagina?\n\nLa prova: 7 passi su 7.");
    assert.deepEqual(photo.body.reply_markup, { inline_keyboard: [[{ text: "approva", callback_data: `a:${q.id}:0` }, { text: "rifai", callback_data: `a:${q.id}:1` }, { text: "scarta", callback_data: `a:${q.id}:2` }]] });
    assert.equal(photo.body.disable_notification, undefined);
    assert.equal(f.tg.of("sendMessage").length, 0);
    assert.deepEqual(t.app.env.store.data.questions[q.id].telegram, [{ chat: 1001, message_id: photo.result!.message_id }]);
    // A press on the photo decides; its buttons become the outcome, the caption stays.
    f.tg.press(1001, { chat: 1001, message_id: photo.result!.message_id }, `a:${q.id}:1`);
    await until("the resume", () => f.gs.resumes.length === 1);
    assert.equal(f.gs.resumes[0].body.choice, "rifai");
    await until("the outcome", () => f.tg.of("editMessageReplyMarkup").length === 1);
    assert.deepEqual(f.tg.of("editMessageReplyMarkup")[0].body, { chat_id: 1001, message_id: photo.result!.message_id, reply_markup: { inline_keyboard: [[{ text: "rifai: alice", callback_data: `d:${q.id}` }]] } });
    assert.equal(f.tg.of("editMessageCaption").length, 0);

    // A long text: the photo with the title (silent), then the whole text with the buttons.
    const long = `Esito della prova\n${"passo superato; ".repeat(90)}`;
    const l = await ok(t, "ask", { to: "#team/agents", approvers: ["alice"], title: "Approvi?", text: long, priority: "high", choices: ["approva", "scarta"], resume_url: resumeURL(f.gs.url), channels: ["telegram"], image: f.gs.ref("shot.png", PNG) });
    assert.equal(l.sent[0].image, "sent");
    const p2 = f.tg.of("sendPhoto")[1];
    const m2 = f.tg.of("sendMessage")[0];
    assert.deepEqual([p2.body.chat_id, p2.body.message_thread_id, p2.body.caption, p2.body.disable_notification, p2.body.reply_markup], [-1009, 15, "[high] Approvi?", true, undefined]);
    assert.ok(m2.body.text.length > 1024 && m2.body.text.startsWith("[high] Approvi?\n\nEsito della prova\npasso superato;"), m2.body.text.slice(0, 80));
    assert.equal(m2.body.message_thread_id, 15);
    assert.equal(m2.body.disable_notification, undefined, "the text notifies, once");
    assert.ok(m2.result!.message_id > p2.result!.message_id, "the photo first, then the text");
    assert.deepEqual(m2.body.reply_markup.inline_keyboard[0].map((b: any) => b.text), ["approva", "scarta"]);
    assert.deepEqual(t.app.env.store.data.questions[l.id].telegram, [{ chat: -1009, message_id: m2.result!.message_id }]);
    f.tg.press(1001, { chat: -1009, message_id: m2.result!.message_id }, `a:${l.id}:0`);
    await until("the second outcome", () => f.tg.of("editMessageReplyMarkup").length === 2);
    assert.equal(f.tg.of("editMessageReplyMarkup")[1].body.message_id, m2.result!.message_id);

    // send: the same; a long text without a title, the photo without a caption.
    await ok(t, "send", { to: "carol", text: "x".repeat(1100), image: f.gs.ref("shot.png", PNG) });
    const p3 = f.tg.of("sendPhoto")[2];
    assert.deepEqual([p3.body.caption, p3.body.disable_notification], [undefined, true]);
    assert.equal(f.tg.of("sendMessage")[1].body.text.length, 1100);
    // A text of 1024 exactly fits a caption.
    await ok(t, "send", { to: "carol", text: "y".repeat(1024), image: f.gs.ref("shot.png", PNG) });
    assert.equal(f.tg.of("sendPhoto")[3].body.caption.length, 1024);
    assert.equal(f.tg.of("sendMessage").length, 2);
    // A low priority: silent, the photo and the text.
    await ok(t, "send", { to: "carol", title: "t", text: "z".repeat(1100), priority: "low", image: f.gs.ref("shot.png", PNG) });
    assert.deepEqual([f.tg.of("sendPhoto")[4].body.disable_notification, f.tg.of("sendMessage")[2].body.disable_notification], [true, true]);
  } finally {
    await t.close();
    await f.close();
  }
});

test("Telegram: a photo not taken as one goes as a file; an image taken in no way, the message without it, said", async () => {
  const f = await fakes();
  const t = await startApp(preset(f));
  try {
    // A full page's screenshot, too long a side for a photo: a file, the same caption and buttons.
    f.tg.fail.sendPhoto = [{ code: 400, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" }];
    const q = await ok(t, "ask", { to: "carol", title: "Ok?", choices: ["sì", "no"], resume_url: resumeURL(f.gs.url), image: f.gs.ref("full.png", PNG) });
    assert.deepEqual([q.sent[0].status, q.sent[0].image, q.sent[0].note], ["sent", "sent", undefined]);
    const d = f.tg.of("sendDocument")[0];
    assert.deepEqual([d.body.caption, d.body.reply_markup.inline_keyboard[0].length, d.file!.name], ["Ok?", 2, "full.png"]);
    assert.deepEqual(t.app.env.store.data.questions[q.id].telegram, [{ chat: 1003, message_id: d.result!.message_id }]);
    assert.ok(t.logs.some((l) => l.startsWith("telegram: a photo not taken as one, sent as a file")));
    // Neither (a group where the bot may not send media): the text alone, with the buttons; the entry says why.
    f.tg.fail.sendPhoto = [{ code: 400, description: "Bad Request: not enough rights to send photos to the chat" }];
    const r = await ok(t, "ask", { to: "carol", title: "Ancora?", choices: ["sì", "no"], resume_url: resumeURL(f.gs.url), image: f.gs.ref("shot.png", PNG) });
    assert.deepEqual([r.sent[0].status, r.sent[0].image], ["sent", "dropped"]);
    assert.equal(r.sent[0].note, "Telegram took no image: telegram sendPhoto: 400 Bad Request: not enough rights to send photos to the chat");
    const m = f.tg.of("sendMessage").at(-1)!;
    assert.deepEqual([m.body.text, m.body.reply_markup.inline_keyboard[0].length], ["Ancora?", 2]);
    assert.deepEqual(t.app.env.store.data.questions[r.id].telegram, [{ chat: 1003, message_id: m.result!.message_id }]);
    assert.match((await t.call("send", { to: "carol", title: "x", image: f.gs.ref("s.png", PNG) })).content[0].text, /^1 sent: carol$/);
    f.tg.fail.sendPhoto = [{ code: 400, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" }];
    f.tg.fail.sendDocument = [{ code: 400, description: "Bad Request: file must be non-empty" }];
    const s = await t.call("send", { to: "carol", title: "x", image: f.gs.ref("s.png", PNG) });
    assert.equal(s.content[0].text, "1 sent; 1 without the image: carol");
    // A chat that refuses the bot: failed, as without an image.
    f.tg.fail.sendPhoto = [{ code: 403, description: "Forbidden: bot was blocked by the user" }];
    const b = await t.call("send", { to: "carol", title: "x", image: f.gs.ref("s.png", PNG) });
    assert.equal(b.isError, true);
    assert.equal(b.content[0].text, "nothing went: carol/telegram: telegram sendPhoto: 403 Forbidden: bot was blocked by the user");
    // A topic the bot made, deleted since: made again, the photo sent there.
    await ok(t, "send", { to: "#team/errori", title: "e1", channels: ["telegram"] });
    f.tg.fail.sendPhoto = [{ code: 400, description: "Bad Request: message thread not found" }];
    const again = await ok(t, "send", { to: "#team/errori", title: "e2", channels: ["telegram"], image: f.gs.ref("s.png", PNG) });
    assert.deepEqual([again.sent[0].status, again.sent[0].image], ["sent", "sent"]);
    assert.equal(f.tg.of("createForumTopic").length, 2);
    assert.equal(f.tg.of("sendPhoto").at(-1)!.body.message_thread_id, 501);
  } finally {
    await t.close();
    await f.close();
  }
});

test("ntfy: a server without attachments, or one too big for it: the message without the image, said in sent[]", async () => {
  const f = await fakes();
  let t = await startApp(preset(f));
  try {
    f.ntfy.o.attachments = false;
    const a = await ok(t, "send", { to: "alice", title: "Anteprima", text: "pronta", channels: ["ntfy"], image: f.gs.ref("s.png", PNG) });
    assert.deepEqual(a.sent, [{ to: "alice", channel: "ntfy", status: "sent", image: "dropped", note: "the ntfy server takes no attachments (its attachment-cache-dir is not set): sent without the image" }]);
    assert.equal(a.ok, true);
    assert.deepEqual(f.ntfy.puts, ["alice-topic"]);
    assert.deepEqual([f.ntfy.messages[0].title, f.ntfy.messages[0].message, f.ntfy.messages[0].attachment], ["Anteprima", "pronta", undefined]);
    // Known: not tried again for an hour.
    const b = await ok(t, "send", { to: "alice", title: "Ancora", channels: ["ntfy"], image: f.gs.ref("s.png", PNG) });
    assert.equal(b.sent[0].image, "dropped");
    assert.deepEqual(f.ntfy.puts, ["alice-topic"]);
    assert.equal(f.ntfy.messages.length, 2);
    await t.stop();
    // An attachment past the server's limit: 413, the message without it; tried again next time.
    f.ntfy.o.attachments = true;
    t = await startApp(preset(f));
    f.ntfy.fail.push({ status: 413, code: 41301, error: "invalid request: attachment too large, or bandwidth limit reached" });
    const c = await ok(t, "send", { to: "alice", title: "Grande", channels: ["ntfy"], image: f.gs.ref("s.png", PNG) });
    assert.deepEqual([c.sent[0].image, c.sent[0].note], ["dropped", "ntfy took no attachment (ntfy answered 413: invalid request: attachment too large, or bandwidth limit reached): sent without the image"]);
    const d = await ok(t, "send", { to: "alice", title: "Piccola", channels: ["ntfy"], image: f.gs.ref("s.png", PNG) });
    assert.equal(d.sent[0].image, "sent");
    assert.equal(f.ntfy.puts.length, 3);
    // A token that may not write: failed, as without an image.
    f.ntfy.fail.push({ status: 403, code: 40301, error: "forbidden" });
    assert.match(await refused(t, "send", { to: "alice", title: "x", channels: ["ntfy"], image: f.gs.ref("s.png", PNG) }), /^nothing went: alice\/ntfy: ntfy answered 403: forbidden$/);
    // One post at a time, uploads too.
    const all = await Promise.all([1, 2, 3, 4].map((i) => ok(t, "send", { to: ["alice", "#team"], title: `n${i}`, channels: ["ntfy"], image: f.gs.ref("s.png", PNG) })));
    assert.deepEqual(all.map((x) => x.counts.sent), [2, 2, 2, 2]);
  } finally {
    await t.close();
    await f.close();
  }
});

test("email: a server that refuses the size gets the message without the image, said", async () => {
  const f = await fakes();
  const t = await startApp(preset(f));
  try {
    f.smtp.o.max = 1500;
    const r = await ok(t, "send", { to: "dave", title: "Con immagine", text: "il testo", image: f.gs.ref("s.png", Buffer.concat([PNG, Buffer.alloc(2000, 9)])) });
    assert.equal(r.sent[0].image, "dropped");
    assert.match(r.sent[0].note, /^the SMTP server refused the message with the image \(email: EMESSAGE 552: .*\): sent without it$/);
    assert.equal(f.smtp.o.refused, 1);
    await until("the mail", () => f.smtp.mails.length === 1);
    assert.equal(partsOf(f.smtp.mails[0]).length, 1);
    assert.equal(textOf(f.smtp.mails[0]), "il testo\n");
  } finally {
    await t.close();
    await f.close();
  }
});

test("quiet hours: a notice's image dropped (its digest says so); a question's kept on the volume, sent when they end, the ticket gone, after a restart; then removed", async () => {
  const f = await fakes();
  const p = parsePreset(presetText(f).replace("alice: {telegram: 1001, ntfy: alice-topic, email: alice@example.com}", 'alice: {telegram: 1001, ntfy: alice-topic, email: alice@example.com, quiet: "22:00-07:00"}'), "p", {});
  let t = await startApp(p, { now: at("23:00"), keepStore: true });
  const images = path.join(p.store_dir, "images");
  try {
    const n = await ok(t, "send", { to: "alice", title: "Anteprima della notte", text: "pronta", image: f.gs.ref("s.png", PNG) });
    assert.deepEqual(n.sent[0], { to: "alice", channel: "telegram", status: "held", image: "dropped", note: "held for the digest of the quiet hours, which carries no image" });
    assert.ok(!fs.existsSync(images) || fs.readdirSync(images).length === 0, "a notice's image is not kept");
    const ref = f.gs.ref("domanda.png", JPEG);
    const q = await ok(t, "ask", { to: "alice", title: "Approvi?", choices: ["sì", "no"], resume_url: resumeURL(f.gs.url), image: ref });
    assert.deepEqual(q.sent.map((e: any) => `${e.channel}/${e.status}/${e.image}`), ["telegram/held/held", "ntfy/held/held", "email/held/held"]);
    assert.deepEqual(fs.readdirSync(images), [sha256(JPEG)]);
    assert.equal((fs.statSync(path.join(images, sha256(JPEG))).mode & 0o777).toString(8), "600");
    assert.equal((fs.statSync(images).mode & 0o777).toString(8), "700");
    // The run's tickets are gone by morning.
    f.gs.files.clear();
    const fetched = f.gs.fetched.length;
    t.clock.now = at("06:30", "2026-10-21");
    await t.app.tick();
    assert.deepEqual(fs.readdirSync(images), [sha256(JPEG)], "kept while it is held");
    await t.stop();
    t = await startApp(p, { now: at("07:00", "2026-10-21"), keepStore: true });
    await t.app.tick();
    assert.equal(f.gs.fetched.length, fetched, "nothing fetched again");
    // The digest: text, the notice's image said, not sent.
    const digest = f.tg.of("sendMessage").find((c) => c.body.chat_id === 1001)!.body.text;
    assert.equal(digest, "1 notifications while quiet\n\n23:00 Anteprima della notte [image]\npronta");
    // The question: with its image, from the volume, on each channel.
    const photo = f.tg.of("sendPhoto").find((c) => c.body.chat_id === 1001)!;
    assert.deepEqual([photo.body.caption, sha256(photo.file!.data), photo.file!.name], ["Approvi?", sha256(JPEG), "domanda.jpg"]);
    assert.ok(photo.body.reply_markup);
    const put = f.ntfy.messages.find((m) => m.attachment);
    assert.deepEqual([put.title, sha256(put.attachment.data)], ["Approvi?", sha256(JPEG)]);
    await until("the question by mail", () => f.smtp.mails.some((m) => partsOf(m).some((x) => /^image\/jpeg/.test(x.headers["content-type"] ?? ""))));
    // Sent: its image no longer kept.
    await t.app.tick();
    assert.deepEqual(fs.readdirSync(images), []);
    // A question withdrawn while held: its image goes too.
    t.clock.now = at("23:30", "2026-10-21");
    const w = await ok(t, "ask", { to: "alice", title: "Ritirata", choices: ["sì", "no"], resume_url: resumeURL(f.gs.url), image: f.gs.ref("w.png", PNG), channels: ["ntfy"] });
    assert.deepEqual(fs.readdirSync(images), [sha256(PNG)]);
    await ok(t, "cancel", { id: w.id });
    await t.app.tick();
    assert.deepEqual(fs.readdirSync(images), []);
    // An urgent question passes the quiet hours, its image with it.
    const u = await ok(t, "ask", { to: "alice", title: "Subito", priority: "urgent", choices: ["sì", "no"], resume_url: resumeURL(f.gs.url), image: f.gs.ref("u.png", PNG), channels: ["telegram"] });
    assert.deepEqual([u.sent[0].status, u.sent[0].image], ["sent", "sent"]);
    assert.deepEqual(fs.readdirSync(images), []);
    // The state keeps what an image is, never its bytes nor its ticket.
    const state = fs.readFileSync(path.join(p.store_dir, "state.json"), "utf8");
    assert.ok(!state.includes(f.gs.ticketOf(ref)));
    assert.ok(!state.includes(PNG.toString("base64").slice(0, 40)));
    assert.ok(state.includes(sha256(JPEG)));
  } finally {
    await t.close();
    await f.close();
  }
});

test("grouping: the same key with an image counted; its count goes as text", async () => {
  const f = await fakes();
  const t = await startApp(parsePreset(presetText(f, "limits: {group_window: 5m}\n"), "p", {}), { now: at("10:00") });
  try {
    const a = await ok(t, "send", { to: "carol", title: "Prova fallita", key: "prova", image: f.gs.ref("s.png", PNG) });
    assert.equal(a.sent[0].image, "sent");
    t.clock.now = at("10:01");
    const b = await ok(t, "send", { to: "carol", title: "Prova fallita", key: "prova", image: f.gs.ref("s.png", PNG) });
    assert.deepEqual(b.sent, [{ to: "carol", channel: "telegram", status: "grouped" }]);
    t.clock.now = at("10:05");
    await t.app.tick();
    assert.equal(f.tg.of("sendPhoto").length, 1);
    assert.equal(f.tg.of("sendMessage").at(-1)!.body.text, "Prova fallita (+1)");
  } finally {
    await t.close();
    await f.close();
  }
});

test("no secret where an image goes wrong: the bot's token and the ticket redacted", async () => {
  const f = await fakes();
  const t = await startApp(preset(f));
  try {
    const ref = f.gs.ref("s.png", PNG);
    const ticket = f.gs.ticketOf(ref);
    f.tg.fail.sendPhoto = [{ code: 401, description: `Unauthorized: ${SECRETS.telegram_token} for ${ref.url}` }];
    f.ntfy.fail.push({ status: 401, error: `the token ${SECRETS.ntfy_token} is not valid` });
    const r = await t.call("send", { to: "alice", title: "x", image: ref });
    const out = JSON.stringify(r);
    assert.match(out, /telegram sendPhoto: 401 Unauthorized: \[secret\] for http:\/\/127\.0\.0\.1:\d+\/api\/v1\/run-files\/\[secret\]/);
    assert.match(out, /ntfy answered 401: the token \[secret\] is not valid/);
    // A ticket gone: its error names no address.
    f.gs.files.clear();
    const g = await t.call("send", { to: "alice", title: "x", image: f.gs.ref("s.png", PNG) });
    const gone = await t.call("send", { to: "alice", title: "x", image: { ...ref } });
    const all = [out, JSON.stringify(g), JSON.stringify(gone), ...t.logs].join("\n");
    for (const v of [SECRETS.telegram_token, SECRETS.telegram_token.split(":")[1], SECRETS.ntfy_token, ticket]) assert.ok(!all.includes(v), `${v.slice(0, 6)}… leaked`);
    assert.match(JSON.stringify(gone), /fetching it from gosidian answered 404/);
  } finally {
    await t.close();
    await f.close();
  }
});

test("a reply page token is not an image's: the link and the image together on ntfy and email", async () => {
  const f = await fakes();
  const t = await startApp(preset(f));
  try {
    const q = await ok(t, "ask", { to: "bob", title: "Approvi?", choices: ["sì", "no"], resume_url: resumeURL(f.gs.url), channels: ["ntfy", "email"], image: f.gs.ref("s.png", PNG) });
    assert.deepEqual(q.sent.map((e: any) => e.image), ["sent", "sent"]);
    const n = f.ntfy.messages[0];
    const tok = tokenOf(n.click);
    assert.ok(tok);
    assert.deepEqual(n.actions[0], { action: "view", label: "Answer", url: `${t.preset.public_url}/r/${tok}`, clear: true });
    assert.equal(sha256(n.attachment.data), sha256(PNG));
    await until("the mail", () => f.smtp.mails.length === 1);
    assert.match(textOf(f.smtp.mails[0]), /^sì \/ no\n\nAnswer: http:\/\/127\.0\.0\.1:\d+\/r\/[A-Za-z0-9_-]{22}\n$/);
    assert.equal(partsOf(f.smtp.mails[0]).length, 2);
  } finally {
    await t.close();
    await f.close();
  }
});
