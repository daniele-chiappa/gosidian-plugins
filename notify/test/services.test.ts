// The channels against real servers, when the tests are given them (as
// scripts/test.sh and the CI do, in containers): an ntfy server with
// access control (deny-all, a user and its token) and attachments, and a
// Mailpit SMTP that asks for a user and password. What arrives is read
// back from their APIs, an image's bytes too. Without NOTIFY_TEST_NTFY or
// NOTIFY_TEST_SMTP, skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakes, ok, PNG, presetText, raw, refused, resumeURL, SECRETS, sha256, startApp, until } from "./helpers.ts";
import { parsePreset } from "../src/preset.ts";
import { remember } from "../src/secrets.ts";

const NTFY = process.env.NOTIFY_TEST_NTFY ?? "";
const NTFY_TOKEN = process.env.NOTIFY_TEST_NTFY_TOKEN ?? "";
const SMTP = process.env.NOTIFY_TEST_SMTP ?? "";
const MAILPIT = process.env.NOTIFY_TEST_MAILPIT ?? "";
const SMTP_USER = process.env.NOTIFY_TEST_SMTP_USER ?? "";
const SMTP_PASS = process.env.NOTIFY_TEST_SMTP_PASS ?? "";
remember(NTFY_TOKEN);
remember(SMTP_PASS);

// real is the tests' preset with ntfy and email at the real servers; the
// topics are the run's own, under notify-*.
function real(f: Awaited<ReturnType<typeof fakes>>, run: string) {
  const [host, port] = SMTP.split(":");
  const y = presetText(f)
    .replace(`server: "${f.ntfy.url}"`, `server: "${NTFY || f.ntfy.url}"`)
    .replace(`host: 127.0.0.1, port: ${f.smtp.port}`, `host: ${host || "127.0.0.1"}, port: ${port || f.smtp.port}`)
    .replace(/alice-topic/g, `notify-${run}-alice`)
    .replace(/team-topic/g, `notify-${run}-team`);
  return parsePreset(y, "p", {});
}

async function ntfyPoll(topic: string): Promise<any[]> {
  const r = await fetch(`${NTFY}/${topic}/json?poll=1`, { headers: { authorization: `Bearer ${NTFY_TOKEN}` } });
  assert.equal(r.status, 200);
  return (await r.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.event === "message");
}

test("ntfy: a real server with access control", { skip: !NTFY && "no NOTIFY_TEST_NTFY" }, async () => {
  const f = await fakes();
  const run = Math.random().toString(36).slice(2, 8);
  try {
    await ntfyCase(f, run);
  } finally {
    await f.close();
  }
});

