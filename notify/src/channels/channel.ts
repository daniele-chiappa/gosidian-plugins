// What a channel is to the plugin: it sends a message, already made plain,
// to a destination of the preset (a person or a room) and says what it
// sent, or throws a ChannelError, which says why with no secret in it. A
// new channel (a self-hosted chat, Nextcloud) is one more of these, a
// setting of the people and the rooms, and its credentials in a file.
import type { ChannelName, Person, Priority, Room } from "../preset.ts";
import { redact } from "../secrets.ts";
import type { Image } from "../image.ts";

export type Dest =
  | { kind: "person"; key: string; person: Person }
  | { kind: "room"; key: string; room: Room; topic?: string };

export interface Outgoing {
  dest: Dest;
  title: string;
  text: string;
  link: string;
  priority: Priority;
  // A question: its id and choices; answer_url, the person's reply page
  // (none in a room); buttons, Telegram's (its updates are taken).
  question?: { id: string; choices: string[]; answer_url?: string; buttons: boolean };
  // image: the node's image, its bytes checked (image.ts). A channel sends
  // it with the message, or the message without it, saying why.
  image?: Image;
}

export interface Sent {
  // A Telegram message, whose buttons change once the question is decided.
  telegram?: { chat: number; message_id: number };
  // image: with an image, sent with the message, or dropped (the server
  // took the message, not the image), note saying why.
  image?: "sent" | "dropped";
  note?: string;
}

export interface Channel {
  readonly name: ChannelName;
  // reaches is true when the channel has an address for the destination.
  reaches(d: Dest): boolean;
  send(o: Outgoing, signal?: AbortSignal): Promise<Sent>;
  close?(): Promise<void> | void;
}

export class ChannelError extends Error {
  // retry: a second try may work (the network, a busy server).
  readonly retry: boolean;
  // after: seconds the server asked to wait (Telegram's retry_after).
  readonly after: number;
  constructor(message: string, opts: { retry?: boolean; after?: number } = {}) {
    super(message);
    this.retry = opts.retry ?? false;
    this.after = opts.after ?? 0;
  }
}

// causeOf says why a fetch failed, without its address: the system's code
// (ECONNREFUSED, ENOTFOUND), a timeout, else the cause's own words (which
// name a host at most), redacted.
export function causeOf(e: unknown): string {
  const err = e as { name?: string; cause?: { code?: string; message?: string; errors?: { code?: string }[] }; code?: string };
  if (err?.name === "TimeoutError") return "timed out";
  if (err?.name === "AbortError") return "canceled";
  const code = err?.cause?.code ?? err?.cause?.errors?.find((x) => x.code)?.code ?? err?.code;
  if (code) return code;
  return err?.cause?.message ? redact(err.cause.message).slice(0, 80) : "the network failed";
}

// tryTwice tries a send again once when its error says it may work: at
// once for the network, after the wait a server asked for (at most
// maxWait seconds; longer, the error stands).
export async function tryTwice<T>(fn: () => Promise<T>, maxWait = 5): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ChannelError) || !e.retry || e.after > maxWait) throw e;
    await new Promise((ok) => setTimeout(ok, Math.max(e.after, 0.5) * 1000));
    return fn();
  }
}

// lines joins the parts of a message that are there, a blank line apart.
export function lines(...parts: (string | undefined)[]): string {
  return parts.filter((p) => p).join("\n\n");
}
