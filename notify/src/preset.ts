// The preset of a notify plugin: who may be notified (the people, the
// groups of people, the rooms), on which channels (Telegram, ntfy, email,
// their credentials in files), the time zone of the quiet hours, the limits
// (lengths, messages an hour, the grouping window, how long a question
// waits) and the texts the people read. A node names people, groups and
// rooms of the preset, never an address: an unknown name is refused. One
// container serves one preset, and registers in gosidian under its name.
import fs from "node:fs";
import YAML from "yaml";
import { Ajv } from "ajv";
import { topicName } from "./text.ts";

export type ChannelName = "telegram" | "ntfy" | "email";
export const CHANNELS: readonly ChannelName[] = ["telegram", "ntfy", "email"];
export type Priority = "low" | "normal" | "high" | "urgent";
export const PRIORITIES: readonly Priority[] = ["low", "normal", "high", "urgent"];

// Quiet hours, in minutes of the day in the preset's time zone: from
// included, to excluded; from > to crosses midnight.
export interface Quiet {
  from: number;
  to: number;
  text: string;
}

export interface Person {
  name: string;
  // telegram is the person's user id: the chat of their private messages
  // with the bot, and who they are when they press a button in a group.
  telegram?: number;
  ntfy?: string;
  email?: string;
  quiet?: Quiet;
}

export interface RoomTelegram {
  chat: number;
  // topics maps a topic's name, lower case, to its message_thread_id;
  // names keeps the name as the preset writes it.
  topics: Record<string, number>;
  names: Record<string, string>;
  auto_topics: boolean;
  max_auto_topics: number;
}

export interface RoomNtfy {
  topic: string;
  // topics maps a room's topic, lower case, to an ntfy topic of its own;
  // the others go to topic, tagged with their name.
  topics: Record<string, string>;
}

export interface Room {
  name: string;
  telegram?: RoomTelegram;
  ntfy?: RoomNtfy;
  email?: string;
  quiet?: Quiet;
}

export interface TelegramConfig {
  token_file: string;
  api_url: string;
  // poll: the plugin takes the bot's updates (getUpdates, long polling),
  // for the buttons of a question. A bot has one consumer only.
  poll: boolean;
  poll_timeout: number;
}

export interface NtfyConfig {
  server: string;
  token_file?: string;
}

export interface EmailConfig {
  host: string;
  port: number;
  security: "starttls" | "tls" | "none";
  user_file?: string;
  password_file?: string;
  from: string;
}

export interface Limits {
  // title, in characters; text, the most of a message on each channel
  // (ntfy's in bytes, the others' in characters).
  title: number;
  text: Record<ChannelName, number>;
  // per_hour: the messages a person, a room and a channel get in an hour.
  per_hour: { person: number; room: number; channel: number };
  // group_window: seconds in which the same key does not go again.
  group_window: number;
  // expires: a question's wait when the node gives none; max_expires the
  // longest a node may ask. Seconds.
  expires: number;
  max_expires: number;
  // held: the messages kept for a destination in its quiet hours; past
  // it, the oldest go.
  held: number;
  // image: the bytes of a node's image at most (with.image).
  image: number;
}

export const DEFAULT_STRINGS = {
  lang: "en",
  page_title: "A question for you",
  answering_as: "Answering as {person}",
  open_link: "Open the link",
  recorded: "Recorded: {choice}. Thank you.",
  decided: "Already decided by {person}: {choice}.",
  expired: "This question has expired.",
  withdrawn: "This question was withdrawn.",
  not_found: "This link is not valid, or it has expired.",
  not_allowed: "You cannot answer this question.",
  answer: "Answer",
  answer_at: "Answer: {url}",
  outcome: "{choice}: {person}",
  outcome_expired: "Expired",
  outcome_withdrawn: "Withdrawn",
  digest: "{count} notifications while quiet",
  grouped: "{title} (+{count})",
  more: "… and {count} more",
  high: "[high]",
  urgent: "[URGENT]",
  image: "[image]",
};
export type Strings = typeof DEFAULT_STRINGS;

export interface Preset {
  name: string;
  description: string;
  // public_url is where a person's browser reaches the reply page (the
  // HTTP port), without a trailing slash; empty: a question has no link,
  // only Telegram's buttons.
  public_url: string;
  // gosidian_url is gosidian's web UI, for a node's note; the resume_url
  // of a question must be gosidian's. gosidian_api is where the plugin
  // reaches gosidian to resume a run, default gosidian_url.
  gosidian_url: string;
  gosidian_api: string;
  time_zone: string;
  store_dir: string;
  channels: { telegram?: TelegramConfig; ntfy?: NtfyConfig; email?: EmailConfig };
  people: Record<string, Person>;
  groups: Record<string, string[]>;
  rooms: Record<string, Room>;
  limits: Limits;
  strings: Strings;
}

