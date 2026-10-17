// The preset of an agent: the credentials, the version of Claude Code, the
// models and effort levels a node may pick, the tools it may allow and the
// limits of a step. One container serves one preset, and registers in
// gosidian under the preset's name.
import fs from "node:fs";
import YAML from "yaml";
import { Ajv } from "ajv";

// The effort levels Claude Code 2.1.301 takes (--effort). A version that
// takes others says so in its --help, which the plugin reads at install.
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// Claude Code's read-only tools: the default. Write, Edit, Bash, WebFetch
// and the others are allowed by a preset on purpose.
export const READ_ONLY = ["Read", "Grep", "Glob"];

export const DEFAULT_MODELS = ["haiku", "sonnet", "opus"];

export interface Limits {
  max_turns: number;
  max_seconds: number;
  max_budget_usd: number;
}

export interface Credentials {
  // oauth: a subscription's token (claude setup-token), sent as a bearer;
  // api_key: a key of the Claude API, sent as x-api-key.
  kind: "oauth" | "api_key";
  // Where the server reads it: a file, or a variable of its environment.
  file?: string;
  env?: string;
}

export interface Preset {
  name: string;
  description: string;
  credentials: Credentials;
  // upstream is the API the proxy forwards to.
  upstream: string;
  // version is the version of Claude Code to install when none is: a tag
  // of the npm registry (latest, stable, next) or a version (2.1.301).
  version: string;
  // models are aliases (haiku, sonnet, opus), which each version of Claude
  // Code resolves to a model of its own, or full model ids.
  models: string[];
  effort: { allowed: string[]; default?: string };
  tools: { allowed: string[]; default: string[] };
  limits: { default: Limits; max: Limits; min_left_percent: { session: number; week: number } };
  system: string;
}

const limitsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    max_turns: { type: "integer", minimum: 1 },
    max_seconds: { type: ["integer", "string"] },
    max_budget_usd: { type: "number", exclusiveMinimum: 0 },
  },
};

const percent = { type: "number", minimum: 0, maximum: 100 };
const toolName = { type: "string", pattern: "^[A-Z][A-Za-z0-9_]{1,63}$" };

const presetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "credentials"],
  properties: {
    name: { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" },
    description: { type: "string" },
    credentials: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 1,
      properties: {
        oauth_token_file: { type: "string", minLength: 1 },
        oauth_token_env: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        api_key_file: { type: "string", minLength: 1 },
        api_key_env: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
      },
    },
    upstream: { type: "string", pattern: "^https?://" },
    version: { type: "string", pattern: "^(latest|stable|next|\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?)$" },
    models: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:\\[\\]-]{0,127}$" },
    },
    effort: {
      type: "object",
      additionalProperties: false,
      properties: {
        allowed: { type: "array", items: { type: "string", pattern: "^[a-z]{1,16}$" }, uniqueItems: true },
        default: { type: "string" },
      },
    },
    tools: {
      type: "object",
      additionalProperties: false,
      properties: {
        allowed: { type: "array", items: toolName, uniqueItems: true },
        default: { type: "array", items: toolName, uniqueItems: true },
      },
    },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        default: limitsSchema,
        max: limitsSchema,
        min_left_percent: {
          type: "object",
          additionalProperties: false,
          properties: { session: percent, week: percent },
        },
      },
    },
    system: { type: "string" },
  },
};

const DEFAULT_LIMITS: Limits = { max_turns: 20, max_seconds: 600, max_budget_usd: 1 };
const MAX_LIMITS: Limits = { max_turns: 100, max_seconds: 840, max_budget_usd: 10 };

// seconds reads a duration: a number of seconds, or "90s", "10m", "1h".
export function seconds(v: unknown, what: string): number {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v);
  const m = typeof v === "string" ? /^(\d+)\s*(s|m|h)?$/.exec(v.trim()) : null;
  if (!m) throw new Error(`${what}: ${JSON.stringify(v)} is not a duration (seconds, or 90s, 10m, 1h)`);
  const n = Number(m[1]) * ({ s: 1, m: 60, h: 3600 } as Record<string, number>)[m[2] ?? "s"];
  if (n <= 0) throw new Error(`${what}: the duration is zero`);
  return n;
}

function limits(raw: any, fallback: Limits, what: string): Limits {
  const l = { ...fallback, ...(raw ?? {}) };
  return { ...l, max_seconds: seconds(l.max_seconds, `${what}.max_seconds`) };
}

// isAlias says whether a model is an alias of Claude Code (haiku, sonnet,
// opus…), which a version resolves, rather than a model's full id.
export function isAlias(model: string): boolean {
  return !model.startsWith("claude-");
}

