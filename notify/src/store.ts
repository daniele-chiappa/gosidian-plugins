// What the plugin keeps on its volume, in one file (state.json, mode 600,
// written whole and renamed, so a stop never leaves half of it): the
// messages held in quiet hours, the open grouping windows, the counts of
// the hourly caps, the open questions (their tokens as SHA-256 hashes,
// never the tokens), the answers still to hand gosidian, the Telegram
// topics the bot made and the offset of its updates. It survives a
// restart; a file that does not parse is set aside, and the plugin starts
// empty.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ChannelName, Priority } from "./preset.ts";

export interface Msg {
  project: string;
  title: string;
  text: string;
  link: string;
  priority: Priority;
  key?: string;
}

// Held is a message for a destination in its quiet hours, or a question
// to send it when they end; count, the same key held again.
export interface Held {
  dest: string;
  channels: ChannelName[];
  at: number;
  msg?: Msg;
  question?: string;
  count?: number;
}

// Group is the window of a key to a destination: until it ends, the same
// key is counted, not sent; at its end, one message says how many came.
export interface Group {
  dest: string;
  project: string;
  key: string;
  until: number;
  count: number;
  channels: ChannelName[];
  last?: Msg;
}

export interface Decision {
  choice: string;
  index: number;
  by: string;
  channel: string;
  at: number;
}

export interface Question {
  id: string;
  project: string;
  run: string | null;
  title: string;
  text: string;
  link: string;
  priority: Priority;
  choices: string[];
  // allowed are the people who may answer; tokens maps the SHA-256 of a
  // token to its person.
  allowed: string[];
  tokens: Record<string, string>;
  // resume is where the answer goes: gosidian's resume_url, at gosidian_api.
  resume: string;
  created: number;
  expires: number;
  status: "open" | "decided" | "canceled" | "expired";
  decision?: Decision;
  // telegram are the messages of the question, whose buttons become its
  // outcome.
  telegram: { chat: number; message_id: number }[];
  closed?: number;
}

export interface Resume {
  question: string;
  body: string;
  attempts: number;
  next: number;
}

export interface Data {
  v: 1;
  telegram_offset: number;
  // topics: the Telegram topics the bot made, by room and name (lower
  // case).
  topics: Record<string, Record<string, { id: number; name: string }>>;
  rates: Record<string, number[]>;
  groups: Record<string, Group>;
  held: Held[];
  questions: Record<string, Question>;
  outbox: Resume[];
  // dropped: how many held messages a destination lost past limits.held,
  // said in its digest.
  dropped?: Record<string, number>;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
// An id: 80 random bits in base32, 16 characters; short enough for a
// Telegram button's data.
export const ID = /^[a-z2-7]{16}$/;
// A token: 128 random bits, base64url, 22 characters.
export const TOKEN = /^[A-Za-z0-9_-]{22}$/;

export function newId(): string {
  const b = crypto.randomBytes(10);
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of b) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

export function newToken(): string {
  return crypto.randomBytes(16).toString("base64url");
}

export function hashToken(t: string): string {
  return crypto.createHash("sha256").update(t).digest("hex");
}

function empty(): Data {
  return { v: 1, telegram_offset: 0, topics: {}, rates: {}, groups: {}, held: [], questions: {}, outbox: [] };
}

export class Store {
  readonly dir: string;
  readonly file: string;
  data: Data = empty();
  private tokens = new Map<string, string>();
  private readonly log: (msg: string, f?: Record<string, unknown>) => void;

  constructor(dir: string, log: (msg: string, f?: Record<string, unknown>) => void = () => {}) {
    this.dir = dir;
    this.file = path.join(dir, "state.json");
    this.log = log;
  }

  open(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    let text: string | undefined;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (text !== undefined) {
      try {
        const d = JSON.parse(text) as Data;
        if (d?.v !== 1) throw new Error(`version ${d?.v}`);
        this.data = { ...empty(), ...d };
      } catch (e) {
        const aside = `${this.file}.broken-${Date.now()}`;
        fs.renameSync(this.file, aside);
        this.log("the state did not parse: set aside, starting empty", { file: aside, error: (e as Error).message });
        this.data = empty();
      }
    }
    this.tokens.clear();
    for (const q of Object.values(this.data.questions)) for (const h of Object.keys(q.tokens)) this.tokens.set(h, q.id);
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // token gives a person a token for a question: its hash is kept, the
  // token itself only goes in the person's link. A person has one live
  // token per question: a new one replaces the old.
  token(q: Question, person: string): string {
    for (const [h, p] of Object.entries(q.tokens)) {
      if (p === person) {
        delete q.tokens[h];
        this.tokens.delete(h);
      }
    }
    const t = newToken();
    const h = hashToken(t);
    q.tokens[h] = person;
    this.tokens.set(h, q.id);
    return t;
  }

  // byToken finds the question and the person of a token.
  byToken(t: string): { q: Question; person: string } | undefined {
    if (!TOKEN.test(t)) return undefined;
    const h = hashToken(t);
    const id = this.tokens.get(h);
    const q = id ? this.data.questions[id] : undefined;
    const person = q?.tokens[h];
    return q && person ? { q, person } : undefined;
  }

  // forget removes a question, and its tokens.
  forget(id: string): void {
    const q = this.data.questions[id];
    if (!q) return;
    for (const h of Object.keys(q.tokens)) this.tokens.delete(h);
    delete this.data.questions[id];
  }
}
