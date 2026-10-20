// The plugin's nodes: send, ask, cancel. Each reads the call's project from
// its _meta (gosidian/project): a question belongs to the project that asked
// it, and only that project's calls withdraw it. Their settings name the
// preset's destinations only; the text is made plain and cut; an image is
// a file of the project, which gosidian hands by reference (image.ts).
import { Ajv } from "ajv";
import { CHANNELS, formatBytes, formatDuration, PRIORITIES, seconds, type ChannelName, type Preset, type Priority } from "./preset.ts";
import { dispatch, NodeError, people, resolve, summary, type Entry, type Env } from "./dispatch.ts";
import { answerers, cancel as cancelQuestion, close, questionOutgoing } from "./questions.ts";
import { ID, newId, type Msg, type Question } from "./store.ts";
import { capUnits, clean, linkError } from "./text.ts";
import { fetchImage, metaOf, type Image } from "./image.ts";

export { NodeError };

export const META = { project: "gosidian/project", run: "gosidian/run" } as const;

export interface Result {
  output: Record<string, unknown>;
  text: string;
}

// projectOf is the call's project; a call without one is refused.
export function projectOf(meta: Record<string, unknown> | undefined): string {
  const p = meta?.[META.project];
  if (typeof p !== "string" || !p || p.length > 200) throw new NodeError("the call names no project (_meta gosidian/project): gosidian sends it with every node's call");
  return p;
}

function runOf(meta: Record<string, unknown>): string | null {
  const r = meta[META.run];
  return typeof r === "string" && r ? r : null;
}

// destinations are the names a node may give in to, for the schemas.
export function destinations(p: Preset): string[] {
  const out = [...Object.keys(p.people), ...Object.keys(p.groups).map((g) => `@${g}`)];
  for (const r of Object.values(p.rooms)) {
    out.push(`#${r.name}`);
    for (const k of Object.keys(r.telegram?.topics ?? {})) out.push(`#${r.name}/${r.telegram!.names[k]}`);
    for (const k of Object.keys(r.ntfy?.topics ?? {})) if (!r.telegram?.topics[k]) out.push(`#${r.name}/${k}`);
    if (r.telegram?.auto_topics) out.push(`#${r.name}/<topic>`);
  }
  return out;
}

export function configured(p: Preset): ChannelName[] {
  return CHANNELS.filter((c) => p.channels[c]);
}

// --- the schemas, as a pipeline writes the settings ---

const names = (what: string) => ({
  description: what,
  anyOf: [
    { type: "string", minLength: 1, maxLength: 200 },
    { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1, maxLength: 200 } },
  ],
});

function common(p: Preset): Record<string, unknown> {
  const list = destinations(p);
  return {
    to: names(`People, groups (@name) or rooms (#room, #room/topic) of the preset${list.length ? `: ${list.join(", ")}` : ""}. Never an address`),
    title: { type: "string", maxLength: 4000, description: `Plain text on one line, cut at ${p.limits.title} characters` },
    text: { type: "string", maxLength: 65536, description: `Plain text: no HTML or markdown is interpreted. Cut at each channel's length (Telegram ${p.limits.text.telegram}, ntfy ${p.limits.text.ntfy} bytes, email ${p.limits.text.email})` },
    link: { type: "string", maxLength: 2048, description: "An http(s) address, shown with the message" },
    note: { type: "string", maxLength: 1024, description: `A note of the project, relative to it: its link in gosidian's web UI${p.gosidian_url ? ` (${p.gosidian_url})` : " (the preset's gosidian_url)"}` },
    priority: { enum: [...PRIORITIES], default: "normal", description: "low (silent on Telegram), normal, high, urgent; in quiet hours low and normal wait for the digest" },
    channels: { type: "array", minItems: 1, uniqueItems: true, items: { enum: configured(p) }, description: "Only these of each destination's channels; default all of them" },
    // As a pipeline writes it: gosidian hands the tool a reference instead.
    image: {
      description: `One image of the project, a vault path (an attachment, as preview.check's screenshot comes back): PNG, JPEG, WebP or GIF by its first bytes, at most ${formatBytes(p.limits.image)}. A photo on Telegram (the text its caption when it fits), an attachment on ntfy and email. The plugin fetches it from gosidian, by reference`,
      anyOf: [{ type: "string", minLength: 1 }, { type: "object", required: ["path"] }, { type: "array", minItems: 1, maxItems: 1 }],
    },
    require: { enum: ["any", "all"], default: "any", description: "any: the node fails only when nothing went (every channel failed); all: when a channel failed" },
  };
}