// parsePreset checks a preset (YAML) and fills in its defaults.
export function parsePreset(text: string, file = "preset"): Preset {
  const raw: any = YAML.parse(text);
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  const validate = ajv.compile(presetSchema);
  // A plain boolean: the type guard would narrow raw to {}.
  if (!(validate as (d: unknown) => boolean)(raw)) {
    throw new Error(`${file}: ${ajv.errorsText(validate.errors, { dataVar: "preset" })}`);
  }
  const c = raw.credentials;
  const credentials: Credentials = c.oauth_token_file || c.oauth_token_env
    ? { kind: "oauth", file: c.oauth_token_file, env: c.oauth_token_env }
    : { kind: "api_key", file: c.api_key_file, env: c.api_key_env };
  const models: string[] = raw.models ?? DEFAULT_MODELS;
  const allowedEffort: string[] = raw.effort?.allowed ?? EFFORTS;
  const defaultEffort: string | undefined = raw.effort?.default;
  if (defaultEffort !== undefined && !allowedEffort.includes(defaultEffort)) {
    throw new Error(`${file}: effort.default ${defaultEffort} is not one of effort.allowed`);
  }
  const allowed: string[] = raw.tools?.allowed ?? READ_ONLY;
  const def: string[] = raw.tools?.default ?? allowed.filter((t) => READ_ONLY.includes(t));
  for (const t of def) {
    if (!allowed.includes(t)) throw new Error(`${file}: the default tool ${t} is not allowed`);
  }
  const max = limits(raw.limits?.max, MAX_LIMITS, `${file}: limits.max`);
  const dflt = limits(raw.limits?.default, DEFAULT_LIMITS, `${file}: limits.default`);
  for (const k of Object.keys(max) as (keyof Limits)[]) {
    if (dflt[k] > max[k]) throw new Error(`${file}: limits.default.${k} ${dflt[k]} is over limits.max.${k} ${max[k]}`);
  }
  const left = raw.limits?.min_left_percent ?? {};
  if ((left.session || left.week) && credentials.kind !== "oauth") {
    throw new Error(`${file}: limits.min_left_percent needs a subscription's token (credentials.oauth_token_file or oauth_token_env)`);
  }
  return {
    name: raw.name,
    description: raw.description ?? `Claude Code (${raw.name})`,
    credentials,
    upstream: (raw.upstream ?? "https://api.anthropic.com").replace(/\/+$/, ""),
    version: raw.version ?? "latest",
    models,
    effort: { allowed: allowedEffort, ...(defaultEffort ? { default: defaultEffort } : {}) },
    tools: { allowed, default: def },
    limits: { default: dflt, max, min_left_percent: { session: left.session ?? 0, week: left.week ?? 0 } },
    system: raw.system ?? "",
  };
}

export function loadPreset(file: string): Preset {
  return parsePreset(fs.readFileSync(file, "utf8"), file);
}

// readSecret reads the preset's credential from its file or variable.
export function readSecret(c: Credentials, env: NodeJS.ProcessEnv = process.env): string {
  let v: string | undefined;
  if (c.env) {
    v = env[c.env]?.trim();
    if (!v) throw new Error(`the preset's credential is in ${c.env}, which is not set`);
  } else if (c.file) {
    v = fs.readFileSync(c.file, "utf8").trim();
    if (!v) throw new Error(`${c.file} is empty`);
  }
  if (!v || /[\s\x00-\x1f]/.test(v)) throw new Error("the preset's credential is not one line of text");
  return v;
}

// runSchema is the JSON Schema of the run node's settings, from the preset:
// its models, effort levels, tools and limits.
export function runSchema(p: Preset): Record<string, unknown> {
  const max = p.limits.max;
  return {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: { type: "string", minLength: 1, description: "The task" },
      system: { type: "string", description: "Instructions added to Claude Code's system prompt (--append-system-prompt)" },
      model: { enum: p.models, default: p.models[0], description: "An alias (resolved by the installed version of Claude Code) or a model's id" },
      effort: { enum: p.effort.allowed, ...(p.effort.default ? { default: p.effort.default } : {}), description: "The effort level (--effort); a model without levels runs without one, and the output says so" },
      // As a pipeline writes it: gosidian hands the tool references instead.
      files: {
        description: "Files of the project the agent works on, in its in/ folder: a vault path, or a list of them",
        anyOf: [
          { type: "string" },
          { type: "array", maxItems: 100, items: { anyOf: [{ type: "string" }, { type: "object", required: ["path"] }] } },
        ],
      },
      tools: { type: "array", items: { enum: p.tools.allowed }, uniqueItems: true, default: p.tools.default, description: "Claude Code's tools the agent may use, within the preset's" },
      max_turns: { type: "integer", minimum: 1, maximum: max.max_turns, default: p.limits.default.max_turns },
      max_seconds: { type: "integer", minimum: 1, maximum: max.max_seconds, default: p.limits.default.max_seconds },
      max_budget_usd: { type: "number", exclusiveMinimum: 0, maximum: max.max_budget_usd, default: p.limits.default.max_budget_usd, description: "Dollars at the API's list prices (--max-budget-usd); with a subscription they measure the work, they are not billed" },
      json: { type: "boolean", description: "The answer is a JSON value" },
      schema: { type: "object", description: "A JSON Schema the answer must follow (--json-schema; implies json)" },
    },
  };
}

