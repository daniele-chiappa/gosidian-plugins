// Telegram: the Bot API over plain HTTPS, no SDK. A message goes to a
// person's private chat with the bot (their user id) or to a room's group,
// in one of its forum topics (message_thread_id). The group is always the
// preset's: a node names a topic, at most, and with auto_topics the bot
// makes the topic the first time (createForumTopic), its id kept on the
// volume. No parse_mode: the text is shown as it is. A question has inline
// buttons; their presses come with getUpdates (long polling: a bot has one
// consumer of its updates), and once it is decided its buttons become the
// outcome.
import type { Preset, Priority, TelegramConfig } from "../preset.ts";
import type { Store } from "../store.ts";
import { capUnits, fill } from "../text.ts";
import { redact } from "../secrets.ts";
import { causeOf, ChannelError, lines, tryTwice, type Channel, type Dest, type Outgoing, type Sent } from "./channel.ts";

const TIMEOUT = 15_000;
const UPDATES = ["callback_query", "message", "my_chat_member"];

export interface CallbackQuery {
  id: string;
  from: { id: number; username?: string };
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}

export class TelegramError extends ChannelError {
  readonly code: number;
  readonly description: string;
  constructor(method: string, code: number, description: string, after = 0) {
    super(redact(`telegram ${method}: ${code} ${description}`).slice(0, 300), { retry: code === 429 || code >= 500, after });
    this.code = code;
    this.description = description;
  }
}

// keyboard is a question's buttons, one row of its choices: the data names
// the question and the choice's index, 64 bytes at most.
export function keyboard(id: string, choices: string[]): { text: string; callback_data: string }[][] {
  return [choices.map((c, i) => ({ text: c, callback_data: `a:${id}:${i}` }))];
}

export class Telegram implements Channel {
  readonly name = "telegram" as const;
  private readonly cfg: TelegramConfig;
  private readonly preset: Preset;
  private readonly token: string;
  private readonly store: Store;
  private readonly log: (msg: string, f?: Record<string, unknown>) => void;
  private readonly onCallback: (cq: CallbackQuery) => Promise<void>;
  private readonly making = new Map<string, Promise<number>>();
  private readonly stop = new AbortController();
  private loop?: Promise<void>;

  constructor(o: {
    preset: Preset;
    token: string;
    store: Store;
    log: (msg: string, f?: Record<string, unknown>) => void;
    onCallback: (cq: CallbackQuery) => Promise<void>;
  }) {
    this.preset = o.preset;
    this.cfg = o.preset.channels.telegram!;
    this.token = o.token;
    this.store = o.store;
    this.log = o.log;
    this.onCallback = o.onCallback;
  }

  get polling(): boolean {
    return this.cfg.poll;
  }

  reaches(d: Dest): boolean {
    return d.kind === "person" ? d.person.telegram !== undefined : Boolean(d.room.telegram);
  }