export const NAME = "^[a-z0-9][a-z0-9_.-]{0,31}$";
const NTFY_TOPIC = "^[A-Za-z0-9_-]{1,64}$";
// An address of the preset: no spaces, angle brackets, quotes, commas or
// line breaks, one @.
const EMAIL = "^[^\\s@<>()\",;:\\\\\\[\\]]{1,64}@[A-Za-z0-9.-]{1,253}$";
export const DEFAULT_STORE = "/var/lib/gosidian-notify";
const DAY = 86400;
const MiB = 2 ** 20;
// The most limits.image may be: what Telegram takes of a file a bot sends
// (50 MB; a photo, 10 MB, goes as a file past it).
export const MAX_IMAGE = 50 * 10 ** 6;

export const DEFAULT_LIMITS: Limits = {
  title: 200,
  text: { telegram: 4000, ntfy: 3500, email: 20000 },
  per_hour: { person: 30, room: 60, channel: 300 },
  group_window: 600,
  expires: DAY,
  max_expires: 7 * DAY,
  held: 100,
  image: 8 * MiB,
};

const durationSchema = { type: ["integer", "string"] };
const quietSchema = { type: "string", pattern: "^\\s*\\d{1,2}:\\d{2}\\s*-\\s*\\d{1,2}:\\d{2}\\s*$" };
const fileSchema = { type: "string", pattern: "^/[^\\x00-\\x1f]{0,1023}$" };

const presetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
    description: { type: "string" },
    public_url: { type: "string" },
    gosidian_url: { type: "string" },
    gosidian_api: { type: "string" },
    time_zone: { type: "string", minLength: 1, maxLength: 64 },
    store_dir: { type: "string", pattern: "^/[^\\x00-\\x1f]{0,1023}$" },
    channels: {
      type: "object",
      additionalProperties: false,
      properties: {
        telegram: {
          type: "object",
          additionalProperties: false,
          required: ["token_file"],
          properties: {
            token_file: fileSchema,
            api_url: { type: "string" },
            poll: { type: "boolean" },
            poll_timeout: { type: "integer", minimum: 1, maximum: 50 },
          },
        },
        ntfy: {
          type: "object",
          additionalProperties: false,
          required: ["server"],
          properties: { server: { type: "string" }, token_file: fileSchema },
        },
        email: {
          type: "object",
          additionalProperties: false,
          required: ["host", "from"],
          properties: {
            host: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,253}$" },
            port: { type: "integer", minimum: 1, maximum: 65535 },
            security: { enum: ["starttls", "tls", "none"] },
            user_file: fileSchema,
            password_file: fileSchema,
            from: { type: "string", minLength: 3, maxLength: 200, pattern: "^[^\\x00-\\x1f\\x7f]+$" },
          },
        },
      },
    },
    people: {
      type: "object",
      propertyNames: { pattern: NAME },
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          telegram: { type: "integer", minimum: 1 },
          ntfy: { type: "string", pattern: NTFY_TOPIC },
          email: { type: "string", pattern: EMAIL },
          quiet: quietSchema,
        },
      },
    },
    groups: {
      type: "object",
      propertyNames: { pattern: NAME },
      additionalProperties: { type: "array", minItems: 1, items: { type: "string" }, uniqueItems: true },
    },
    rooms: {
      type: "object",
      propertyNames: { pattern: NAME },
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          telegram: {
            type: "object",
            additionalProperties: false,
            required: ["chat"],
            properties: {
              chat: { type: "integer" },
              topics: { type: "object", additionalProperties: { type: "integer", minimum: 1 } },
              auto_topics: { type: "boolean" },
              max_auto_topics: { type: "integer", minimum: 1, maximum: 1000 },
            },
          },
          ntfy: {
            anyOf: [
              { type: "string", pattern: NTFY_TOPIC },
              {
                type: "object",
                additionalProperties: false,
                required: ["topic"],
                properties: {
                  topic: { type: "string", pattern: NTFY_TOPIC },
                  topics: { type: "object", additionalProperties: { type: "string", pattern: NTFY_TOPIC } },
                },
              },
            ],
          },
          email: { type: "string", pattern: EMAIL },
          quiet: quietSchema,
        },
      },
    },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "integer", minimum: 10, maximum: 1000 },
        text: {
          type: "object",
          additionalProperties: false,
          properties: {
            telegram: { type: "integer", minimum: 100, maximum: 4096 },
            ntfy: { type: "integer", minimum: 100, maximum: 4096 },
            email: { type: "integer", minimum: 100, maximum: 1000000 },
          },
        },
        per_hour: {
          type: "object",
          additionalProperties: false,
          properties: {
            person: { type: "integer", minimum: 1, maximum: 100000 },
            room: { type: "integer", minimum: 1, maximum: 100000 },
            channel: { type: "integer", minimum: 1, maximum: 1000000 },
          },
        },
        group_window: durationSchema,
        expires: durationSchema,
        max_expires: durationSchema,
        held: { type: "integer", minimum: 1, maximum: 10000 },
        image: { type: ["integer", "string"] },
      },
    },
    strings: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(Object.keys(DEFAULT_STRINGS).map((k) => [k, { type: "string", maxLength: 300, pattern: "^[^\\x00-\\x1f\\x7f]*$" }])),
    },
  },
};

