// How a message reaches its destinations: the names of a node made into
// people and rooms of the preset (an unknown one refused), each one's
// channels, its quiet hours (low and normal held, then one digest; high and
// urgent pass), the grouping of a key (the same key within group_window
// counted, not sent, and one message at the window's end with the count),
// the hourly caps of a person, a room and a channel. Each send gives an
// entry per destination and channel: sent, held, grouped or failed.
import { CHANNELS, type ChannelName, type Preset, type Priority, type Quiet } from "./preset.ts";
import type { Group, Held, Msg, Question, Store } from "./store.ts";
import { fill, topicName } from "./text.ts";
import { redact } from "./secrets.ts";
import type { Channel, Dest, Outgoing, Sent } from "./channels/channel.ts";
import type { Telegram } from "./channels/telegram.ts";

export class NodeError extends Error {}

export interface Env {
  preset: Preset;
  store: Store;
  channels: Partial<Record<ChannelName, Channel>>;
  telegram?: Telegram;
  log: (msg: string, f?: Record<string, unknown>) => void;
  now: () => number;
  // background holds the work a node or a press left running (an answer
  // to gosidian, buttons to change): close waits for it.
  background?: Set<Promise<unknown>>;
}

// later runs work in the background, kept until it ends.
export function later(env: Env, p: Promise<unknown>): void {
  const bg = (env.background ??= new Set());
  const q = p.catch((e) => env.log("background work failed", { error: redact((e as Error).message) })).finally(() => bg.delete(q));
  bg.add(q);
}

export type Status = "sent" | "held" | "grouped" | "failed";

export interface Entry {
  to: string;
  channel: ChannelName | null;
  status: Status;
  error?: string;
}

const HOUR = 3600_000;
const RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

// --- the destinations ---

// destOf finds a destination of the preset by the name a node gives: a
// person (alice), a room (#team) or a room's topic (#team/releases). A
// group (@ops) is its people, see resolve.
export function destOf(env: Env, name: string): Dest | string {
  const p = env.preset;
  if (name.startsWith("#")) {
    const slash = name.indexOf("/");
    const room = slash < 0 ? name.slice(1) : name.slice(1, slash);
    if (!Object.hasOwn(p.rooms, room)) return `${JSON.stringify(name)}: no room ${room} in the preset`;
    const r = p.rooms[room];
    if (slash < 0) return { kind: "room", key: `#${room}`, room: r };
    const t = topicName(name.slice(slash + 1));
    if (!t.ok) return `${JSON.stringify(name)}: ${t.error}`;
    const k = t.name.toLowerCase();
    const known =
      (r.telegram && (Object.hasOwn(r.telegram.topics, k) || r.telegram.auto_topics || env.store.data.topics[room]?.[k])) ||
      (r.ntfy && Object.hasOwn(r.ntfy.topics, k));
    if (!known) return `${JSON.stringify(name)}: the room ${room} has no topic ${t.name} (its topics, or auto_topics, are the preset's)`;
    const shown = r.telegram?.names[k] ?? env.store.data.topics[room]?.[k]?.name ?? t.name;
    return { kind: "room", key: `#${room}/${shown}`, room: r, topic: shown };
  }
  if (Object.hasOwn(p.people, name)) return { kind: "person", key: name, person: p.people[name] };
  return `${JSON.stringify(name)} is not a person, a group (@name) or a room (#name, #name/topic) of the preset`;
}

// resolve makes the names of a node's to into destinations, each once; a
// name the preset does not have refuses the call, before anything is sent.
export function resolve(env: Env, to: string[], what = "with.to"): Dest[] {
  const out = new Map<string, Dest>();
  const bad: string[] = [];
  for (const raw of to) {
    const name = String(raw).trim();
    if (name.startsWith("@")) {
      const g = name.slice(1);
      if (!Object.hasOwn(env.preset.groups, g)) {
        bad.push(`${JSON.stringify(name)}: no group ${g} in the preset`);
        continue;
      }
      for (const m of env.preset.groups[g]) out.set(m, { kind: "person", key: m, person: env.preset.people[m] });
      continue;
    }
    const d = destOf(env, name);
    if (typeof d === "string") bad.push(d);
    else out.set(d.key, d);
  }
  if (bad.length) throw new NodeError(`${what}: ${bad.join("; ")}. A node names the preset's destinations, never an address`);
  return [...out.values()];
}