  // api calls a method of the Bot API. The token is in the address: no
  // error says the address.
  async api<T = any>(method: string, body: Record<string, unknown>, signal?: AbortSignal, timeout = TIMEOUT): Promise<T> {
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    let r: Response;
    try {
      r = await fetch(`${this.cfg.api_url}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: sig,
        redirect: "error",
      });
    } catch (e) {
      throw new ChannelError(`telegram ${method}: ${causeOf(e)}`, { retry: causeOf(e) !== "canceled" });
    }
    let j: any;
    try {
      j = await r.json();
    } catch {
      throw new TelegramError(method, r.status, "the answer is not JSON");
    }
    if (!j?.ok) throw new TelegramError(method, Number(j?.error_code) || r.status, String(j?.description ?? ""), Number(j?.parameters?.retry_after) || 0);
    return j.result as T;
  }

  // where is the chat and the topic of a destination. A topic the room's
  // Telegram does not have (one of its ntfy topics, or past
  // max_auto_topics) goes to the group's General topic, named in the text.
  async where(d: Dest, signal?: AbortSignal): Promise<{ chat: number; thread?: number; tag?: string; made?: boolean }> {
    if (d.kind === "person") return { chat: d.person.telegram! };
    const t = d.room.telegram!;
    if (!d.topic) return { chat: t.chat };
    const k = d.topic.toLowerCase();
    if (Object.hasOwn(t.topics, k)) return { chat: t.chat, thread: t.topics[k] };
    const made = this.store.data.topics[d.room.name]?.[k];
    if (made) return { chat: t.chat, thread: made.id, made: true };
    if (!t.auto_topics) return { chat: t.chat, tag: d.topic };
    if (Object.keys(this.store.data.topics[d.room.name] ?? {}).length >= t.max_auto_topics) {
      this.log("telegram: the room has as many topics made by the bot as max_auto_topics: to General", { room: d.room.name, topic: d.topic });
      return { chat: t.chat, tag: d.topic };
    }
    return { chat: t.chat, thread: await this.makeTopic(d.room.name, t.chat, d.topic, signal), made: true };
  }

  // makeTopic makes a topic in the room's group once, however many sends
  // ask for it at the same time.
  private makeTopic(room: string, chat: number, name: string, signal?: AbortSignal): Promise<number> {
    const k = `${room}\u0000${name.toLowerCase()}`;
    let p = this.making.get(k);
    if (!p) {
      p = (async () => {
        const r = await tryTwice(() => this.api<{ message_thread_id: number }>("createForumTopic", { chat_id: chat, name }, signal));
        (this.store.data.topics[room] ??= {})[name.toLowerCase()] = { id: r.message_thread_id, name };
        this.store.save();
        this.log("telegram: topic made", { room, topic: name, thread: r.message_thread_id });
        return r.message_thread_id;
      })().finally(() => this.making.delete(k));
      this.making.set(k, p);
    }
    return p;
  }

  private text(o: Outgoing, tag?: string): string {
    const s = this.preset.strings;
    const label = o.priority === "urgent" ? s.urgent : o.priority === "high" ? s.high : "";
    const head = [label, tag ? `[${tag}]` : "", o.title].filter(Boolean).join(" ");
    const answer = o.question && !o.question.buttons && o.question.answer_url ? fill(s.answer_at, { url: o.question.answer_url }) : "";
    const tail = lines(o.link, answer);
    const limit = this.preset.limits.text.telegram;
    const room = limit - head.length - tail.length - 4;
    return capUnits(lines(head, o.text ? capUnits(o.text, Math.max(room, 16)) : "", tail), limit) || "…";
  }

  async send(o: Outgoing, signal?: AbortSignal): Promise<Sent> {
    let w = await this.where(o.dest, signal);
    const body = (): Record<string, unknown> => ({
      chat_id: w.chat,
      text: this.text(o, w.tag),
      ...(w.thread ? { message_thread_id: w.thread } : {}),
      link_preview_options: { is_disabled: true },
      ...(silent(o.priority) ? { disable_notification: true } : {}),
      ...(o.question?.buttons ? { reply_markup: { inline_keyboard: keyboard(o.question.id, o.question.choices) } } : {}),
    });
    let m: { message_id: number };
    try {
      m = await tryTwice(() => this.api("sendMessage", body(), signal));
    } catch (e) {
      // A topic the bot made, closed or deleted in the group since: made
      // again, once.
      if (!(w.made && e instanceof TelegramError && /thread not found|topic_deleted|TOPIC_DELETED/i.test(e.description)) || o.dest.kind !== "room") throw e;
      const room = o.dest.room.name;
      delete this.store.data.topics[room]?.[o.dest.topic!.toLowerCase()];
      this.store.save();
      this.log("telegram: a topic the bot made is gone: made again", { room, topic: o.dest.topic });
      w = await this.where(o.dest, signal);
      m = await tryTwice(() => this.api("sendMessage", body(), signal));
    }
    return { telegram: { chat: w.chat, message_id: m.message_id } };
  }

  // outcome turns a question's buttons into one that says how it ended;
  // pressed, it says it again.
  async outcome(ref: { chat: number; message_id: number }, id: string, label: string): Promise<void> {
    try {
      await this.api("editMessageReplyMarkup", {
        chat_id: ref.chat,
        message_id: ref.message_id,
        reply_markup: { inline_keyboard: [[{ text: capUnits(label, 60), callback_data: `d:${id}` }]] },
      });
    } catch (e) {
      if (e instanceof TelegramError && /not modified/i.test(e.description)) return;
      this.log("telegram: the buttons of a question did not change", { question: id, error: (e as Error).message });
    }
  }

  async answerCallback(id: string, text: string, alert: boolean): Promise<void> {
    try {
      await this.api("answerCallbackQuery", { callback_query_id: id, text: capUnits(text, 200), show_alert: alert });
    } catch (e) {
      this.log("telegram: answerCallbackQuery failed", { error: (e as Error).message });
    }
  }

  // start takes the bot's updates, until close.
  start(): void {
    if (!this.cfg.poll || this.loop) return;
    this.loop = this.poll();
  }

  private async poll(): Promise<void> {
    let backoff = 1;
    while (!this.stop.signal.aborted) {
      try {
        const offset = this.store.data.telegram_offset;
        const updates = await this.api<any[]>("getUpdates", { ...(offset ? { offset } : {}), timeout: this.cfg.poll_timeout, allowed_updates: UPDATES }, this.stop.signal, (this.cfg.poll_timeout + 15) * 1000);
        backoff = 1;
        for (const u of updates) {
          this.store.data.telegram_offset = Math.max(this.store.data.telegram_offset, Number(u.update_id) + 1);
          try {
            await this.update(u);
          } catch (e) {
            this.log("telegram: an update failed", { update: u.update_id, error: redact((e as Error).message) });
          }
        }
        if (updates.length) this.store.save();
      } catch (e) {
        if (this.stop.signal.aborted) break;
        const conflict = e instanceof TelegramError && e.code === 409;
        this.log(conflict ? "telegram: another consumer takes this bot's updates (a second plugin with the same bot, or a webhook): the buttons answer only one" : "telegram: getUpdates failed", { error: (e as Error).message });
        await sleep(conflict ? 30 : backoff, this.stop.signal);
        backoff = Math.min(backoff * 2, 60);
      }
    }
  }

  private async update(u: any): Promise<void> {
    if (u.callback_query) return this.onCallback(u.callback_query as CallbackQuery);
    // Who wrote to the bot and where, for whoever writes the preset: the ids
    // only, never the text.
    const m = u.message ?? u.my_chat_member;
    if (m?.chat) {
      this.log(u.message ? "telegram: a message to the bot" : "telegram: the bot's membership changed", {
        user_id: m.from?.id ?? null,
        username: m.from?.username ?? null,
        chat_id: m.chat.id,
        chat_type: m.chat.type ?? null,
        chat_title: m.chat.title ?? null,
        thread_id: m.message_thread_id ?? null,
        ...(u.my_chat_member ? { status: u.my_chat_member.new_chat_member?.status ?? null } : {}),
      });
    }
  }

  async close(): Promise<void> {
    this.stop.abort();
    await this.loop?.catch(() => undefined);
  }
}

export function silent(p: Priority): boolean {
  return p === "low";
}

function sleep(s: number, signal: AbortSignal): Promise<void> {
  return new Promise((ok) => {
    const t = setTimeout(ok, s * 1000);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      ok();
    }, { once: true });
  });
}
