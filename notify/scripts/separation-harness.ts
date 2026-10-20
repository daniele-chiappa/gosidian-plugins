// The harness of separation-test.sh: a fake Telegram Bot API (8081), a
// fake gosidian (8082: its resume address, and its file tickets for the
// images) and a host outside the preset (8083) that counts every request it
// gets; calls of send, ask and cancel through MCP to the plugin as it runs
// in production, beside a real ntfy (without attachments) and a real
// Mailpit; the answers from the reply page and from Telegram's buttons. It
// checks that the destinations come only from the preset, that the plugin
// calls no host but the preset's (the links it is given, the resume_url of
// another host, an image's url of another host), that an image goes as a
// photo, an attachment by email, without it on an ntfy that takes none,
// that a GET decides nothing and a press of someone not allowed counts for
// nothing, and that no secret is in any output. It writes the reply page's
// tokens and the file tickets it saw to /out/tokens, for the script to look
// for in the logs and the state; it exits non-zero if something failed.
import http from "node:http";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fakeGosidian, fakeTelegram, PNG, sha256, sleep, until } from "../test/helpers.ts";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};
const BOT = env("SEP_BOT");
const NTFY_TOKEN = env("SEP_NTFY_TOKEN");
const SMTP_PASS = env("SEP_SMTP_PASS");
const KEY = env("SEP_KEY");
const TOKEN = "t0k-separation";
const RUN = "sep-1";
const fail: string[] = [];
const report = (line: string) => console.log(line);
const expect = (what: string, ok: boolean, got: unknown) => {
  report(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `: ${JSON.stringify(got)?.slice(0, 400)}`}`);
  if (!ok) fail.push(what);
};

const tg = await fakeTelegram(BOT, { host: "0.0.0.0", port: 8081, name: "harness" });
const gs = await fakeGosidian({ host: "0.0.0.0", port: 8082, name: "harness" });
const outside: string[] = [];
const out = http.createServer((req, res) => {
  outside.push(`${req.method} ${req.url}`);
  res.writeHead(200).end("outside");
});
await new Promise<void>((ok) => out.listen(8083, "0.0.0.0", ok));

for (let i = 0; i < 120; i++) {
  try {
    if ((await fetch("http://notify:8000/health")).ok) break;
  } catch {
    // not up yet
  }
  await sleep(500);
}
const c = new Client({ name: "separation-test", version: "0" });
await c.connect(new StreamableHTTPClientTransport(new URL("http://notify:8000/mcp"), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
const outputs: string[] = [];
const call = async (name: string, args: Record<string, unknown>, project = "sep") => {
  const r: any = await c.callTool({ name, arguments: args, _meta: { "gosidian/project": project, "gosidian/run": RUN } }, undefined, { timeout: 60_000 });
  outputs.push(JSON.stringify(r));
  return r;
};
const resume = `http://harness:8082/api/v1/runs/${RUN}/resume?key=${KEY}`;

// 1. The manifest: the preset's hosts only (gosidian's among them, for the
// files too), the files a pipeline hands it, no secret.
const man: any = (await c.callTool({ name: "gosidian_manifest", arguments: {} })).structuredContent;
outputs.push(JSON.stringify(man));
expect("the manifest reads files; its network is the preset's channels and gosidian", JSON.stringify(man.permissions) === JSON.stringify({ files: true, network: ["harness:8081", "ntfy:80", "mailpit:1025", "harness:8082"] }), man.permissions);
expect("send and ask take an image by reference", JSON.stringify(man.nodes.map((n: any) => [n.name, n.files ?? null, n.file_refs ?? null])) === JSON.stringify([["send", ["image"], true], ["ask", ["image"], true], ["cancel", null, null]]), man.nodes);

// 2. Destinations only from the preset; no address, no link out.
for (const [to, why] of [
  ["alice@example.com", /is not a person/],
  ["-1001234567890", /is not a person/],
  ["http://harness:8083/hook", /is not a person/],
  ["@nobody", /no group nobody/],
  ["#team/unknown", /the room team has no topic unknown/],
] as const) {
  const r = await call("send", { to, title: "x" });
  expect(`to ${to} refused`, r.isError && why.test(r.content[0].text), r.content?.[0]?.text);
}
const cred = await call("send", { to: "alice", title: "x", link: "http://user:pw@harness:8083/" });
expect("a link with credentials refused", cred.isError && /no credentials/.test(cred.content[0].text), cred.content?.[0]?.text);
const away = await call("ask", { to: "alice", title: "x", choices: ["a", "b"], resume_url: `http://harness:8083/api/v1/runs/${RUN}/resume?key=${KEY}` });
expect("a resume_url of another host refused", away.isError && /not an address of gosidian's/.test(away.content[0].text), away.content?.[0]?.text);
// An image's url names gosidian only: one of another host is not fetched.
const tickets: string[] = [];
const handed = (name: string, data: Buffer) => {
  const r = gs.ref(name, data);
  tickets.push(gs.ticketOf(r));
  return r;
};
const elsewhere = handed("shot.png", PNG);
const far = await call("send", { to: "alice", title: "x", image: { ...elsewhere, url: elsewhere.url.replace("harness:8082", "harness:8083") } });
expect("an image's url of another host refused", far.isError && /not an address of gosidian's/.test(far.content[0].text), far.content?.[0]?.text);
const svg = await call("send", { to: "alice", title: "x", image: handed("logo.png", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")) });
expect("a file that is not an image refused, by its bytes", svg.isError && /not a PNG, JPEG, WebP or GIF image/.test(svg.content[0].text), svg.content?.[0]?.text);

// 3. A notice to a person and a room's topic, with a link the plugin must
// not open.
await until("the plugin's first getUpdates", () => tg.of("getUpdates").length > 0, 90_000);
const sent = await call("send", { to: ["alice", "#team/agents"], title: "Run failed", text: "<b>step 3</b> of pipelines/import", link: "http://harness:8083/should-not-be-fetched", priority: "high" });
report(`--- send: ${sent.content?.[0]?.text}`);
expect("send: 5 sent (alice's three channels, the room's two)", sent.structuredContent?.counts?.sent === 5, sent.structuredContent);
const msgs = tg.of("sendMessage").map((x) => x.body);
expect("Telegram: the person's chat and the room's topic", JSON.stringify(msgs.map((m) => [m.chat_id, m.message_thread_id ?? null]).sort()) === JSON.stringify([[-1001234567890, 15], [111111111, null]]), msgs);
expect("Telegram: no parse_mode", msgs.every((m) => m.parse_mode === undefined && m.text.includes("<b>step 3</b>")), msgs);
const ntfy = async (topic: string) =>
  (await (await fetch(`http://ntfy/${topic}/json?poll=1`, { headers: { authorization: `Bearer ${NTFY_TOKEN}` } })).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.event === "message");
const na = await ntfy("notify-sep-alice");
expect("ntfy: alice's message, priority high", na.length === 1 && na[0].priority === 4 && na[0].title === "Run failed", na);
const mails = async () => ((await (await fetch("http://mailpit:8025/api/v1/messages?limit=100")).json()).messages ?? []) as any[];
await until("alice's mail", async () => (await mails()).some((m) => m.Subject === "[high] Run failed"), 20_000).catch(() => undefined);
const m1 = (await mails()).find((m) => m.Subject === "[high] Run failed");
expect("email: alice's, plain text", Boolean(m1), await mails());

// 3b. An image: a photo on Telegram, an attachment by email; this ntfy
// takes no attachments: its message without it, said.
const shot = handed("preview check.png", PNG);
const pic = await call("send", { to: ["alice", "#team/agents"], title: "Preview ready", text: "7 steps of 7", image: shot });
report(`--- send with an image: ${pic.content?.[0]?.text}`);
const ent = (pic.structuredContent?.sent ?? []) as any[];
expect("the image fetched once, from gosidian", gs.fetched.filter((t) => t === gs.ticketOf(shot)).length === 1, gs.fetched);
expect("send with an image: 5 sent", pic.structuredContent?.counts?.sent === 5, pic.structuredContent);
expect("Telegram and email: the image sent", ent.filter((e) => e.channel !== "ntfy").every((e) => e.image === "sent") && ent.filter((e) => e.channel !== "ntfy").length === 3, ent);
expect("ntfy without attachments: the message without the image, said", ent.filter((e) => e.channel === "ntfy").every((e) => e.image === "dropped" && /takes no attachments/.test(e.note)), ent);
const photos = tg.of("sendPhoto");
expect("Telegram: photos uploaded, the bytes the image's, the text the caption", photos.length === 2 && photos.every((p) => p.file && sha256(p.file.data) === sha256(PNG) && p.body.caption === "Preview ready\n\n7 steps of 7"), photos.map((p) => p.body));
await until("alice's mail with the image", async () => (await mails()).some((m) => m.Subject === "Preview ready"), 20_000).catch(() => undefined);
const mi = (await mails()).find((m) => m.Subject === "Preview ready");
const mfull = mi ? await (await fetch(`http://mailpit:8025/api/v1/message/${mi.ID}`)).json() : {};
expect("email: the image attached, the text plain", mfull.Attachments?.[0]?.FileName === "preview-check.png" && mfull.Attachments?.[0]?.Size === PNG.length && mfull.HTML === "", mfull.Attachments);

// 4. A question to alice and bob: the reply page, Telegram's buttons.
const q = await call("ask", { to: ["alice", "bob"], title: "Merge the PR?", choices: ["approve", "reject"], resume_url: resume });
report(`--- ask: ${q.content?.[0]?.text}`);
expect("ask: alice and bob can answer", JSON.stringify(q.structuredContent?.can_answer) === JSON.stringify(["alice", "bob"]), q.structuredContent);
const tokens: string[] = [];
const qa = (await ntfy("notify-sep-alice")).at(-1);
const answerA = qa?.actions?.find((a: any) => a.label === "Answer")?.url ?? "";
expect("ntfy: the action Answer at the plugin's public_url", /^http:\/\/notify:8080\/r\/[A-Za-z0-9_-]{22}$/.test(answerA), qa);
tokens.push(answerA.split("/r/")[1] ?? "");
let mailB: any;
await until("bob's question by mail", async () => Boolean((mailB = (await mails()).find((m) => m.Subject === "Merge the PR?" && m.To?.[0]?.Address === "bob@example.com"))), 20_000).catch(() => undefined);
const textB = mailB ? (await (await fetch(`http://mailpit:8025/api/v1/message/${mailB.ID}`)).json()).Text : "";
const answerB = /Answer: (\S+)/.exec(textB)?.[1] ?? "";
tokens.push(answerB.split("/r/")[1] ?? "");
expect("email: bob's own link", /^http:\/\/notify:8080\/r\/[A-Za-z0-9_-]{22}$/.test(answerB) && answerB !== answerA, textB);
// A request that fails is a status 0, and the checks after say what failed.
const get = async (url: string, init?: RequestInit) => {
  try {
    const r = await fetch(url, init);
    return { status: r.status, headers: r.headers, text: await r.text() };
  } catch (e) {
    return { status: 0, headers: new Headers(), text: String(e) };
  }
};
const g = await get(answerA);
const page = g.text;
expect("GET the page: the question, alice, the buttons", g.status === 200 && page.includes("Answering as alice") && page.includes('name="choice" value="0"'), page.slice(0, 300));
expect("GET the page: no-store, noindex, a CSP without scripts", g.headers.get("cache-control") === "no-store" && g.headers.get("x-robots-tag")?.startsWith("noindex") === true && /^default-src 'none';/.test(g.headers.get("content-security-policy") ?? ""), Object.fromEntries(g.headers));
await sleep(300);
expect("a GET decides nothing", gs.resumes.length === 0, gs.resumes);
// Telegram: a press by carol (not asked) on alice's message, then alice's.
const toAlice = tg.of("sendMessage").find((x) => x.body.chat_id === 111111111 && x.body.reply_markup);
const ref = { chat: 111111111, message_id: toAlice?.result?.message_id ?? 0 };
const qid = q.structuredContent?.id;
const carol = tg.press(333333333, ref, `a:${qid}:0`);
await until("carol's press answered", () => tg.of("answerCallbackQuery").some((x) => x.body.callback_query_id === carol), 30_000).catch(() => undefined);
const ca = tg.of("answerCallbackQuery").find((x) => x.body.callback_query_id === carol)?.body;
expect("Telegram: a press by someone not allowed, an alert", ca?.show_alert === true && ca?.text === "You cannot answer this question.", ca);
expect("Telegram: it decided nothing", gs.resumes.length === 0, gs.resumes);
const alice = tg.press(111111111, ref, `a:${qid}:0`);
await until("the resume", () => gs.resumes.length === 1, 30_000).catch(() => undefined);
expect("the answer POSTed to resume_url", JSON.stringify({ ...gs.resumes[0]?.body, at: "-" }) === JSON.stringify({ choice: "approve", choices: { approve: true, reject: false }, by: "alice", channel: "telegram", at: "-" }) && gs.resumes[0]?.key === KEY, gs.resumes);
expect("alice's press: recorded", tg.of("answerCallbackQuery").find((x) => x.body.callback_query_id === alice)?.body.text === "Recorded: approve. Thank you.", tg.of("answerCallbackQuery"));
await until("the buttons become the outcome", () => tg.of("editMessageReplyMarkup").length === 2, 10_000).catch(() => undefined);
expect("the buttons became the outcome", tg.of("editMessageReplyMarkup").every((x) => x.body.reply_markup.inline_keyboard[0][0].text === "approve: alice"), tg.of("editMessageReplyMarkup"));
const pb = await get(answerB, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "choice=1" });
const pbText = pb.text;
expect("bob's answer after: already decided by alice", pb.status === 409 && pbText.includes("Already decided by alice: approve."), pbText.slice(0, 300));
expect("one resume only", gs.resumes.length === 1, gs.resumes);

// 5. A question to a room, with an image, withdrawn: its buttons on the photo.
const r = await call("ask", { to: "#team/agents", approvers: ["alice"], title: "Deploy?", choices: ["yes", "no"], resume_url: resume, image: handed("deploy.png", PNG) });
const rp = tg.of("sendPhoto").at(-1);
expect("a question's photo carries its buttons", rp?.body.reply_markup?.inline_keyboard?.[0]?.length === 2 && rp?.body.message_thread_id === 15, rp?.body);
const cancel = await call("cancel", { id: r.structuredContent?.id });
expect("cancel withdraws it", cancel.structuredContent?.canceled === true, cancel.structuredContent);
await until("its buttons say so", () => tg.of("editMessageReplyMarkup").some((x) => x.body.reply_markup.inline_keyboard[0][0].text === "Withdrawn"), 10_000).catch(() => undefined);
expect("its buttons say withdrawn, on the photo", tg.of("editMessageReplyMarkup").some((x) => x.body.reply_markup.inline_keyboard[0][0].text === "Withdrawn" && x.body.message_id === rp?.result?.message_id), tg.of("editMessageReplyMarkup"));
const other = await call("cancel", { id: q.structuredContent?.id }, "another-project");
expect("another project's cancel: unknown", other.structuredContent?.status === "unknown", other.structuredContent);

// 6. No secret in any output; nothing reached the host outside.
const all = outputs.join("\n");
for (const [what, v] of [["the bot's token", BOT], ["the bot token's secret part", BOT.split(":")[1]], ["ntfy's token", NTFY_TOKEN], ["the SMTP password", SMTP_PASS], ["the resume key", KEY], ...tokens.map((t, i) => [`page token ${i}`, t]), ...tickets.map((t, i) => [`file ticket ${i}`, t])]) {
  expect(`${what}: in no output`, Boolean(v) && !all.includes(v), v);
}
await sleep(500);
expect("the plugin called no host outside the preset (the links it was given, an image's url)", outside.length === 0, outside);
fs.writeFileSync("/out/tokens", [...tokens, ...tickets].filter(Boolean).join("\n") + "\n");

await c.close();
await tg.close();
await gs.close();
out.close();
if (fail.length) {
  console.error(`FAIL:\n  ${fail.join("\n  ")}`);
  process.exit(1);
}
console.log("ok: the destinations the preset's, no host but the preset's, the images from gosidian only, a GET decides nothing, only the people allowed answer, no secret in an output");
