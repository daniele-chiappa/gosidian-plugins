// The plugin's nodes: publish, check, unpublish, list. Each reads the
// call's project from its _meta (gosidian/project): a preview belongs to
// the project that published it, and only that project's calls check it,
// remove it or list it.
import fs from "node:fs";
import path from "node:path";
import { Ajv } from "ajv";
import { fetchTo, NodeError, refOf } from "./files.ts";
import { formatBytes, formatDuration, seconds, type Preset } from "./preset.ts";
import { ID, newId, type Meta, type Store } from "./store.ts";
import { nameError, typeOf, unpack, ZipError } from "./zip.ts";
import { ACTIONS, runCheck, stepError, type CheckResult, type Step } from "./check.ts";

export { NodeError };

export const META = { project: "gosidian/project", run: "gosidian/run" } as const;
const MAX_CHECK_TIMEOUT = 600;
const ZIP_SLACK = 8 << 20;

export interface Env {
  preset: Preset;
  store: Store;
  log: (msg: string, fields?: Record<string, unknown>) => void;
  // checks lets a few checks run at once; the others wait.
  checks: Gate;
}

export interface Result {
  output: Record<string, unknown>;
  text: string;
  files?: { name: string; mime: string; data: Buffer }[];
}

// Gate runs at most n tasks at once, in arrival order.
export class Gate {
  private busy = 0;
  private queue: (() => void)[] = [];
  private readonly n: number;
  constructor(n: number) {
    this.n = Math.max(1, n);
  }
  async run<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    if (this.busy >= this.n) {
      await new Promise<void>((ok, fail) => {
        const go = () => ok();
        this.queue.push(go);
        signal?.addEventListener("abort", () => {
          this.queue = this.queue.filter((q) => q !== go);
          fail(new NodeError("the call was canceled while waiting for another check to end"));
        }, { once: true });
      });
    }
    this.busy++;
    try {
      return await fn();
    } finally {
      this.busy--;
      this.queue.shift()?.();
    }
  }
}

// projectOf is the call's project; a call without one is refused, since a
// preview is its project's.
export function projectOf(meta: Record<string, unknown> | undefined): string {
  const p = meta?.[META.project];
  if (typeof p !== "string" || !p || p.length > 200) throw new NodeError("the call names no project (_meta gosidian/project): gosidian sends it with every node's call");
  return p;
}

export function urlOf(p: Preset, id: string): string {
  return `${p.public_url}/p/${id}/`;
}

// --- the schemas, as a pipeline writes the settings ---

const durationSetting = { type: ["string", "integer"], description: "Seconds, or 12h, 3d" };

export function publishSchema(p: Preset): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["site"],
    properties: {
      // As a pipeline writes it: gosidian hands the tool a reference instead.
      site: {
        description: "The zip of the site, its files at the root (index.html): a vault path, as exec's out/site.zip comes back",
        anyOf: [{ type: "string" }, { type: "object", required: ["path"] }, { type: "array", minItems: 1, maxItems: 1 }],
      },
      ttl: { ...durationSetting, default: formatDuration(p.limits.ttl), description: `How long the preview lives: seconds, or 12h, 3d; at most ${formatDuration(p.limits.max_ttl)}` },
      index: { type: "string", default: "index.html", minLength: 1, maxLength: 1024, description: "The page served at the preview's root, a file of the zip" },
      spa: { type: "boolean", default: false, description: "true: a path that is not a file and has no extension gets the index (a client-side router)" },
      title: { type: "string", maxLength: 200, description: "A name for the list" },
    },
  };
}