// people are the names of a node's approvers, groups made into people.
export function people(env: Env, names: string[], what: string): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const name = String(raw).trim();
    if (name.startsWith("@") && Object.hasOwn(env.preset.groups, name.slice(1))) {
      for (const m of env.preset.groups[name.slice(1)]) out.add(m);
    } else if (Object.hasOwn(env.preset.people, name)) {
      out.add(name);
    } else {
      throw new NodeError(`${what}: ${JSON.stringify(name)} is not a person or a group (@name) of the preset`);
    }
  }
  return [...out];
}

// channelsOf are the channels a destination is reached on: its own, among
// the preset's, within the node's channels when it names some.
export function channelsOf(env: Env, d: Dest, only?: ChannelName[]): ChannelName[] {
  return CHANNELS.filter((c) => env.channels[c]?.reaches(d) && (!only || only.includes(c)));
}

// --- quiet hours ---

const clocks = new Map<string, Intl.DateTimeFormat>();

// minuteOf is the minute of the day at t in a time zone.
export function minuteOf(t: number, tz: string): number {
  let f = clocks.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    clocks.set(tz, f);
  }
  const parts = f.formatToParts(t);
  const h = Number(parts.find((x) => x.type === "hour")?.value);
  const m = Number(parts.find((x) => x.type === "minute")?.value);
  return h * 60 + m;
}

export function inQuiet(q: Quiet | undefined, t: number, tz: string): boolean {
  if (!q) return false;
  const m = minuteOf(t, tz);
  return q.from < q.to ? m >= q.from && m < q.to : m >= q.from || m < q.to;
}

export function quietOf(d: Dest): Quiet | undefined {
  return d.kind === "person" ? d.person.quiet : d.room.quiet;
}