const textRequired = [{ required: ["title"] }, { required: ["text"] }];

export function inputSchemas(p: Preset): Record<string, Record<string, unknown>> {
  return {
    send: {
      type: "object",
      additionalProperties: false,
      required: ["to"],
      anyOf: textRequired,
      properties: {
        ...common(p),
        key: { type: "string", minLength: 1, maxLength: 200, description: `The same key to the same destination within ${formatDuration(p.limits.group_window)} does not go again: it is counted, and the count goes at the window's end` },
      },
    },
    ask: {
      type: "object",
      additionalProperties: false,
      required: ["to", "choices", "resume_url"],
      anyOf: textRequired,
      properties: {
        ...common(p),
        choices: { type: "array", minItems: 2, maxItems: 4, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40 }, description: "2 to 4 choices, the first the positive one" },
        resume_url: { type: "string", minLength: 1, maxLength: 2048, description: "{{ run.resume_url }}: the first answer is POSTed there, {choice, choices: {<choice>: true|false}, by, channel, at}; a wait.call node waits for it" },
        approvers: names("Who may answer, people or groups of the preset; default the people of to. Needed for a question to rooms only"),
        expires: { type: ["string", "integer"], default: formatDuration(p.limits.expires), description: `How long the question waits: seconds, or 12h, 3d; at most ${formatDuration(p.limits.max_expires)}. Give the wait.call's timeout` },
      },
    },
    cancel: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string", pattern: ID.source, description: "The id of a question of the project, as ask gave it" } },
    },
  };
}

const entrySchema = {
  type: "object",
  properties: {
    to: { type: "string" },
    channel: { type: ["string", "null"] },
    status: { enum: ["sent", "held", "grouped", "failed"] },
    error: { type: "string" },
    image: { enum: ["sent", "dropped", "held"], description: "With an image: sent with the message; dropped, the message went (or will go) without it, note says why; held, kept for when the held question goes" },
    note: { type: "string" },
  },
};
const sentSchema = {
  id: { type: "string" },
  ok: { type: "boolean", description: "Nothing failed" },
  sent: { type: "array", items: entrySchema, description: "Per destination and channel: sent, held (quiet hours), grouped (its key's window) or failed, with the error" },
  counts: { type: "object", properties: { sent: { type: "integer" }, held: { type: "integer" }, grouped: { type: "integer" }, failed: { type: "integer" } } },
};

export const outputSchemas = {
  send: { type: "object", properties: sentSchema },
  ask: {
    type: "object",
    properties: {
      ...sentSchema,
      id: { type: "string", description: "The question's id, for cancel" },
      expires_at: { type: "string" },
      approvers: { type: "array", items: { type: "string" } },
      can_answer: { type: "array", items: { type: "string" }, description: "The approvers with a way to answer: a link of their own, or Telegram's buttons" },
    },
  },
  cancel: { type: "object", properties: { canceled: { type: "boolean" }, status: { enum: ["canceled", "decided", "expired", "unknown"] } } },
};

// --- the settings, checked ---

const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false, allowUnionTypes: true });
const validators = new WeakMap<Preset, Record<string, (v: unknown) => boolean>>();

// toolSchemas are the schemas of the tools gosidian calls: an image is a
// reference by then ({name, mime, size, sha256, url}), which image.ts reads.
export function toolSchemas(p: Preset): Record<string, Record<string, unknown>> {
  const s: Record<string, any> = structuredClone(inputSchemas(p));
  for (const n of ["send", "ask"]) s[n].properties.image = { description: s[n].properties.image.description };
  return s;
}

function settings(p: Preset, node: string, args: Record<string, unknown>): any {
  let v = validators.get(p);
  if (!v) {
    const s = toolSchemas(p);
    v = { send: ajv.compile(s.send), ask: ajv.compile(s.ask), cancel: ajv.compile(s.cancel) };
    validators.set(p, v);
  }
  const a = structuredClone(args ?? {});
  const validate: any = v[node];
  if (!validate(a)) throw new NodeError(ajv.errorsText(validate.errors, { dataVar: "with" }));
  return a;
}

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// noteLink is a note's address in gosidian's web UI: a path of the project
// (one that does not start with it is relative to it), .md added.
export function noteLink(p: Preset, project: string, note: string): string {
  if (!p.gosidian_url) throw new NodeError("with.note: the preset has no gosidian_url, the address of gosidian's web UI");
  let path = note.trim().replace(/^\/+/, "");
  if (!path.startsWith(`${project}/`)) path = `${project}/${path}`;
  if (/(^|\/)\.{1,2}(\/|$)/.test(path) || /\/\//.test(path) || /[\x00-\x1f\x7f\\]/.test(path) || path.endsWith("/")) {
    throw new NodeError(`with.note ${JSON.stringify(note)}: a plain path inside the project`);
  }
  if (!/\.md$/i.test(path)) path += ".md";
  return `${p.gosidian_url}/notes/${path.split("/").map(encodeURIComponent).join("/")}`;
}

