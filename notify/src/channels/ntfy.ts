// ntfy: a POST of JSON to the server's root, to the person's topic or the
// room's, with the access token of a file. The message is plain (no
// markdown), its priority ntfy's own (low 2, normal 3, high 4, urgent 5);
// a link opens on a tap; a question's reply page is the action Answer. The
// posts go one at a time: ntfy 2.28 answers some of a token's concurrent
// posts 403, as if the token were not valid. A node's image is an
// attachment: a PUT to the topic with its bytes and its name (X-Filename),
// the message's fields in headers (RFC 2047, so UTF-8 passes). A server
// that takes no attachments (no attachment-cache-dir), or not one so big:
// the message goes without it, and the entry says so.
import type { NtfyConfig, Preset, Priority } from "../preset.ts";
import { capBytes, fill } from "../text.ts";
import { redact } from "../secrets.ts";
import { causeOf, ChannelError, lines, tryTwice, type Channel, type Dest, type Outgoing, type Sent } from "./channel.ts";
import type { Image } from "../image.ts";

const PRIORITY: Record<Priority, number> = { low: 2, normal: 3, high: 4, urgent: 5 };
const TIMEOUT = 15_000;
const UPLOAD_TIMEOUT = 120_000;
// ntfy's code for a server without attachments; a server found so is not
// sent one again for an hour.
const NO_ATTACHMENTS = 40014;
const OFF_FOR = 3600_000;

// word is a header's value as RFC 2047 says, in UTF-8: ntfy decodes it.
const word = (s: string) => `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

class NtfyError extends ChannelError {
  readonly status: number;
  readonly code: number;
  constructor(message: string, status: number, code: number, opts: { retry?: boolean; after?: number } = {}) {
    super(message, opts);
    this.status = status;
    this.code = code;
  }
}

interface Body {
  topic: string;
  message: string;
  title?: string;
  priority: number;
  tags?: string[];
  click?: string;
  actions?: Record<string, unknown>[];
}

export class Ntfy implements Channel {
  readonly name = "ntfy" as const;
  private readonly cfg: NtfyConfig;
  private readonly token: string;
  private readonly preset: Preset;
  private queue: Promise<unknown> = Promise.resolve();
  private offUntil = 0;

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
    const body: Body = {
      topic,
      message,
      ...(title ? { title } : {}),
      priority: PRIORITY[o.priority],
      ...(tag ? { tags: [tag] } : {}),
      ...(answer || o.link ? { click: answer ?? o.link } : {}),
      ...(actions.length ? { actions } : {}),
    };
    const run = this.queue.then(() => this.deliver(body, o.image, signal));
    this.queue = run.catch(() => undefined);
    return await run;
  }

  // deliver posts a message, with its image when it has one and the server
  // takes it.
  private async deliver(body: Body, image: Image | undefined, signal?: AbortSignal): Promise<Sent> {
    const plain = () => tryTwice(() => this.request(`${this.cfg.server}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, signal, TIMEOUT));
    if (!image) {
      await plain();
      return {};
    }
    const off = "the ntfy server takes no attachments (its attachment-cache-dir is not set): sent without the image";
    if (this.offUntil > Date.now()) {
      await plain();
      return { image: "dropped", note: off };
    }
    try {
      await tryTwice(() => this.request(`${this.cfg.server}/${encodeURIComponent(body.topic)}`, { method: "PUT", headers: this.headers(body, image), body: new Uint8Array(image.data) }, signal, UPLOAD_TIMEOUT));
      return { image: "sent" };
    } catch (e) {
      if (!(e instanceof NtfyError && (e.code === NO_ATTACHMENTS || e.status === 413))) throw e;
      if (e.code === NO_ATTACHMENTS) this.offUntil = Date.now() + OFF_FOR;
      await plain();
      return { image: "dropped", note: e.code === NO_ATTACHMENTS ? off : `ntfy took no attachment (${e.message}): sent without the image` };
    }
  }

  // headers are a message's fields for a PUT of its attachment.
  private headers(b: Body, image: Image): Record<string, string> {
    return {
      "content-type": image.mime,
      "x-filename": image.name,
      "x-message": word(b.message),
      "x-priority": String(b.priority),
      ...(b.title ? { "x-title": word(b.title) } : {}),
      ...(b.tags ? { "x-tags": word(b.tags.map((t) => t.replace(/,/g, " ")).join(",")) } : {}),
      ...(b.click ? { "x-click": /^[\x21-\x7e]+$/.test(b.click) ? b.click : word(b.click) } : {}),
      ...(b.actions ? { "x-actions": word(JSON.stringify(b.actions)) } : {}),
    };
  }

  private async request(url: string, init: { method: string; headers: Record<string, string>; body: string | Uint8Array<ArrayBuffer> }, signal: AbortSignal | undefined, timeout: number): Promise<void> {
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    let r: Response;
    try {
      r = await fetch(url, {
        method: init.method,
        headers: { ...init.headers, ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: init.body,
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
    let code = 0;
    try {
      const j: any = await r.json();
      why = typeof j?.error === "string" ? `: ${j.error}` : "";
      code = Number(j?.code) || 0;
    } catch {
      // not JSON
    }
    const msg = redact(`ntfy answered ${r.status}${why}`).slice(0, 300);
    if (r.status === 429 || r.status >= 500) throw new NtfyError(msg, r.status, code, { retry: true, after: Number(r.headers.get("retry-after")) || 1 });
    throw new NtfyError(msg, r.status, code);
  }
}