// clock says a time as hours and minutes in the preset's time zone.
export function clock(t: number, tz: string): string {
  const m = minuteOf(t, tz);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// --- the hourly caps ---

function scopeOf(d: Dest): { key: string; cap: "person" | "room" } {
  return d.kind === "person" ? { key: `person:${d.person.name}`, cap: "person" } : { key: `room:${d.room.name}`, cap: "room" };
}

// reserve counts a message against the caps of its destination and its
// channel, or says which cap it is over; release gives the count back
// when the send fails.
function reserve(env: Env, d: Dest, c: ChannelName, system: boolean): string {
  const now = env.now();
  const rates = env.store.data.rates;
  const s = scopeOf(d);
  const scopes: [string, number, string][] = [
    [s.key, env.preset.limits.per_hour[s.cap], `${d.kind === "room" ? `the room #${d.room.name}` : d.key} (limits.per_hour.${s.cap})`],
    [`channel:${c}`, env.preset.limits.per_hour.channel, `${c} (limits.per_hour.channel)`],
  ];
  for (const [k] of scopes) rates[k] = (rates[k] ?? []).filter((t) => t > now - HOUR);
  if (!system) {
    for (const [k, cap, what] of scopes) if (rates[k].length >= cap) return `over the cap of ${cap} messages an hour for ${what}`;
  }
  for (const [k] of scopes) rates[k].push(now);
  return "";
}

function unreserve(env: Env, d: Dest, c: ChannelName): void {
  for (const k of [scopeOf(d).key, `channel:${c}`]) env.store.data.rates[k]?.pop();
}

// --- sending ---

// deliver sends one message to a destination on its channels, at once.
export async function deliver(env: Env, d: Dest, chans: ChannelName[], out: Omit<Outgoing, "dest">, o: { system?: boolean; question?: Question; signal?: AbortSignal } = {}): Promise<Entry[]> {
  const entries = await Promise.all(
    chans.map(async (c): Promise<Entry> => {
      const over = reserve(env, d, c, Boolean(o.system));
      if (over) return { to: d.key, channel: c, status: "failed", error: over };
      let sent: Sent;
      try {
        sent = await env.channels[c]!.send({ ...out, dest: d }, o.signal);
      } catch (e) {
        unreserve(env, d, c);
        const error = redact((e as Error).message);
        env.log("a send failed", { to: d.key, channel: c, error });
        return { to: d.key, channel: c, status: "failed", error };
      }
      if (sent.telegram && o.question) o.question.telegram.push(sent.telegram);
      return { to: d.key, channel: c, status: "sent" };
    }),
  );
  env.store.save();
  return entries;
}

export interface Notice {
  msg: Msg;
  // only: the node's channels.
  only?: ChannelName[];
  // A question: what goes to each destination is its own (a person's
  // token), see questions.ts.
  question?: Question;
  outgoing?: (d: Dest) => Omit<Outgoing, "dest">;
  // passes: the priority that goes through quiet hours.
  passes: (p: Priority) => boolean;
  // system: a digest or a count; past the caps, and not grouped.
  system?: boolean;
}

export function plainOutgoing(m: Msg): Omit<Outgoing, "dest"> {
  return { title: m.title, text: m.text, link: m.link, priority: m.priority };
}

function groupKey(m: Msg, d: Dest): string {
  return JSON.stringify([m.project, m.key, d.key]);
}

// dispatch sends a notice to its destinations: grouped, held or sent.
export async function dispatch(env: Env, n: Notice, dests: Dest[], signal?: AbortSignal): Promise<Entry[]> {
  const data = env.store.data;
  const now = env.now();
  const all = await Promise.all(
    dests.map(async (d): Promise<Entry[]> => {
      const chans = channelsOf(env, d, n.only);
      if (!chans.length) return [{ to: d.key, channel: null, status: "failed", error: `${d.key} has no channel${n.only ? ` of ${n.only.join(", ")}` : ""} in the preset` }];
      const key = n.msg.key && !n.system ? groupKey(n.msg, d) : "";
      if (key) {
        const g = data.groups[key];
        if (g && g.until > now) {
          g.count++;
          g.last = n.msg;
          g.channels = [...new Set([...g.channels, ...chans])];
          env.store.save();
          return chans.map((c) => ({ to: d.key, channel: c, status: "grouped" }));
        }
      }
      if (inQuiet(quietOf(d), now, env.preset.time_zone) && !n.passes(n.msg.priority)) {
        hold(env, d, chans, n);
        return chans.map((c) => ({ to: d.key, channel: c, status: "held" }));
      }
      // The key's window opens before the send, so a send of the same key
      // at the same time is grouped; nothing sent, it closes again, unless
      // another came in it meanwhile.
      const win: Group | undefined = key ? { dest: d.key, project: n.msg.project, key: n.msg.key!, until: now + env.preset.limits.group_window * 1000, count: 0, channels: chans } : undefined;
      if (win) data.groups[key] = win;
      const out = n.outgoing ? n.outgoing(d) : plainOutgoing(n.msg);
      const entries = await deliver(env, d, chans, out, { system: n.system, question: n.question, signal });
      if (win && !entries.some((e) => e.status === "sent") && data.groups[key] === win && win.count === 0) {
        delete data.groups[key];
        env.store.save();
      }
      return entries;
    }),
  );
  return all.flat();
}

// hold keeps a notice for the end of a destination's quiet hours: the same
// key held again counts on the one held, and past limits.held the oldest
// goes.
function hold(env: Env, d: Dest, chans: ChannelName[], n: Notice): void {
  const data = env.store.data;
  const mine = data.held.filter((h) => h.dest === d.key);
  const same = n.msg.key && !n.question ? mine.find((h) => h.msg?.key === n.msg.key && h.msg?.project === n.msg.project) : undefined;
  if (same) {
    same.count = (same.count ?? 1) + 1;
    same.msg = n.msg;
    same.channels = [...new Set([...same.channels, ...chans])];
  } else {
    const h: Held = { dest: d.key, channels: chans, at: env.now(), ...(n.question ? { question: n.question.id } : { msg: n.msg }) };
    data.held.push(h);
    if (mine.length + 1 > env.preset.limits.held) {
      const oldest = mine.find((x) => !x.question) ?? mine[0];
      data.held.splice(data.held.indexOf(oldest), 1);
      data.dropped = data.dropped ?? {};
      data.dropped[d.key] = (data.dropped[d.key] ?? 0) + 1;
      env.log("held: past limits.held, the oldest dropped", { to: d.key });
    }
  }
  env.store.save();
}

// --- what the ticker does: the digests and the counts ---

// digest is the one message of what a destination's quiet hours held, on
// a channel: each notice's time, title and first lines, as many as fit.
export function digest(env: Env, items: Held[], dropped: number, c: ChannelName): Omit<Outgoing, "dest"> {
  const s = env.preset.strings;
  const limit = Math.floor(env.preset.limits.text[c] * 0.9);
  const parts: string[] = [];
  let used = 0;
  let shown = 0;
  let priority: Priority = "low";
  for (const h of items) {
    const m = h.msg!;
    if (RANK[m.priority] > RANK[priority]) priority = m.priority;
    const head = `${clock(h.at, env.preset.time_zone)} ${m.title || m.text.split("\n")[0]}${h.count && h.count > 1 ? ` (+${h.count - 1})` : ""}`;
    const body = m.title && m.text ? m.text.split("\n").slice(0, 3).join("\n").slice(0, 300) : "";
    const part = [head, body, m.link].filter(Boolean).join("\n");
    const size = c === "ntfy" ? Buffer.byteLength(part) + 2 : part.length + 2;
    if (used + size > limit && shown > 0) break;
    parts.push(part);
    used += size;
    shown++;
  }
  const more = items.length - shown + dropped;
  if (more > 0) parts.push(fill(s.more, { count: more }));
  return { title: fill(s.digest, { count: items.length + dropped }), text: parts.join("\n\n"), link: "", priority: priority === "low" ? "low" : "normal" };
}

// release sends what the quiet hours held, to each destination whose quiet
// hours are over: one digest a channel, then each question still open.
export async function release(env: Env, question: (q: Question, d: Dest) => Omit<Outgoing, "dest">): Promise<void> {
  const data = env.store.data;
  const now = env.now();
  const keys = [...new Set(data.held.map((h) => h.dest))];
  for (const key of keys) {
    let d: Dest | string;
    if (key.startsWith("#") || Object.hasOwn(env.preset.people, key)) d = destOf(env, key);
    else d = `${key} is not in the preset`;
    if (typeof d === "string") {
      data.held = data.held.filter((h) => h.dest !== key);
      env.log("held for a destination the preset no longer has: dropped", { to: key });
      env.store.save();
      continue;
    }
    if (inQuiet(quietOf(d), now, env.preset.time_zone)) continue;
    const items = data.held.filter((h) => h.dest === key);
    data.held = data.held.filter((h) => h.dest !== key);
    const dropped = data.dropped?.[key] ?? 0;
    if (data.dropped) delete data.dropped[key];
    env.store.save();
    const plain = items.filter((h) => h.msg);
    const avail = new Set(channelsOf(env, d));
    for (const c of CHANNELS) {
      const its = plain.filter((h) => h.channels.includes(c));
      if (!avail.has(c) || !its.length) continue;
      const entries = await deliver(env, d, [c], digest(env, its, dropped, c), { system: true });
      env.log("digest sent", { to: key, channel: c, notices: its.length, status: entries[0].status, ...(entries[0].error ? { error: entries[0].error } : {}) });
    }
    for (const h of items.filter((x) => x.question)) {
      const q = data.questions[h.question!];
      if (!q || q.status !== "open" || q.expires <= now) continue;
      const chans = h.channels.filter((c) => avail.has(c));
      const entries = await deliver(env, d, chans, question(q, d), { system: true, question: q });
      env.log("held question sent", { to: key, question: q.id, sent: entries.filter((e) => e.status === "sent").map((e) => e.channel) });
    }
  }
}

// closeGroups ends the grouping windows that are over: a key that came
// again in its window goes once more, with how many times it came.
export async function closeGroups(env: Env): Promise<void> {
  const data = env.store.data;
  const now = env.now();
  const over = Object.entries(data.groups).filter(([, g]) => g.until <= now);
  if (!over.length) return;
  for (const [k] of over) delete data.groups[k];
  env.store.save();
  for (const [, g] of over) {
    if (!g.count || !g.last) continue;
    const d = g.dest.startsWith("#") || Object.hasOwn(env.preset.people, g.dest) ? destOf(env, g.dest) : "";
    if (typeof d === "string") continue;
    const m: Msg = { ...g.last, title: fill(env.preset.strings.grouped, { title: g.last.title || g.last.text.split("\n")[0], count: g.count }), key: undefined };
    const only = g.channels;
    await dispatch(env, { msg: m, only, passes: (p) => p === "high" || p === "urgent", system: true }, [d]);
    env.log("grouped key: its count sent", { to: g.dest, key: g.key, count: g.count });
  }
}

export function summary(entries: Entry[]): Record<Status, number> {
  const out: Record<Status, number> = { sent: 0, held: 0, grouped: 0, failed: 0 };
  for (const e of entries) out[e.status]++;
  return out;
}