// resumeTarget checks a question's resume_url: gosidian's resume address
// ({{ run.resume_url }}) of the call's run, at gosidian_url or gosidian_api
// (or a path); the answer goes to the same address at gosidian_api.
export function resumeTarget(p: Preset, v: string, run: string | null): string {
  if (!p.gosidian_api) throw new NodeError("with.resume_url: the preset names no gosidian_url (nor gosidian_api): the plugin hands an answer to gosidian only");
  const bad = (why: string) => new NodeError(`with.resume_url: ${why}`);
  let u: URL;
  try {
    u = new URL(v, `${p.gosidian_api}/`);
  } catch {
    throw bad("not an address");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
    const origins = [p.gosidian_url, p.gosidian_api].filter(Boolean).map((x) => new URL(x).origin);
    if (!origins.includes(u.origin) || u.username || u.password) throw bad("not an address of gosidian's (the preset's gosidian_url or gosidian_api): an answer goes to gosidian only");
  }
  const m = /\/api\/v1\/runs\/([A-Za-z0-9_-]{1,100})\/resume$/.exec(u.pathname);
  const key = u.searchParams.get("key");
  if (!m || !key || ![...u.searchParams.keys()].every((k) => k === "key" || k === "step")) throw bad("not the resume address of a run ({{ run.resume_url }})");
  if (run && m[1] !== run) throw bad("another run's: a question resumes the run that asks it");
  const step = u.searchParams.get("step");
  return `${p.gosidian_api}/api/v1/runs/${m[1]}/resume?key=${encodeURIComponent(key)}${step ? `&step=${encodeURIComponent(step)}` : ""}`;
}

// message is what a node's settings say, made plain: the title on one line,
// cut; the text, kept up to the longest a channel takes; the link.
function message(p: Preset, s: any, project: string): Msg {
  const title = capUnits(clean(s.title ?? "", false), p.limits.title);
  const text = capUnits(clean(s.text ?? "", true), Math.max(p.limits.text.telegram, p.limits.text.ntfy, p.limits.text.email));
  if (!title && !text) throw new NodeError("with: a title or a text, and not empty once made plain");
  if (s.link !== undefined && s.note !== undefined) throw new NodeError("with: link or note, not both");
  let link = "";
  if (s.link !== undefined) {
    const why = linkError(s.link);
    if (why) throw new NodeError(`with.link: ${why}`);
    link = new URL(s.link).href;
  } else if (s.note !== undefined) {
    link = noteLink(p, project, s.note);
  }
  return { project, title, text, link, priority: (s.priority ?? "normal") as Priority, ...(s.key ? { key: s.key } : {}) };
}

// image fetches a node's image, when it has one.
async function image(p: Preset, s: any, signal?: AbortSignal): Promise<Image | undefined> {
  if (s.image === undefined || s.image === null) return undefined;
  return fetchImage(p, s.image, signal);
}

// verdict applies require: the error that fails the node, or "".
function verdict(entries: Entry[], require: "any" | "all"): string {
  const failed = entries.filter((e) => e.status === "failed");
  const what = failed.map((e) => `${e.to}${e.channel ? `/${e.channel}` : ""}: ${e.error}`).join("; ");
  if (failed.length && failed.length === entries.length) return `nothing went: ${what}`;
  if (require === "all" && failed.length) return `not every channel went (require: all): ${what}`;
  return "";
}

function said(entries: Entry[]): string {
  const c = summary(entries);
  const out = (["sent", "held", "grouped", "failed"] as const).filter((k) => c[k]).map((k) => `${c[k]} ${k}`).join(", ") || "nothing";
  const dropped = entries.filter((e) => e.image === "dropped").length;
  return dropped ? `${out}; ${dropped} without the image` : out;
}

// --- the nodes ---