const usageOut = {
  type: "object",
  properties: {
    input: { type: "integer" },
    output: { type: "integer" },
    cache_read: { type: "integer" },
    cache_write: { type: "integer" },
    total_tokens: { type: "integer" },
  },
};

const window = {
  type: "object",
  properties: {
    used_percent: { type: "number" },
    left_percent: { type: "number" },
    resets_at: { type: "string" },
    status: { type: "string" },
  },
};

export const subscriptionOut = {
  type: "object",
  description: "The subscription's limits: the session (5 hours) and the week, used and left in percent, when they reset",
  properties: {
    applicable: { type: "boolean" },
    reason: { type: "string" },
    source: { enum: ["endpoint", "headers"] },
    read_at: { type: "string" },
    status: { type: "string" },
    session: window,
    week: window,
    week_models: { type: "object", additionalProperties: window },
  },
};

export const runOutput = {
  type: "object",
  properties: {
    text: { type: "string" },
    json: {},
    model: { type: "string", description: "The model the step ran on, as the alias resolved" },
    effort: {
      type: "object",
      properties: { requested: { type: ["string", "null"] }, applied: { type: ["string", "null"] }, note: { type: "string" } },
    },
    subtype: { type: "string" },
    turns: { type: "integer" },
    usage: usageOut,
    cost: { type: "number", description: "total_cost_usd: dollars at the API's list prices" },
    denials: { type: "array", items: { type: "object", properties: { tool: { type: "string" }, input: { type: "string" } } } },
    tools: { type: "array", items: { type: "string" } },
    claude_code: { type: "string" },
    subscription: subscriptionOut,
    skipped: { type: "array" },
  },
};

export const versionSchema = { type: "object", additionalProperties: false, properties: {} };

const aliasesOut = { type: "object", additionalProperties: { type: "string" } };

export const versionOutput = {
  type: "object",
  properties: {
    installed: { type: ["string", "null"] },
    channel: { type: "string" },
    latest: { type: ["string", "null"] },
    update_available: { type: "boolean" },
    aliases: aliasesOut,
    probed_at: { type: ["string", "null"] },
    effort_levels: { type: "array", items: { type: "string" } },
    models: { type: "array", items: { type: "object" } },
    installed_versions: { type: "array", items: { type: "string" } },
    state: { type: "string" },
    release_notes: { type: "string" },
  },
};

export const updateSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "string", pattern: "^(latest|stable|next|\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?)$", description: "The version to install: a tag of the npm registry or a version (default: the preset's, latest)" },
    switch: { type: "boolean", default: true, description: "Make it the version in use once its probe passes; false only installs and probes it" },
  },
};

export const updateOutput = {
  type: "object",
  properties: {
    old_version: { type: ["string", "null"] },
    new_version: { type: "string" },
    current: { type: ["string", "null"] },
    switched: { type: "boolean" },
    old_aliases: aliasesOut,
    new_aliases: aliasesOut,
    changed: { type: "array", items: { type: "object" } },
    release_notes: { type: "string" },
    installed_versions: { type: "array", items: { type: "string" } },
  },
};

export const usageSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    max_age: { type: "integer", minimum: 0, maximum: 86400, default: 300, description: "Seconds: older values are read again with a request of one token (a cheap model)" },
    steps: { type: "integer", minimum: 0, maximum: 1000, default: 20, description: "How many of the last steps to give, newest first" },
    since: { type: "string", description: "Only the steps that ended after this time (RFC 3339, 2026-10-16T07:00:00Z)" },
  },
};

const stepOut = {
  type: "object",
  properties: {
    at: { type: "string" },
    seconds: { type: "number" },
    project: { type: "string" },
    run: { type: "string" },
    model: { type: "string" },
    effort: { type: ["string", "null"] },
    subtype: { type: "string" },
    turns: { type: "integer" },
    tokens: { type: "integer" },
    input: { type: "integer" },
    output: { type: "integer" },
    cache_read: { type: "integer" },
    cache_write: { type: "integer" },
    cost: { type: "number" },
    claude_code: { type: "string" },
    error: { type: "string" },
  },
};

export const usageOutput = {
  ...subscriptionOut,
  description: "The subscription's limits (session and week, used and left in percent, when they reset) and the last steps",
  properties: {
    ...subscriptionOut.properties,
    min_left_percent: { type: "object", properties: { session: { type: "number" }, week: { type: "number" } }, description: "The preset's share of the session and of the week the pipelines leave free" },
    steps: { type: "array", items: stepOut, description: "The last steps, newest first: a failed one has error" },
  },
};
