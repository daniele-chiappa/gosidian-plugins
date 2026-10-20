// The questions of the ask node: a choice of 2 to 4, put to people (or to
// a room, where its approvers answer), until it expires. Telegram's buttons
// count only a press of a person allowed, by the user id of the preset; on
// ntfy and email a person gets a link to the reply page with a token of
// their own (128 bits, one a person and question, kept as a hash). The
// first valid answer decides: the plugin POSTs it to the run's resume_url
// (gosidian's, at gosidian_api), trying again while gosidian is not there
// or the run does not wait yet; every other answer finds it decided.
import { channelsOf, later, type Env } from "./dispatch.ts";
import type { Question, Resume } from "./store.ts";
import { fill } from "./text.ts";
import { redact } from "./secrets.ts";
import type { ChannelName } from "./preset.ts";
import type { Dest, Outgoing } from "./channels/channel.ts";
import type { CallbackQuery } from "./channels/telegram.ts";
import type { Image } from "./image.ts";

// What stays of a question once it is closed: its page says how it ended.
const KEEP_CLOSED = 86400_000;
const RESUME_TIMEOUT = 15_000;
const MAX_ATTEMPTS = 40;

// questionOutgoing is what a destination gets of a question: a person who
// may answer, a link with their own token when a channel of theirs needs
// it; Telegram's buttons in a room and for a person who may answer. Its
// image is the node's (image), or, for a question held, the one kept on
// the volume.
export function questionOutgoing(env: Env, q: Question, d: Dest, only?: ChannelName[], image?: Image): Omit<Outgoing, "dest"> {
  const buttons = Boolean(env.telegram?.polling);
  const may = d.kind === "room" || q.allowed.includes(d.person.name);
  let answer_url: string | undefined;
  if (d.kind === "person" && may && env.preset.public_url) {
    const chans = channelsOf(env, d, only);
    if (chans.includes("ntfy") || chans.includes("email") || (chans.includes("telegram") && !buttons)) {
      answer_url = `${env.preset.public_url}/r/${env.store.token(q, d.person.name)}`;
    }
  }
  let img = image;
  if (!img && q.image) {
    img = env.store.image(q.image);
    if (!img) env.log("the image of a held question is not on the volume: it goes without", { question: q.id, to: d.key });
  }
  return {
    title: q.title,
    text: q.text,
    link: q.link,
    priority: q.priority,
    question: { id: q.id, choices: q.choices, ...(answer_url ? { answer_url } : {}), buttons: buttons && may },
    ...(img ? { image: img } : {}),
  };
}

// answerers are the people of a question who have a way to answer it: a
// channel of their own that carries their link or the buttons, or a room's
// Telegram where their user id is known.
export function answerers(env: Env, q: Question, dests: Dest[], only?: ChannelName[]): string[] {
  const buttons = Boolean(env.telegram?.polling);
  const roomTelegram = dests.some((d) => d.kind === "room" && channelsOf(env, d, only).includes("telegram"));
  return q.allowed.filter((name) => {
    const p = env.preset.people[name];
    const own = dests.find((d) => d.kind === "person" && d.person.name === name);
    if (own) {
      const chans = channelsOf(env, own, only);
      if (chans.includes("telegram") && (buttons || env.preset.public_url)) return true;
      if ((chans.includes("ntfy") || chans.includes("email")) && env.preset.public_url) return true;
    }
    return buttons && roomTelegram && p.telegram !== undefined;
  });
}

export function outcomeText(env: Env, q: Question): string {
  const s = env.preset.strings;
  if (q.status === "decided") return fill(s.outcome, { choice: q.decision!.choice, person: q.decision!.by });
  if (q.status === "expired") return s.outcome_expired;
  if (q.status === "canceled") return s.outcome_withdrawn;
  return "";
}

// statusText is what a person who answers a question no longer open reads.
export function statusText(env: Env, q: Question): string {
  const s = env.preset.strings;
  if (q.status === "decided") return fill(s.decided, { person: q.decision!.by, choice: q.decision!.choice });
  if (q.status === "expired") return s.expired;
  if (q.status === "canceled") return s.withdrawn;
  return "";
}

// buttonsOutcome turns the Telegram buttons of a closed question into its
// outcome, in the background.
function buttonsOutcome(env: Env, q: Question): void {
  const tg = env.telegram;
  if (!tg || !q.telegram.length) return;
  const label = outcomeText(env, q);
  later(env, Promise.all(q.telegram.map((ref) => tg.outcome(ref, q.id, label))));
}

// close ends a question that is open: expired or withdrawn.
export function close(env: Env, q: Question, status: "expired" | "canceled"): void {
  q.status = status;
  q.closed = env.now();
  env.store.data.held = env.store.data.held.filter((h) => h.question !== q.id);
  env.store.save();
  env.log(status === "expired" ? "question expired" : "question withdrawn", { question: q.id, project: q.project });
  buttonsOutcome(env, q);
}

export type Outcome = { ok: true; choice: string } | { ok: false; status: Question["status"]; text: string };