async function ntfyCase(f: Awaited<ReturnType<typeof fakes>>, run: string): Promise<void> {
  const t = await startApp(real(f, run), { secrets: { ...SECRETS, ntfy_token: NTFY_TOKEN } });
  try {
    const o = await ok(t, "send", { to: ["alice", "#team/agents"], title: "Il rilascio è pronto", text: "v1.2.0: 3 correzioni\n<b>non è HTML</b>", link: "https://example.com/release/1.2.0", priority: "high", channels: ["ntfy"] });
    assert.deepEqual(o.counts, { sent: 2, held: 0, grouped: 0, failed: 0 });
    const [m] = await ntfyPoll(`notify-${run}-alice`);
    assert.equal(m.title, "Il rilascio è pronto");
    assert.equal(m.message, "v1.2.0: 3 correzioni\n<b>non è HTML</b>\n\nhttps://example.com/release/1.2.0");
    assert.equal(m.priority, 4);
    assert.equal(m.click, "https://example.com/release/1.2.0");
    assert.deepEqual(m.actions.map((a: any) => [a.action, a.label, a.url]), [["view", "Open the link", "https://example.com/release/1.2.0"]]);
    const [r] = await ntfyPoll(`notify-${run}-team`);
    assert.deepEqual(r.tags, ["agents"]);
    // Sends at once: the plugin posts them one at a time (ntfy 2.28 answers
    // some concurrent posts of a token 403).
    const burst = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => ok(t, "send", { to: ["alice", "#team"], title: `burst ${i}`, channels: ["ntfy"] })));
    assert.deepEqual(burst.map((b) => b.counts.sent), [2, 2, 2, 2, 2, 2]);
    // A title alone is ntfy's message.
    assert.equal((await ntfyPoll(`notify-${run}-alice`)).filter((x) => /^burst \d$/.test(x.message) && x.title === undefined).length, 6);
    // A question: the action Answer opens the reply page; it decides with a POST.
    await ok(t, "ask", { to: "alice", title: "Approvi il rilascio?", choices: ["approva", "rifiuta"], resume_url: resumeURL(f.gs.url), channels: ["ntfy"] });
    const q = (await ntfyPoll(`notify-${run}-alice`)).find((x) => x.title === "Approvi il rilascio?");
    const answer = q.actions.find((a: any) => a.label === "Answer");
    assert.equal(q.click, answer.url);
    assert.equal(q.priority, 3);
    const path = new URL(answer.url).pathname;
    assert.equal((await raw(t.pageURL, path)).status, 200);
    assert.equal((await raw(t.pageURL, path, "POST", "choice=0")).status, 200);
    await until("the resume", () => f.gs.resumes.length === 1);
    assert.equal(f.gs.resumes[0].body.choice, "approva");

    // An image: an attachment, the message's fields in headers, UTF-8 and a
    // long text whole.
    const long = `Esito della prova: ${"è passato; ".repeat(260)}`.trim();
    const img = await ok(t, "send", { to: ["alice", "#team/agents"], title: "L'anteprima è pronta 😀", text: long, link: "https://example.com/p/1/", priority: "high", image: f.gs.ref("schermata della prova.png", PNG), channels: ["ntfy"] });
    assert.deepEqual(img.sent.map((e: any) => [e.status, e.image]), [["sent", "sent"], ["sent", "sent"]]);
    const a = (await ntfyPoll(`notify-${run}-alice`)).find((x) => x.attachment);
    assert.equal(a.title, "L'anteprima è pronta 😀");
    assert.equal(a.message, `${long}\n\nhttps://example.com/p/1/`);
    assert.ok(Buffer.byteLength(a.message) > 3000);
    assert.deepEqual([a.priority, a.click], [4, "https://example.com/p/1/"]);
    assert.deepEqual(a.actions.map((x: any) => [x.action, x.label, x.url]), [["view", "Open the link", "https://example.com/p/1/"]]);
    assert.deepEqual([a.attachment.name, a.attachment.type, a.attachment.size], ["schermata-della-prova.png", "image/png", PNG.length]);
    const got = Buffer.from(await (await fetch(a.attachment.url, { headers: { authorization: `Bearer ${NTFY_TOKEN}` } })).arrayBuffer());
    assert.equal(sha256(got), sha256(PNG));
    const team = (await ntfyPoll(`notify-${run}-team`)).find((x) => x.attachment);
    assert.deepEqual(team.tags, ["agents"]);
    // A question with an image: the action Answer, in a header, still opens the page.
    await ok(t, "ask", { to: "alice", title: "Approvi la pagina?", choices: ["approva", "rifai", "scarta"], resume_url: resumeURL(f.gs.url), channels: ["ntfy"], image: f.gs.ref("s.png", PNG) });
    const iq = (await ntfyPoll(`notify-${run}-alice`)).find((x) => x.title === "Approvi la pagina?");
    const ia = iq.actions.find((x: any) => x.label === "Answer");
    assert.equal(iq.click, ia.url);
    assert.equal(iq.attachment.size, PNG.length);
    assert.equal((await raw(t.pageURL, new URL(ia.url).pathname, "POST", "choice=1")).status, 200);
    await until("the second resume", () => f.gs.resumes.length === 2);
    assert.equal(f.gs.resumes[1].body.choice, "rifai");
  } finally {
    await t.close();
  }
  // Without the token, the server's deny-all refuses: the error says so.
  const u = await startApp(real(f, run), { secrets: { ...SECRETS, ntfy_token: "" } });
  try {
    assert.match(await refused(u, "send", { to: "alice", title: "x", channels: ["ntfy"] }), /^nothing went: alice\/ntfy: ntfy answered 403: forbidden$/);
  } finally {
    await u.close();
  }
}

async function mails(): Promise<any[]> {
  return (await (await fetch(`${MAILPIT}/api/v1/messages?limit=200`)).json()).messages ?? [];
}

test("email: a real SMTP (Mailpit) with a user and a password", { skip: !(SMTP && MAILPIT) && "no NOTIFY_TEST_SMTP and NOTIFY_TEST_MAILPIT" }, async () => {
  const f = await fakes();
  const run = Math.random().toString(36).slice(2, 8);
  try {
    await emailCase(f, run);
  } finally {
    await f.close();
  }
});

