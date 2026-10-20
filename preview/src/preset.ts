// The preset of a preview plugin: where it is reached (public_url), where
// the previews live, the limits of a preview and of the store, the types it
// serves, whether a preview's pages may reach other hosts, and the
// Playwright server its check node drives. One container serves one preset,
// and registers in gosidian under the preset's name.
import fs from "node:fs";
import YAML from "yaml";
import { Ajv } from "ajv";

export interface Limits {
  // ttl is a preview's life when the node gives none, max_ttl the longest
  // a node may ask; seconds.
  ttl: number;
  max_ttl: number;
  // A preview's files, and their bytes once unpacked.
  max_files: number;
  max_bytes: number;
  // The bytes of every live preview together.
  max_total_bytes: number;
  // The unpacked bytes over the zip's: of the whole archive, and of each
  // entry over 1 MiB.
  max_ratio: number;
  // The folders a file may be in.
  max_depth: number;
}

export interface Playwright {
  // ws_endpoint is the Playwright server (playwright run-server); empty:
  // the check node fails.
  ws_endpoint: string;
  // timeout is a check's, when the node gives none, in seconds; the node
  // may ask up to 10 times as much.
  timeout: number;
  max_steps: number;
}

export interface Preset {
  name: string;
  description: string;
  // public_url is where a person's browser and the Playwright server reach
  // the plugin's HTTP port, without a trailing slash; empty: publish and
  // check fail.
  public_url: string;
  store_dir: string;
  limits: Limits;
  // types maps an extension (lower case, no dot) to the Content-Type it is
  // served with; a file of another extension makes a zip refused.
  types: Record<string, string>;
  // connect: open, a preview's scripts may call any host (fetch, XHR,
  // WebSocket); self, only the preview's own files.
  connect: "open" | "self";
  playwright: Playwright;
}

export const DEFAULT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  wasm: "application/wasm",
};

const DAY = 86400;
export const DEFAULT_LIMITS: Limits = {
  ttl: 7 * DAY,
  max_ttl: 30 * DAY,
  max_files: 2000,
  max_bytes: 100 << 20,
  max_total_bytes: 2 * 2 ** 30,
  max_ratio: 100,
  max_depth: 16,
};
export const DEFAULT_STORE = "/var/lib/gosidian-preview";
const DEFAULT_CHECK_TIMEOUT = 60;
const DEFAULT_MAX_STEPS = 50;

const durationSchema = { type: ["integer", "string"] };
const sizeSchema = { type: ["integer", "string"] };

const presetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
    description: { type: "string" },
    public_url: { type: "string" },
    store_dir: { type: "string", pattern: "^/[^\\x00-\\x1f]{0,1023}$" },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        ttl: durationSchema,
        max_ttl: durationSchema,
        max_files: { type: "integer", minimum: 1, maximum: 1000000 },
        max_bytes: sizeSchema,
        max_total_bytes: sizeSchema,
        max_ratio: { type: "number", minimum: 1 },
        max_depth: { type: "integer", minimum: 1, maximum: 64 },
      },
    },
    types: {
      type: "object",
      propertyNames: { pattern: "^[a-z0-9][a-z0-9_+-]{0,15}$" },
      additionalProperties: {
        anyOf: [{ type: "null" }, { type: "string", pattern: "^[a-z0-9.+-]+/[a-z0-9.+-]+(; ?charset=[a-z0-9_-]+)?$" }],
      },
    },
    connect: { enum: ["open", "self"] },
    playwright: {
      type: "object",
      additionalProperties: false,
      properties: {
        ws_endpoint: { type: "string" },
        timeout: durationSchema,
        max_steps: { type: "integer", minimum: 1, maximum: 500 },
      },
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

// bytes reads a size: a number of bytes, or "512KiB", "100MiB", "2GiB"
// (also KB, MB, GB, of 1000).
export function bytes(v: unknown, what: string): number {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  const m = typeof v === "string" ? /^(\d+)\s*(B|KiB|MiB|GiB|KB|MB|GB)?$/.exec(v.trim()) : null;
  if (!m) throw new Error(`${what}: ${JSON.stringify(v)} is not a size (bytes, or 512KiB, 100MiB, 2GiB)`);
  const unit = { B: 1, KiB: 2 ** 10, MiB: 2 ** 20, GiB: 2 ** 30, KB: 1e3, MB: 1e6, GB: 1e9 }[m[2] ?? "B"]!;
  const n = Number(m[1]) * unit;
  if (n <= 0) throw new Error(`${what}: the size is zero`);
  return n;
}

// publicURL checks an address the browsers reach the plugin at: http(s),
// no query or fragment, no trailing slash.
export function publicURL(v: string, what: string): string {
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

function wsEndpoint(v: string, what: string): string {
  if (!v) return "";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${what}: ${JSON.stringify(v)} is not an address`);
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") throw new Error(`${what}: ${v} is not ws(s)`);
  return u.toString();
}

// parsePreset checks a preset (YAML) and fills in its defaults; the
// environment gives public_url (PREVIEW_PUBLIC_URL) and the Playwright
// server (PREVIEW_PLAYWRIGHT_WS) when the preset does not.
export function parsePreset(text: string, file = "preset", env: Record<string, string | undefined> = process.env): Preset {
  const raw: any = YAML.parse(text) ?? {};
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  const validate = ajv.compile(presetSchema);
  // A plain boolean: the type guard would narrow raw to {}.
  if (!(validate as (d: unknown) => boolean)(raw)) {
    throw new Error(`${file}: ${ajv.errorsText(validate.errors, { dataVar: "preset" })}`);
  }
  const rl = raw.limits ?? {};
  const limits: Limits = {
    ttl: rl.ttl !== undefined ? seconds(rl.ttl, `${file}: limits.ttl`) : DEFAULT_LIMITS.ttl,
    max_ttl: rl.max_ttl !== undefined ? seconds(rl.max_ttl, `${file}: limits.max_ttl`) : DEFAULT_LIMITS.max_ttl,
    max_files: rl.max_files ?? DEFAULT_LIMITS.max_files,
    max_bytes: rl.max_bytes !== undefined ? bytes(rl.max_bytes, `${file}: limits.max_bytes`) : DEFAULT_LIMITS.max_bytes,
    max_total_bytes: rl.max_total_bytes !== undefined ? bytes(rl.max_total_bytes, `${file}: limits.max_total_bytes`) : DEFAULT_LIMITS.max_total_bytes,
    max_ratio: rl.max_ratio ?? DEFAULT_LIMITS.max_ratio,
    max_depth: rl.max_depth ?? DEFAULT_LIMITS.max_depth,
  };
  if (limits.ttl > limits.max_ttl) throw new Error(`${file}: limits.ttl ${limits.ttl} s is over limits.max_ttl ${limits.max_ttl} s`);
  if (limits.max_bytes > limits.max_total_bytes) throw new Error(`${file}: limits.max_bytes is over limits.max_total_bytes`);
  const types = { ...DEFAULT_TYPES };
  for (const [ext, ct] of Object.entries(raw.types ?? {})) {
    if (ct === null) delete types[ext];
    else types[ext] = String(ct);
  }
  if (!types.html && !types.htm) throw new Error(`${file}: types: without html or htm there is no page to serve`);
  const rp = raw.playwright ?? {};
  return {
    name: raw.name,
    description: raw.description ?? `Previews of static web apps, and their checks with a browser (${raw.name})`,
    public_url: publicURL(raw.public_url ?? env.PREVIEW_PUBLIC_URL ?? "", raw.public_url ? `${file}: public_url` : "PREVIEW_PUBLIC_URL"),
    store_dir: String(raw.store_dir ?? DEFAULT_STORE).replace(/(.)\/+$/, "$1"),
    limits,
    types,
    connect: raw.connect ?? "open",
    playwright: {
      ws_endpoint: wsEndpoint(rp.ws_endpoint ?? env.PREVIEW_PLAYWRIGHT_WS ?? "", rp.ws_endpoint ? `${file}: playwright.ws_endpoint` : "PREVIEW_PLAYWRIGHT_WS"),
      timeout: rp.timeout !== undefined ? seconds(rp.timeout, `${file}: playwright.timeout`) : DEFAULT_CHECK_TIMEOUT,
      max_steps: rp.max_steps ?? DEFAULT_MAX_STEPS,
    },
  };
}

// loadPreset reads the preset's file; with no file at the default path, a
// preset of defaults named preview.
export function loadPreset(file: string, explicit: boolean, env: Record<string, string | undefined> = process.env): Preset {
  if (!explicit && !fs.existsSync(file)) return parsePreset("name: preview\n", "the default preset", env);
  return parsePreset(fs.readFileSync(file, "utf8"), file, env);
}

// hostOf is a ws(s) address's host and port, as the manifest's network
// lists it.
export function hostOf(u: string): string {
  const url = new URL(u);
  return url.port ? url.host : `${url.host}:${url.protocol === "wss:" ? 443 : 80}`;
}

// formatDuration says a number of seconds in its largest whole unit.
export function formatDuration(s: number): string {
  for (const [unit, n] of [["d", DAY], ["h", 3600], ["m", 60]] as const) if (s % n === 0) return `${s / n}${unit}`;
  return `${s}s`;
}

export function formatBytes(n: number): string {
  if (n >= 2 ** 30 && n % 2 ** 30 === 0) return `${n / 2 ** 30} GiB`;
  if (n >= 2 ** 20) return `${Math.round((n / 2 ** 20) * 10) / 10} MiB`;
  if (n >= 2 ** 10) return `${Math.round((n / 2 ** 10) * 10) / 10} KiB`;
  return `${n} bytes`;
}