// seconds reads a duration: a number of seconds, or "90s", "10m", "12h", "3d".
export function seconds(v: unknown, what: string): number {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  const m = typeof v === "string" ? /^(\d+)\s*(s|m|h|d)?$/.exec(v.trim()) : null;
  if (!m) throw new Error(`${what}: ${JSON.stringify(v)} is not a duration (seconds, or 90s, 10m, 12h, 3d)`);
  const n = Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: DAY } as Record<string, number>)[m[2] ?? "s"];
  if (n <= 0) throw new Error(`${what}: the duration is zero`);
  return n;
}

// bytes reads a size: a number of bytes, or "512KiB", "8MiB", "10MB".
export function bytes(v: unknown, what: string): number {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  const m = typeof v === "string" ? /^(\d+)\s*(B|KiB|MiB|GiB|KB|MB|GB)?$/.exec(v.trim()) : null;
  if (!m) throw new Error(`${what}: ${JSON.stringify(v)} is not a size (bytes, or 512KiB, 8MiB, 10MB)`);
  const unit = ({ B: 1, KiB: 2 ** 10, MiB: 2 ** 20, GiB: 2 ** 30, KB: 1e3, MB: 1e6, GB: 1e9 } as Record<string, number>)[m[2] ?? "B"];
  const n = Number(m[1]) * unit;
  if (n <= 0) throw new Error(`${what}: the size is zero`);
  return n;
}

// formatBytes says a size in its largest binary unit.
export function formatBytes(n: number): string {
  if (n >= 2 ** 20) return `${Math.round((n / 2 ** 20) * 10) / 10} MiB`;
  if (n >= 2 ** 10) return `${Math.round((n / 2 ** 10) * 10) / 10} KiB`;
  return `${n} bytes`;
}

// formatDuration says a number of seconds in its largest whole unit.
export function formatDuration(s: number): string {
  for (const [unit, n] of [["d", DAY], ["h", 3600], ["m", 60]] as const) if (s % n === 0) return `${s / n}${unit}`;
  return `${s}s`;
}

// quiet reads "22:00-07:00".
export function parseQuiet(v: string, what: string): Quiet {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(v);
  const mins = m ? [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])] : [];
  if (!m || Number(m[1]) > 23 || Number(m[3]) > 23 || Number(m[2]) > 59 || Number(m[4]) > 59) throw new Error(`${what}: ${JSON.stringify(v)} is not hours like 22:00-07:00`);
  if (mins[0] === mins[1]) throw new Error(`${what}: ${v} starts and ends at the same time`);
  const hm = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  return { from: mins[0], to: mins[1], text: `${hm(mins[0])}-${hm(mins[1])}` };
}