async function emailCase(f: Awaited<ReturnType<typeof fakes>>, run: string): Promise<void> {
  const t = await startApp(real(f, run), { secrets: { ...SECRETS, smtp_user: SMTP_USER, smtp_password: SMTP_PASS } });
  try {
    const subject = `[high] Il rilascio è pronto ${run}`;
    await ok(t, "send", { to: "alice", title: `Il rilascio è pronto ${run}`, text: "Righe in UTF-8: è, ü, 😀\n<a href=x>non è HTML</a>\n.una riga col punto", link: "https://example.com/r/1", priority: "high", channels: ["email"] });
    let m: any;
    await until("the mail in Mailpit", async () => Boolean((m = (await mails()).find((x) => x.Subject === subject))));
    const full = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
    assert.equal(full.From.Address, "notify@example.com");
    assert.equal(full.From.Name, "Notify");
    assert.deepEqual(full.To.map((x: any) => x.Address), ["alice@example.com"]);
    assert.equal(full.HTML, "");
    assert.equal(full.Text.replace(/\r\n/g, "\n"), "Righe in UTF-8: è, ü, 😀\n<a href=x>non è HTML</a>\n.una riga col punto\n\nhttps://example.com/r/1\n");
    const h = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}/headers`)).json();
    assert.match(h["Content-Type"][0], /^text\/plain; charset=utf-8/);
    assert.equal(h["X-Priority"][0], "1 (Highest)");
    assert.equal(h["Auto-Submitted"][0], "auto-generated");
    // A question by email: the link, a GET that decides nothing, the POST.
    await ok(t, "ask", { to: "alice", title: `Approvi? ${run}`, choices: ["sì", "no"], resume_url: resumeURL(f.gs.url), channels: ["email"] });
    let q: any;
    await until("the question in Mailpit", async () => Boolean((q = (await mails()).find((x) => x.Subject === `Approvi? ${run}`))));
    const text = ((await (await fetch(`${MAILPIT}/api/v1/message/${q.ID}`)).json()).Text as string).replace(/\r\n/g, "\n");
    assert.match(text, /^sì \/ no\n\nAnswer: http:\/\/127\.0\.0\.1:\d+\/r\/[A-Za-z0-9_-]{22}\n$/);
    const link = /Answer: (\S+)/.exec(text)![1];
    assert.equal((await raw(t.pageURL, new URL(link).pathname)).status, 200);
    assert.equal(f.gs.resumes.length, 0);
    assert.equal((await raw(t.pageURL, new URL(link).pathname, "POST", "choice=1")).status, 200);
    await until("the resume", () => f.gs.resumes.length === 1);
    assert.deepEqual([f.gs.resumes[0].body.choice, f.gs.resumes[0].body.by, f.gs.resumes[0].body.channel], ["no", "alice", "page"]);

    // An image: an attachment beside the text, which stays text/plain.
    await ok(t, "send", { to: "alice", title: `Con immagine ${run}`, text: "Il testo resta testo.\n<b>non è HTML</b>", image: f.gs.ref("schermata della prova.png", PNG), channels: ["email"] });
    let im: any;
    await until("the mail with the image", async () => Boolean((im = (await mails()).find((x) => x.Subject === `Con immagine ${run}`))));
    const withImage = await (await fetch(`${MAILPIT}/api/v1/message/${im.ID}`)).json();
    assert.equal(withImage.Text.replace(/\r\n/g, "\n"), "Il testo resta testo.\n<b>non è HTML</b>\n");
    assert.equal(withImage.HTML, "");
    assert.deepEqual(withImage.Attachments.map((x: any) => [x.FileName, x.ContentType, x.Size]), [["schermata-della-prova.png", "image/png", PNG.length]]);
    const part = Buffer.from(await (await fetch(`${MAILPIT}/api/v1/message/${im.ID}/part/${withImage.Attachments[0].PartID}`)).arrayBuffer());
    assert.equal(sha256(part), sha256(PNG));
  } finally {
    await t.close();
  }
  // A wrong password: the server's refusal, and no password in it.
  const u = await startApp(real(f, run), { secrets: { ...SECRETS, smtp_user: SMTP_USER, smtp_password: "wrong-password-0" } });
  try {
    const e = await refused(u, "send", { to: "alice", title: "x", channels: ["email"] });
    assert.match(e, /^nothing went: alice\/email: email: EAUTH 535/);
    assert.ok(!e.includes("wrong-password-0") && !e.includes(SMTP_PASS));
  } finally {
    await u.close();
  }
}
