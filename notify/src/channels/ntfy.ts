// ntfy: a POST of JSON to the server's root, to the person's topic or the
// room's, with the access token of a file. The message is plain (no
// markdown), its priority ntfy's own (low 2, normal 3, high 4, urgent 5);
// a link opens on a tap; a question's reply page is the action Answer. The
// posts go one at a time: ntfy 2.28 answers some of a token's concurrent
// posts 403, as if the token were not valid.
import type { NtfyConfig, Preset, Priority } from "../preset.ts";
import { capBytes, fill } from "../text.ts";
import { redact } from "../secrets.ts";
import { causeOf, ChannelError, lines, tryTwice, type Channel, type Dest, type Outgoing, type Sent } from "./channel.ts";

const PRIORITY: Record<Priority, number> = { low: 2, normal: 3, high: 4, urgent: 5 };
const TIMEOUT = 15_000;

export class Ntfy implements Channel {
  readonly name = "ntfy" as const;
  private readonly cfg: NtfyConfig;
  private readonly token: string;
  private readonly preset: Preset;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(preset: Preset, token: string) {
    this.cfg = preset.channels.ntfy!;
    this.token = token;
    this.preset = preset;
  }

  reaches(d: Dest): boolean {
    return d.kind === "person" ? Boolean(d.person.ntfy) : Boolean(d.room.ntfy);
  }

  // topicOf is the ntfy topic of a destination; a room's topic without one
  // of its own goes to the room's, tagged with its name.
  topicOf(d: Dest): { topic: string; tag?: string } {
    if (d.kind === "person") return { topic: d.person.ntfy! };
    const n = d.room.ntfy!;
    if (!d.topic) return { topic: n.topic };
    const own = n.topics[d.topic.toLowerCase()];
    return own ? { topic: own } : { topic: n.topic, tag: d.topic };
  }

  async send(o: Outgoing, signal?: AbortSignal): Promise<Sent> {
    const { topic, tag } = this.topicOf(o.dest);
    const s = this.preset.strings;
    const answer = o.question?.answer_url;
    // The link and the answer's always fit: the text is cut first.
    const tail = lines(o.link, answer ? fill(s.answer_at, { url: answer }) : "");
    const room = this.preset.limits.text.ntfy - Buffer.byteLength(tail) - 2;
    let message = lines(o.text ? capBytes(o.text, Math.max(room, 16)) : "", tail);
    let title = o.title;
    if (!message) {
      message = title;
      title = "";
    }
    const actions = [
      ...(answer ? [{ action: "view", label: s.answer, url: answer, clear: true }] : []),
      ...(o.link ? [{ action: "view", label: s.open_link, url: o.link }] : []),
    ];
    const body = {
      topic,
      message,
      ...(title ? { title } : {}),
      priority: PRIORITY[o.priority],
      ...(tag ? { tags: [tag] } : {}),
      ...(answer || o.link ? { click: answer ?? o.link } : {}),
      ...(actions.length ? { actions } : {}),
    };
    const run = this.queue.then(() => tryTwice(() => this.post(body, signal)));
    this.queue = run.catch(() => undefined);
    await run;
    return {};
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT);
    let r: Response;
    try {
      r = await fetch(`${this.cfg.server}/`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(body),
        signal: sig,
        redirect: "error",
      });
    } catch (e) {
      throw new ChannelError(`ntfy: ${causeOf(e)}`, { retry: causeOf(e) !== "canceled" });
    }
    if (r.ok) {
      await r.arrayBuffer().catch(() => undefined);
      return;
    }
    let why = "";
    try {
      const j: any = await r.json();
      why = typeof j?.error === "string" ? `: ${j.error}` : "";
    } catch {
      // not JSON
    }
    const msg = redact(`ntfy answered ${r.status}${why}`).slice(0, 300);
    if (r.status === 429 || r.status >= 500) throw new ChannelError(msg, { retry: true, after: Number(r.headers.get("retry-after")) || 1 });
    throw new ChannelError(msg);
  }
}