// httpURL checks an address of the preset: http(s), no query, fragment or
// credentials, no trailing slash.
export function httpURL(v: string, what: string): string {
  if (!v) return "";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${what}: ${JSON.stringify(v)} is not an address`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`${what}: ${v} is not http(s)`);
  if (u.search || u.hash || u.username || u.password) throw new Error(`${what}: ${v} has a query, a fragment or credentials`);
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

export function checkTimeZone(tz: string, what: string): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz }).format(0);
  } catch {
    throw new Error(`${what}: ${JSON.stringify(tz)} is not a time zone (Europe/Rome, UTC…)`);
  }
  return tz;
}

// parsePreset checks a preset (YAML) and fills in its defaults; the
// environment gives public_url (NOTIFY_PUBLIC_URL) when the preset does not.
export function parsePreset(text: string, file = "preset", env: Record<string, string | undefined> = process.env): Preset {
  const raw: any = YAML.parse(text) ?? {};
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  const validate = ajv.compile(presetSchema);
  // A plain boolean: the type guard would narrow raw to {}.
  if (!(validate as (d: unknown) => boolean)(raw)) {
    throw new Error(`${file}: ${ajv.errorsText(validate.errors, { dataVar: "preset" })}`);
  }
  const rc = raw.channels ?? {};
  const channels: Preset["channels"] = {};
  if (rc.telegram) {
    channels.telegram = {
      token_file: rc.telegram.token_file,
      api_url: httpURL(rc.telegram.api_url ?? "https://api.telegram.org", `${file}: channels.telegram.api_url`),
      poll: rc.telegram.poll ?? true,
      poll_timeout: rc.telegram.poll_timeout ?? 50,
    };
  }
  if (rc.ntfy) {
    const server = httpURL(rc.ntfy.server, `${file}: channels.ntfy.server`);
    if (!server) throw new Error(`${file}: channels.ntfy.server is empty`);
    channels.ntfy = { server, ...(rc.ntfy.token_file ? { token_file: rc.ntfy.token_file } : {}) };
  }
  if (rc.email) {
    const e = rc.email;
    // STARTTLS, required, unless the preset says otherwise: port 465 is TLS
    // from the start; none is for a relay on the LAN, or a test's Mailpit.
    const security = e.security ?? (e.port === 465 ? "tls" : "starttls");
    if (Boolean(e.user_file) !== Boolean(e.password_file)) throw new Error(`${file}: channels.email: user_file and password_file go together`);
    channels.email = {
      host: e.host,
      port: e.port ?? (security === "tls" ? 465 : security === "none" ? 25 : 587),
      security,
      ...(e.user_file ? { user_file: e.user_file, password_file: e.password_file } : {}),
      from: e.from,
    };
  }
  if (!channels.telegram && !channels.ntfy && !channels.email) throw new Error(`${file}: channels: at least one of telegram, ntfy and email`);
  const tz = checkTimeZone(raw.time_zone ?? "UTC", `${file}: time_zone`);
  const needs = (what: string, ch: ChannelName) => {
    if (!channels[ch]) throw new Error(`${file}: ${what}: the preset has no channels.${ch}`);
  };

  const people: Record<string, Person> = {};
  for (const [name, p] of Object.entries<any>(raw.people ?? {})) {
    const what = `people.${name}`;
    if (p.telegram !== undefined) needs(`${what}.telegram`, "telegram");
    if (p.ntfy !== undefined) needs(`${what}.ntfy`, "ntfy");
    if (p.email !== undefined) needs(`${what}.email`, "email");
    people[name] = {
      name,
      ...(p.telegram !== undefined ? { telegram: p.telegram } : {}),
      ...(p.ntfy !== undefined ? { ntfy: p.ntfy } : {}),
      ...(p.email !== undefined ? { email: p.email } : {}),
      ...(p.quiet ? { quiet: parseQuiet(p.quiet, `${file}: ${what}.quiet`) } : {}),
    };
  }
  const groups: Record<string, string[]> = {};
  for (const [name, members] of Object.entries<string[]>(raw.groups ?? {})) {
    for (const m of members) if (!Object.hasOwn(people, m)) throw new Error(`${file}: groups.${name}: ${JSON.stringify(m)} is not one of the people`);
    groups[name] = [...members];
  }
  const rooms: Record<string, Room> = {};
  for (const [name, r] of Object.entries<any>(raw.rooms ?? {})) {
    const what = `rooms.${name}`;
    const room: Room = { name };
    if (r.telegram) {
      needs(`${what}.telegram`, "telegram");
      const topics: Record<string, number> = {};
      const names: Record<string, string> = {};
      for (const [t, id] of Object.entries<number>(r.telegram.topics ?? {})) {
        const n = topicName(t);
        if (!n.ok) throw new Error(`${file}: ${what}.telegram.topics: ${JSON.stringify(t)}: ${n.error}`);
        const k = n.name.toLowerCase();
        if (Object.hasOwn(topics, k)) throw new Error(`${file}: ${what}.telegram.topics: ${n.name} twice`);
        topics[k] = id;
        names[k] = n.name;
      }
      room.telegram = { chat: r.telegram.chat, topics, names, auto_topics: r.telegram.auto_topics ?? false, max_auto_topics: r.telegram.max_auto_topics ?? 50 };
    }
    if (r.ntfy !== undefined) {
      needs(`${what}.ntfy`, "ntfy");
      const o = typeof r.ntfy === "string" ? { topic: r.ntfy } : r.ntfy;
      const topics: Record<string, string> = {};
      for (const [t, nt] of Object.entries<string>(o.topics ?? {})) {
        const n = topicName(t);
        if (!n.ok) throw new Error(`${file}: ${what}.ntfy.topics: ${JSON.stringify(t)}: ${n.error}`);
        topics[n.name.toLowerCase()] = nt;
      }
      room.ntfy = { topic: o.topic, topics };
    }
    if (r.email !== undefined) {
      needs(`${what}.email`, "email");
      room.email = r.email;
    }
    if (r.quiet) room.quiet = parseQuiet(r.quiet, `${file}: ${what}.quiet`);
    if (!room.telegram && !room.ntfy && !room.email) throw new Error(`${file}: ${what}: a room needs a channel (telegram, ntfy or email)`);
    rooms[name] = room;
  }

  const rl = raw.limits ?? {};
  const limits: Limits = {
    title: rl.title ?? DEFAULT_LIMITS.title,
    text: { ...DEFAULT_LIMITS.text, ...(rl.text ?? {}) },
    per_hour: { ...DEFAULT_LIMITS.per_hour, ...(rl.per_hour ?? {}) },
    group_window: rl.group_window !== undefined ? seconds(rl.group_window, `${file}: limits.group_window`) : DEFAULT_LIMITS.group_window,
    expires: rl.expires !== undefined ? seconds(rl.expires, `${file}: limits.expires`) : DEFAULT_LIMITS.expires,
    max_expires: rl.max_expires !== undefined ? seconds(rl.max_expires, `${file}: limits.max_expires`) : DEFAULT_LIMITS.max_expires,
    held: rl.held ?? DEFAULT_LIMITS.held,
    image: rl.image !== undefined ? bytes(rl.image, `${file}: limits.image`) : DEFAULT_LIMITS.image,
  };
  if (limits.image < 1024 || limits.image > MAX_IMAGE) throw new Error(`${file}: limits.image ${formatBytes(limits.image)}: from 1 KiB to 50 MB (Telegram's most for a file)`);
  if (limits.expires > limits.max_expires) throw new Error(`${file}: limits.expires ${formatDuration(limits.expires)} is over limits.max_expires ${formatDuration(limits.max_expires)}`);

  const gosidian_url = httpURL(raw.gosidian_url ?? "", `${file}: gosidian_url`);
  return {
    name: raw.name,
    description: raw.description ?? `Notifications to the people of the preset, and their answers (${raw.name})`,
    public_url: httpURL(raw.public_url ?? env.NOTIFY_PUBLIC_URL ?? "", raw.public_url ? `${file}: public_url` : "NOTIFY_PUBLIC_URL"),
    gosidian_url,
    gosidian_api: httpURL(raw.gosidian_api ?? "", `${file}: gosidian_api`) || gosidian_url,
    time_zone: tz,
    store_dir: String(raw.store_dir ?? DEFAULT_STORE).replace(/(.)\/+$/, "$1"),
    channels,
    people,
    groups,
    rooms,
    limits,
    strings: { ...DEFAULT_STRINGS, ...(raw.strings ?? {}) },
  };
}

// loadPreset reads the preset's file. A notify plugin without people has
// nothing to do: there is no default preset.
export function loadPreset(file: string, env: Record<string, string | undefined> = process.env): Preset {
  return parsePreset(fs.readFileSync(file, "utf8"), file, env);
}

// hostOf is an http(s) address's host and port, as the manifest's network
// lists it.
export function hostOf(u: string): string {
  const url = new URL(u);
  return url.port ? url.host : `${url.host}:${url.protocol === "https:" ? 443 : 80}`;
}

// hostsOfPreset are the hosts the plugin calls: the channels' servers and
// gosidian, to resume a run.
export function hostsOfPreset(p: Preset): string[] {
  const out: string[] = [];
  if (p.channels.telegram) out.push(hostOf(p.channels.telegram.api_url));
  if (p.channels.ntfy) out.push(hostOf(p.channels.ntfy.server));
  if (p.channels.email) out.push(`${p.channels.email.host}:${p.channels.email.port}`);
  if (p.gosidian_api) out.push(hostOf(p.gosidian_api));
  return [...new Set(out)];
}