const stepSchemas = [
  { required: ["action"], properties: { action: { const: "goto" }, path: { type: "string", description: "A path under the preview; empty: its index" } } },
  { required: ["action", "selector"], properties: { action: { const: "click" }, selector: { type: "string" } } },
  { required: ["action", "selector", "value"], properties: { action: { const: "fill" }, selector: { type: "string" }, value: { type: "string" } } },
  { required: ["action", "selector", "value"], properties: { action: { const: "select" }, selector: { type: "string" }, value: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } } },
  { required: ["action", "key"], properties: { action: { const: "press" }, selector: { type: "string" }, key: { type: "string", description: "Enter, Tab, ArrowDown, Control+A…" } } },
  { required: ["action"], properties: { action: { const: "wait_for" }, selector: { type: "string" }, text: { type: "string" } } },
  { required: ["action", "text"], properties: { action: { const: "expect_text" }, selector: { type: "string", description: "Default the whole page" }, text: { type: "string", description: "A part of the element's text" } } },
  { required: ["action", "selector", "count"], properties: { action: { const: "expect_count" }, selector: { type: "string" }, count: { type: "integer", minimum: 0 } } },
  { required: ["action"], properties: { action: { const: "screenshot" }, name: { type: "string" }, full_page: { type: "boolean" } } },
];

export function checkSchema(p: Preset): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", pattern: ID.source, description: "A live preview of the project" },
      url: { type: "string", description: `An address under ${p.public_url || "<public_url>"}/p/<id>/ of a live preview of the project; never another` },
      viewport: {
        type: "object",
        additionalProperties: false,
        properties: { width: { type: "integer", minimum: 200, maximum: 3840, default: 1280 }, height: { type: "integer", minimum: 200, maximum: 4320, default: 800 } },
      },
      steps: {
        type: "array",
        maxItems: p.playwright.max_steps,
        description: `What a person does, one action after another (${ACTIONS.join(", ")}); a step that fails stops the others. Selectors are Playwright's (CSS, text=…); an action takes the first element that matches. Each step may set timeout, seconds (default 10)`,
        items: {
          type: "object",
          required: ["action"],
          properties: { action: { enum: [...ACTIONS] }, timeout: { type: "number", exclusiveMinimum: 0, maximum: 600 } },
          oneOf: stepSchemas,
        },
      },
      timeout: { type: "integer", minimum: 1, maximum: Math.max(MAX_CHECK_TIMEOUT, p.playwright.timeout), default: p.playwright.timeout, description: "Seconds, for the whole check" },
    },
  };
}

const idOnly = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", pattern: ID.source } },
};

export const outputSchemas = {
  publish: {
    type: "object",
    properties: {
      id: { type: "string" },
      url: { type: "string", description: "Where a person opens it, until expires_at" },
      expires_at: { type: "string" },
      files: { type: "integer" },
      bytes: { type: "integer" },
      title: { type: "string" },
    },
  },
  check: {
    type: "object",
    properties: {
      ok: { type: "boolean", description: "With steps: every step passed. Without: the page loaded with no error in its console and no failed request" },
      url: { type: "string", description: "The page at the end" },
      error: { type: "string", description: "Why the first page did not open" },
      steps: { type: "array", items: { type: "object", properties: { action: { type: "string" }, ok: { type: "boolean" }, ms: { type: "integer" }, error: { type: "string" }, not_run: { type: "boolean" }, screenshot: { type: "string" } } } },
      console: { type: "array", items: { type: "object", properties: { type: { type: "string" }, text: { type: "string" } } }, description: "The page's errors and warnings, and its uncaught exceptions (pageerror), at most 50" },
      failed_requests: { type: "array", items: { type: "object" }, description: "{url, status} or {url, error}, at most 50" },
      screenshots: { type: "array", items: { type: "string" }, description: "The names of the screenshots, in files" },
      seconds: { type: "number" },
      browser: { type: "string" },
      files: { type: "array", description: "The screenshots, stored by gosidian" },
    },
  },
  unpublish: { type: "object", properties: { removed: { type: "boolean" } } },
  list: {
    type: "object",
    properties: {
      previews: { type: "array", items: { type: "object", properties: { id: { type: "string" }, url: { type: "string" }, title: { type: "string" }, created_at: { type: "string" }, expires_at: { type: "string" }, files: { type: "integer" }, bytes: { type: "integer" } } } },
    },
  },
};

export function inputSchemas(p: Preset): Record<string, Record<string, unknown>> {
  return { publish: publishSchema(p), check: checkSchema(p), unpublish: idOnly, list: { type: "object", additionalProperties: false, properties: {} } };
}

// --- the settings, checked ---