export async function send(env: Env, args: Record<string, unknown>, meta: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
  const project = projectOf(meta);
  const s = settings(env.preset, "send", args);
  const dests = resolve(env, list(s.to));
  const msg = message(env.preset, s, project);
  const img = await image(env.preset, s, signal);
  if (img) msg.image = metaOf(img);
  const entries = await dispatch(env, { msg, only: s.channels, passes: (p) => p === "high" || p === "urgent", image: img }, dests, signal);
  const id = newId();
  const counts = summary(entries);
  env.log("notice", { id, project, run: runOf(meta), to: dests.map((d) => d.key), priority: msg.priority, ...(img ? { image: { mime: img.mime, size: img.size } } : {}), ...counts });
  const why = verdict(entries, s.require);
  if (why) throw new NodeError(why);
  return { output: { id, ok: counts.failed === 0, sent: entries, counts }, text: `${said(entries)}: ${dests.map((d) => d.key).join(", ")}` };
}

export async function ask(env: Env, args: Record<string, unknown>, meta: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
  const p = env.preset;
  const project = projectOf(meta);
  const s = settings(p, "ask", args);
  const dests = resolve(env, list(s.to));
  const msg = message(p, s, project);
  const allowed = s.approvers !== undefined ? people(env, list(s.approvers), "with.approvers") : dests.filter((d) => d.kind === "person").map((d) => d.key);
  if (!allowed.length) throw new NodeError("with.approvers: a question to rooms names who may answer it");
  let wait: number;
  try {
    wait = seconds(s.expires, "with.expires");
  } catch (e) {
    throw new NodeError((e as Error).message);
  }
  if (wait > p.limits.max_expires) throw new NodeError(`with.expires ${s.expires}: more than the preset's ${formatDuration(p.limits.max_expires)} (limits.max_expires)`);
  const choices = (s.choices as string[]).map((c) => clean(c, false));
  if (choices.some((c) => !c) || new Set(choices).size !== choices.length) throw new NodeError("with.choices: each one plain, not empty, and different from the others");
  const run = runOf(meta);
  const resume = resumeTarget(p, s.resume_url, run);
  const now = env.now();
  const q: Question = {
    id: newId(),
    project,
    run,
    title: msg.title,
    text: msg.text,
    link: msg.link,
    priority: msg.priority,
    choices,
    allowed,
    tokens: {},
    resume,
    created: now,
    expires: now + wait * 1000,
    status: "open",
    telegram: [],
  };
  const can = answerers(env, q, dests, s.channels);
  if (!can.length) {
    throw new NodeError(
      `no one can answer: ${allowed.join(", ")} would need Telegram's buttons (a user id in the preset, and a room or their own chat on Telegram) or a link to the reply page (ntfy or email of their own, and the plugin's public_url${p.public_url ? "" : ", which is not set: NOTIFY_PUBLIC_URL"})`,
    );
  }
  const img = await image(p, s, signal);
  if (img) q.image = metaOf(img);
  env.store.data.questions[q.id] = q;
  env.store.save();
  const entries = await dispatch(env, { msg, only: s.channels, question: q, outgoing: (d) => questionOutgoing(env, q, d, s.channels, img), passes: (pr) => pr === "urgent", image: img }, dests, signal);
  const counts = summary(entries);
  env.log("question", { id: q.id, project, run, to: dests.map((d) => d.key), approvers: allowed, expires: new Date(q.expires).toISOString(), ...(img ? { image: { mime: img.mime, size: img.size } } : {}), ...counts });
  const why = verdict(entries, s.require);
  if (why) {
    close(env, q, "canceled");
    throw new NodeError(why);
  }
  return {
    output: { id: q.id, ok: counts.failed === 0, sent: entries, counts, expires_at: new Date(q.expires).toISOString(), approvers: allowed, can_answer: can },
    text: `asked ${dests.map((d) => d.key).join(", ")} (${said(entries)}); ${can.join(", ")} can answer, until ${new Date(q.expires).toISOString()}`,
  };
}

export async function cancel(env: Env, args: Record<string, unknown>, meta: Record<string, unknown>): Promise<Result> {
  const project = projectOf(meta);
  const s = settings(env.preset, "cancel", args);
  const r = cancelQuestion(env, s.id, project);
  return { output: r, text: r.canceled ? `withdrew ${s.id}` : r.status === "unknown" ? `no question ${s.id} in this project` : `${s.id} is already ${r.status}` };
}