// decide records the first valid answer and hands it to gosidian; a
// question closed (decided, expired, withdrawn) says how.
export function decide(env: Env, q: Question, person: string, index: number, channel: "telegram" | "page"): Outcome {
  if (q.status === "open" && q.expires <= env.now()) close(env, q, "expired");
  if (q.status !== "open") return { ok: false, status: q.status, text: statusText(env, q) };
  if (!q.allowed.includes(person) || !Number.isInteger(index) || index < 0 || index >= q.choices.length) {
    return { ok: false, status: q.status, text: env.preset.strings.not_allowed };
  }
  const now = env.now();
  const choice = q.choices[index];
  q.status = "decided";
  q.decision = { choice, index, by: person, channel, at: now };
  q.closed = now;
  env.store.data.held = env.store.data.held.filter((h) => h.question !== q.id);
  const body = JSON.stringify({
    choice,
    choices: Object.fromEntries(q.choices.map((c, i) => [c, i === index])),
    by: person,
    channel,
    at: new Date(now).toISOString(),
  });
  const r: Resume = { question: q.id, body, attempts: 0, next: now };
  env.store.data.outbox.push(r);
  env.store.save();
  env.log("question decided", { question: q.id, project: q.project, run: q.run, choice, by: person, channel });
  buttonsOutcome(env, q);
  later(env, resume(env, r));
  return { ok: true, choice };
}

const sending = new WeakSet<Resume>();

// resume POSTs an answer to gosidian. 2xx: done. 404: the run no longer
// waits (it ended, it was canceled), done. 409: no step waits yet, or more
// than one does: again later, as for a server that is not there; another
// 4xx: done, logged. It stops trying when the question's wait is over.
export async function resume(env: Env, r: Resume): Promise<void> {
  if (sending.has(r)) return;
  sending.add(r);
  try {
    const q = env.store.data.questions[r.question];
    const drop = (msg: string, f: Record<string, unknown> = {}) => {
      env.store.data.outbox = env.store.data.outbox.filter((x) => x !== r);
      env.store.save();
      env.log(msg, { question: r.question, ...f });
    };
    if (!q) return drop("an answer for a question no longer kept: dropped");
    let status = 0;
    let why = "";
    try {
      const res = await fetch(q.resume, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: r.body,
        redirect: "error",
        signal: AbortSignal.timeout(RESUME_TIMEOUT),
      });
      status = res.status;
      why = redact((await res.text().catch(() => "")).slice(0, 200));
    } catch (e) {
      why = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
    }
    if (status >= 200 && status < 300) return drop("run resumed", { run: q.run });
    if (status === 404) return drop("the run no longer waits for this answer", { run: q.run, status });
    if (status && status !== 409 && status !== 429 && status < 500) return drop("gosidian refused the answer", { run: q.run, status, error: why });
    r.attempts++;
    const now = env.now();
    if (r.attempts >= MAX_ATTEMPTS || now > q.expires) return drop("the answer did not reach gosidian: given up", { run: q.run, status: status || null, error: why, attempts: r.attempts });
    r.next = now + Math.min(2 ** r.attempts, 300) * 1000;
    env.store.save();
    env.log("the answer did not reach gosidian: again later", { question: q.id, run: q.run, status: status || null, error: why, attempts: r.attempts });
  } finally {
    sending.delete(r);
  }
}

// sweep expires the questions past their wait, forgets the closed ones a
// day after, and tries again the answers due.
export async function sweep(env: Env): Promise<void> {
  const now = env.now();
  const data = env.store.data;
  for (const q of Object.values(data.questions)) {
    if (q.status === "open" && q.expires <= now) close(env, q, "expired");
    else if (q.status !== "open" && (q.closed ?? q.expires) + KEEP_CLOSED <= now && !data.outbox.some((r) => r.question === q.id)) {
      env.store.forget(q.id);
      env.store.save();
    }
  }
  for (const r of [...data.outbox]) if (r.next <= now) await resume(env, r);
}

// onCallback takes a press of a question's button on Telegram. Only a
// person the question allows counts, known by the user id Telegram gives
// (no one can send another's); the others get an alert, "you cannot
// answer". A press on a question closed says how it ended.
export async function onCallback(env: Env, cq: CallbackQuery): Promise<void> {
  const tg = env.telegram!;
  const s = env.preset.strings;
  const m = /^([ad]):([a-z2-7]{16})(?::([0-3]))?$/.exec(cq.data ?? "");
  const q = m ? env.store.data.questions[m[2]] : undefined;
  const fromMessage = q && cq.message && q.telegram.some((t) => t.chat === cq.message!.chat.id && t.message_id === cq.message!.message_id);
  if (!m || !q || !fromMessage) return tg.answerCallback(cq.id, s.not_found, true);
  if (q.status === "open" && q.expires <= env.now()) close(env, q, "expired");
  if (q.status !== "open") return tg.answerCallback(cq.id, statusText(env, q), true);
  if (m[1] !== "a" || m[3] === undefined) return tg.answerCallback(cq.id, "", false);
  const person = q.allowed.find((n) => env.preset.people[n]?.telegram === cq.from.id);
  if (!person) {
    env.log("telegram: a press by someone the question does not allow", { question: q.id, user_id: cq.from.id });
    return tg.answerCallback(cq.id, s.not_allowed, true);
  }
  const r = decide(env, q, person, Number(m[3]), "telegram");
  await tg.answerCallback(cq.id, r.ok ? fill(s.recorded, { choice: r.choice }) : r.text, !r.ok);
}

// cancel withdraws a question of the project: its tokens die, its buttons
// say so. Another project's is as one that is not there.
export function cancel(env: Env, id: string, project: string): { canceled: boolean; status: string } {
  const q = env.store.data.questions[id];
  if (!q || q.project !== project) return { canceled: false, status: "unknown" };
  if (q.status !== "open") return { canceled: false, status: q.status };
  close(env, q, "canceled");
  return { canceled: true, status: "canceled" };
}