const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
const validators = new WeakMap<Preset, Record<string, (v: unknown) => boolean>>();

function settings(p: Preset, node: string, args: Record<string, unknown>): any {
  let v = validators.get(p);
  if (!v) {
    const s = inputSchemas(p);
    // site is a reference by now: refOf reads it. The steps are read by
    // stepError, whose errors say more than oneOf's.
    const pub: any = structuredClone(s.publish);
    pub.properties.site = {};
    const chk: any = structuredClone(s.check);
    chk.properties.steps = { type: "array", maxItems: p.playwright.max_steps };
    v = { publish: ajv.compile(pub), check: ajv.compile(chk), unpublish: ajv.compile(s.unpublish), list: ajv.compile(s.list) };
    validators.set(p, v);
  }
  const a = structuredClone(args ?? {});
  const validate: any = v[node];
  if (!validate(a)) throw new NodeError(ajv.errorsText(validate.errors, { dataVar: "with" }));
  return a;
}

// --- the nodes ---

export async function publish(env: Env, args: Record<string, unknown>, meta: Record<string, unknown>, signal: AbortSignal): Promise<Result> {
  const { preset: p, store } = env;
  const project = projectOf(meta);
  const s = settings(p, "publish", args);
  if (!p.public_url) throw new NodeError("the plugin does not know where it is reached: set PREVIEW_PUBLIC_URL (or public_url in the preset)");
  const ref = refOf(s.site, "site");
  let ttl: number;
  try {
    ttl = seconds(s.ttl, "with.ttl");
  } catch (e) {
    throw new NodeError((e as Error).message);
  }
  if (ttl > p.limits.max_ttl) throw new NodeError(`with.ttl ${s.ttl}: more than the preset's ${formatDuration(p.limits.max_ttl)} (limits.max_ttl)`);
  const why = nameError(s.index);
  if (why || s.index.endsWith("/")) throw new NodeError(`with.index ${JSON.stringify(s.index)}: ${why || "a folder, not a file"}`);
  if (!/^text\/html/.test(typeOf(s.index, p.types))) throw new NodeError(`with.index ${s.index}: not a page (.html or .htm)`);
  const id = newId();
  const zipFile = path.join(store.dir, `${id}.zip`);
  const tmp = path.join(store.dir, `${id}.tmp`);
  try {
    await fetchTo(ref, zipFile, p.limits.max_bytes + ZIP_SLACK, signal);
    return await store.exclusive(async () => {
      store.sweep();
      const room = p.limits.max_total_bytes - store.used();
      fs.mkdirSync(tmp, { mode: 0o750 });
      let u;
      try {
        u = await unpack(zipFile, path.join(tmp, "site"), { ...p.limits, types: p.types, index: s.index, room });
      } catch (e) {
        if (e instanceof ZipError) throw new NodeError(`site: ${e.message}`);
        throw e;
      }
      const m: Meta = {
        id,
        project,
        run: typeof meta[META.run] === "string" ? (meta[META.run] as string) : null,
        title: s.title ?? "",
        created: store.isoAt(),
        expires: store.isoAt(ttl),
        bytes: u.bytes,
        files: u.files,
        index: s.index,
        spa: Boolean(s.spa),
      };
      store.add(tmp, m);
      env.log("preview published", { id, project, run: m.run, files: m.files, bytes: m.bytes, expires: m.expires });
      const url = urlOf(p, id);
      return {
        output: { id, url, expires_at: m.expires, files: m.files, bytes: m.bytes, ...(m.title ? { title: m.title } : {}) },
        text: `published ${m.files} files (${formatBytes(m.bytes)}) at ${url}, until ${m.expires}`,
      };
    });
  } finally {
    fs.rmSync(zipFile, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// target finds the preview a check names, by id or by an address under it:
// a live preview of the call's project, or an error that says no more.
export function target(p: Preset, store: Store, project: string, s: { id?: string; url?: string }): { id: string; start: string } {
  if (!p.public_url) throw new NodeError("the plugin does not know where it is reached: set PREVIEW_PUBLIC_URL (or public_url in the preset)");
  let id = s.id;
  let start: string | undefined;
  if (s.url !== undefined) {
    let u: URL;
    try {
      u = new URL(s.url);
    } catch {
      throw new NodeError(`with.url ${JSON.stringify(s.url)}: not an address`);
    }
    const prefix = `${p.public_url}/p/`;
    const href = u.href;
    const m = href.startsWith(prefix) && !u.username && !u.password ? /^([a-z2-7]{26})\//.exec(href.slice(prefix.length)) : null;
    if (!m) throw new NodeError(`with.url ${s.url}: not an address of a preview (${prefix}<id>/…); a check opens only its project's previews`);
    if (id && id !== m[1]) throw new NodeError("with.id and with.url name two previews");
    id = m[1];
    start = href;
  }
  if (!id) throw new NodeError("with: id or url, of a preview of the project");
  const meta = store.get(id);
  if (!meta || meta.project !== project) throw new NodeError(`no live preview ${id} in this project`);
  return { id, start: start ?? urlOf(p, id) };
}

export async function check(env: Env, args: Record<string, unknown>, meta: Record<string, unknown>, signal: AbortSignal): Promise<Result> {
  const { preset: p, store } = env;
  const project = projectOf(meta);
  const s = settings(p, "check", args);
  const steps: Step[] = s.steps ?? [];
  for (const [i, st] of steps.entries()) {
    const why = stepError(st, i);
    if (why) throw new NodeError(`with.${why}`);
  }
  const t = target(p, store, project, s);
  if (!p.playwright.ws_endpoint) throw new NodeError("the preset names no Playwright server: playwright.ws_endpoint (or PREVIEW_PLAYWRIGHT_WS)");
  const r: CheckResult = await env.checks.run(signal, () =>
    runCheck({
      ws_endpoint: p.playwright.ws_endpoint,
      base: urlOf(p, t.id),
      start: t.start,
      steps,
      viewport: { width: s.viewport?.width ?? 1280, height: s.viewport?.height ?? 800 },
      timeout: s.timeout,
      connect: p.connect,
      signal,
    }),
  );
  env.log("preview checked", { id: t.id, project, ok: r.ok, steps: r.steps.length, seconds: r.seconds });
  const { screenshots, ...rest } = r;
  const failedStep = r.steps.find((x) => !x.ok && !x.not_run);
  return {
    output: { ...rest, screenshots: screenshots.map((x) => x.name) },
    text: r.ok
      ? `ok: ${r.steps.length ? `${r.steps.length} steps passed` : "the page loaded with no errors"} in ${r.seconds} s`
      : `not ok: ${r.error ?? (failedStep ? `step ${r.steps.indexOf(failedStep) + 1} (${failedStep.action}): ${failedStep.error}` : `${r.console.filter((c) => c.type === "error" || c.type === "pageerror").length} errors in the console, ${r.failed_requests.length} failed requests`)}`,
    files: screenshots.map((x) => ({ name: x.name, mime: "image/png", data: x.data })),
  };
}

export async function unpublish(env: Env, args: Record<string, unknown>, meta: Record<string, unknown>): Promise<Result> {
  const project = projectOf(meta);
  const s = settings(env.preset, "unpublish", args);
  // An expired preview the sweep has not reached yet is removed too; one
  // of another project is not, and the answer is the same as for none.
  const removed = env.store.peek(s.id)?.project === project && env.store.remove(s.id);
  if (removed) env.log("preview removed", { id: s.id, project });
  return { output: { removed }, text: removed ? `removed ${s.id}` : `no preview ${s.id} in this project` };
}

export async function list(env: Env, args: Record<string, unknown>, meta: Record<string, unknown>): Promise<Result> {
  const project = projectOf(meta);
  settings(env.preset, "list", args);
  const previews = env.store.ofProject(project).map((m) => ({
    id: m.id,
    url: env.preset.public_url ? urlOf(env.preset, m.id) : null,
    title: m.title,
    created_at: m.created,
    expires_at: m.expires,
    files: m.files,
    bytes: m.bytes,
  }));
  return { output: { previews }, text: `${previews.length} live previews` };
}
