// The preset of an agent: the endpoints and their keys, the version of
// Claude Code, the models and effort levels a node may pick, the tools it
// may allow and the limits of a step. One container serves one preset, and
// registers in gosidian under the preset's name.
import fs from "node:fs";
import YAML from "yaml";
import { Ajv } from "ajv";
import { parseRepos, reposSchema, type Repo } from "./kit/repos.ts";
import { repoSettingSchema } from "./kit/git.ts";
import { MCP_LEVELS, type MCPLevel } from "./kit/contract.ts";

// The effort levels Claude Code 2.1.301 takes (--effort). A version that
// takes others says so in its --help, which the plugin reads at install.
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// Claude Code's read-only tools: the default. Write, Edit, Bash, WebFetch
// and the others are allowed by a preset on purpose.
export const READ_ONLY = ["Read", "Grep", "Glob"];

// ACCESS are the tools of each level of agent-run/1's access: read and
// search, also write, also run commands. A step gets those its preset allows.
export const ACCESS: Record<string, string[]> = {
  read: READ_ONLY,
  edit: [...READ_ONLY, "Write", "Edit"],
  exec: [...READ_ONLY, "Write", "Edit", "Bash"],
};
const LEVELS = ["read", "edit", "exec"];

export const DEFAULT_MODELS = ["haiku", "sonnet", "opus"];

// The endpoint of a preset of the old form (credentials and upstream).
export const LEGACY_ENDPOINT = "anthropic";

export interface Limits {
  max_turns: number;
  max_seconds: number;
  max_tokens: number;
  // max_cost is in US dollars.
  max_cost: number;
}

// Auth is how the proxy authenticates to an endpoint: oauth, a
// subscription's token (claude setup-token) sent as a bearer with the OAuth
// beta; api_key, a key of the Claude API sent as x-api-key; bearer, a key
// sent as a bearer (OpenRouter, vLLM); none, no header (Ollama).
export type Auth = "oauth" | "api_key" | "bearer" | "none";

export interface Endpoint {
  name: string;
  // url is the API's base: the proxy adds /v1/messages.
  url: string;
  auth: Auth;
  // Where the server reads the key: a file, or a variable of its
  // environment. Neither reaches Claude Code.
  key_file?: string;
  key_env?: string;
  // headers are sent with every request (OpenRouter's HTTP-Referer and
  // X-Title, say); never one of authentication.
  headers: Record<string, string>;
}

export interface Prices {
  // US dollars per million tokens.
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface Model {
  // name is how a node picks it; id is the model as its endpoint knows it
  // (an alias of Claude Code, haiku, on an Anthropic endpoint).
  name: string;
  endpoint: string;
  id: string;
  // context and max_output are tokens, for Claude Code
  // (CLAUDE_CODE_MAX_CONTEXT_TOKENS, CLAUDE_CODE_MAX_OUTPUT_TOKENS).
  context?: number;
  max_output?: number;
  // cost prices a step on an endpoint other than Anthropic's.
  cost?: Prices;
  // effort: the model takes an effort level (--effort).
  effort: boolean;
}

export interface Preset {
  name: string;
  description: string;
  // endpoints by name, in the preset's order.
  endpoints: Record<string, Endpoint>;
  // version is the version of Claude Code to install when none is: a tag
  // of the npm registry (latest, stable, next) or a version (2.1.301).
  version: string;
  // models: the first is the default of a node.
  models: Model[];
  effort: { allowed: string[]; default?: string };
  tools: { allowed: string[]; default: string[] };
  limits: { default: Limits; max: Limits; min_left_percent: { session: number; week: number } };
  system: string;
  // repos are the repositories a step may work on (agent-kit's repos.ts).
  repos: Repo[];
  // mcp are the levels of gosidian's MCP a step may ask for: read, write.
  mcp: MCPLevel[];
}

const limitsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    max_turns: { type: "integer", minimum: 1 },
    max_seconds: { type: ["integer", "string"] },
    max_tokens: { type: "integer", minimum: 1 },
    max_cost: { type: "number", exclusiveMinimum: 0 },
    // Deprecated: max_cost.
    max_budget_usd: { type: "number", exclusiveMinimum: 0 },
  },
};

const percent = { type: "number", minimum: 0, maximum: 100 };
const toolName = { type: "string", pattern: "^[A-Z][A-Za-z0-9_]{1,63}$" };
const envName = { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" };
const MODEL_NAME = "^[A-Za-z0-9][A-Za-z0-9._:\\[\\]-]{0,127}$";
const price = { type: "number", minimum: 0 };

// The headers a preset may not set: authentication is the proxy's, and the
// others are the connection's.
const RESERVED_HEADERS = new Set([
  "authorization", "proxy-authorization", "x-api-key", "cookie", "host", "connection", "keep-alive",
  "content-length", "transfer-encoding", "te", "trailer", "upgrade", "accept-encoding",
]);

const presetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" },
    description: { type: "string" },
    endpoints: {
      type: "object",
      minProperties: 1,
      propertyNames: { pattern: "^[a-z][a-z0-9_-]{0,31}$" },
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["url", "auth"],
        properties: {
          url: { type: "string", pattern: "^https?://" },
          auth: { enum: ["oauth", "api_key", "bearer", "none"] },
          key_file: { type: "string", minLength: 1 },
          key_env: envName,
          headers: {
            type: "object",
            propertyNames: { pattern: "^[A-Za-z0-9-]{1,64}$" },
            additionalProperties: { type: "string", pattern: "^[^\\x00-\\x1f\\x7f]*$" },
          },
        },
      },
    },
    // The old form: one endpoint, Anthropic's (or upstream).
    credentials: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 1,
      properties: {
        oauth_token_file: { type: "string", minLength: 1 },
        oauth_token_env: envName,
        api_key_file: { type: "string", minLength: 1 },
        api_key_env: envName,
      },
    },
    upstream: { type: "string", pattern: "^https?://" },
    version: { type: "string", pattern: "^(latest|stable|next|\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?)$" },
    models: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: {
        anyOf: [
          { type: "string", pattern: MODEL_NAME },
          {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: {
              name: { type: "string", pattern: MODEL_NAME },
              endpoint: { type: "string" },
              id: { type: "string", pattern: "^[^\\s\\x00-\\x1f]{1,256}$" },
              context: { type: "integer", minimum: 1024 },
              max_output: { type: "integer", minimum: 1 },
              cost: {
                type: "object",
                additionalProperties: false,
                properties: { input: price, output: price, cache_read: price, cache_write: price },
              },
              effort: { type: "boolean" },
            },
          },
        ],
      },
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
    repos: reposSchema,
    mcp: { type: "array", items: { enum: MCP_LEVELS.filter((l) => l !== "none") }, uniqueItems: true },
  },
};

// max_tokens counts the cache reads too: an agent that reads long notes for
// 40 turns spends a few millions; max_cost stays the step's real bound.
const DEFAULT_LIMITS: Limits = { max_turns: 20, max_seconds: 600, max_tokens: 3_000_000, max_cost: 1 };
const MAX_LIMITS: Limits = { max_turns: 100, max_seconds: 840, max_tokens: 6_000_000, max_cost: 10 };

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
  const { max_budget_usd, ...given } = raw ?? {};
  if (max_budget_usd !== undefined) {
    if (given.max_cost !== undefined) throw new Error(`${what}: max_cost and max_budget_usd (deprecated) are the same limit: give max_cost only`);
    given.max_cost = max_budget_usd;
  }
  const l = { ...fallback, ...given };
  return { ...l, max_seconds: seconds(l.max_seconds, `${what}.max_seconds`) };
}

// isAlias says whether a model is an alias of Claude Code (haiku, sonnet,
// opus…), which a version resolves, rather than a model's full id.
export function isAlias(model: string): boolean {
  return !model.startsWith("claude-");
}

// isAnthropic says whether an endpoint is Anthropic's own API: a
// subscription or an API key, with the subscription's limits, the aliases
// of Claude Code and the effort levels. The others are compatible: they
// speak the Messages API, with models of their own.
export function isAnthropic(e: { auth: Auth }): boolean {
  return e.auth === "oauth" || e.auth === "api_key";
}

// modelOf finds a model of the preset by its name.
export function modelOf(p: Preset, name: string): Model | undefined {
  return p.models.find((m) => m.name === name);
}

// aliasesOf are the preset's aliases of Claude Code, which a probe resolves:
// the models of its Anthropic endpoints whose id is an alias.
export function aliasesOf(p: Preset): string[] {
  return [...new Set(p.models.filter((m) => isAnthropic(p.endpoints[m.endpoint]) && isAlias(m.id)).map((m) => m.id))];
}

// endpointsOf reads the endpoints: the map of the preset, or the one of
// credentials and upstream, named anthropic.
function endpointsOf(raw: any, file: string): Record<string, Endpoint> {
  if (raw.endpoints) {
    if (raw.credentials || raw.upstream) throw new Error(`${file}: endpoints replaces credentials and upstream: give one or the other`);
    const out: Record<string, Endpoint> = {};
    for (const [name, e] of Object.entries<any>(raw.endpoints)) {
      const what = `${file}: endpoints.${name}`;
      if (e.auth === "none") {
        if (e.key_file || e.key_env) throw new Error(`${what}: auth none takes no key_file or key_env`);
      } else if (Boolean(e.key_file) === Boolean(e.key_env)) {
        throw new Error(`${what}: auth ${e.auth} needs its key in one of key_file and key_env`);
      }
      for (const h of Object.keys(e.headers ?? {})) {
        if (RESERVED_HEADERS.has(h.toLowerCase())) throw new Error(`${what}.headers: ${h} is not a header a preset sets (the key goes in key_file or key_env)`);
      }
      out[name] = { name, url: e.url.replace(/\/+$/, ""), auth: e.auth, key_file: e.key_file, key_env: e.key_env, headers: e.headers ?? {} };
    }
    return out;
  }
  const c = raw.credentials;
  if (!c) throw new Error(`${file}: a preset needs an endpoint: endpoints, or credentials (and upstream)`);
  const oauth = Boolean(c.oauth_token_file || c.oauth_token_env);
  return {
    [LEGACY_ENDPOINT]: {
      name: LEGACY_ENDPOINT,
      url: (raw.upstream ?? "https://api.anthropic.com").replace(/\/+$/, ""),
      auth: oauth ? "oauth" : "api_key",
      key_file: oauth ? c.oauth_token_file : c.api_key_file,
      key_env: oauth ? c.oauth_token_env : c.api_key_env,
      headers: {},
    },
  };
}

// modelsOf reads the models: a name alone is a model of the first
// Anthropic endpoint (an alias or a claude-* id); an object names its
// endpoint (the only one when there is one) and the endpoint's id.
function modelsOf(raw: any, endpoints: Record<string, Endpoint>, file: string): Model[] {
  const anthropic = Object.values(endpoints).find(isAnthropic);
  const names = Object.keys(endpoints);
  const list: unknown[] = raw.models ?? (anthropic ? DEFAULT_MODELS : []);
  if (!list.length) throw new Error(`${file}: models: the preset has no Anthropic endpoint (auth oauth or api_key): list its models, each with its endpoint`);
  const seen = new Set<string>();
  return list.map((x: any, i) => {
    const m = typeof x === "string" ? { name: x } : x;
    const what = `${file}: models[${i}] (${m.name})`;
    const endpoint: string | undefined = typeof x === "string" ? anthropic?.name : m.endpoint ?? (names.length === 1 ? names[0] : undefined);
    if (typeof x === "string" && !endpoint) throw new Error(`${what}: a name alone is a model of an Anthropic endpoint (auth oauth or api_key), and the preset has none: give {name, endpoint, id}`);
    if (!endpoint) throw new Error(`${what}: which endpoint? one of ${names.join(", ")}`);
    const e = endpoints[endpoint];
    if (!e) throw new Error(`${what}: no endpoint ${endpoint}: one of ${names.join(", ")}`);
    if (seen.has(m.name)) throw new Error(`${what}: duplicate name ${m.name}`);
    seen.add(m.name);
    return {
      name: m.name,
      endpoint,
      id: m.id ?? m.name,
      ...(m.context !== undefined ? { context: m.context } : {}),
      ...(m.max_output !== undefined ? { max_output: m.max_output } : {}),
      ...(m.cost ? { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, ...m.cost } } : {}),
      effort: m.effort ?? isAnthropic(e),
    };
  });
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
  const endpoints = endpointsOf(raw, file);
  const all = Object.values(endpoints);
  // One subscription: its limits are the preset's.
  if (all.filter((e) => e.auth === "oauth").length > 1) throw new Error(`${file}: endpoints: at most one has auth oauth (a subscription)`);
  const models = modelsOf(raw, endpoints, file);
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
  if ((left.session || left.week) && !all.some((e) => e.auth === "oauth")) {
    throw new Error(`${file}: limits.min_left_percent needs a subscription: an endpoint with auth oauth (or credentials.oauth_token_file or oauth_token_env)`);
  }
  return {
    name: raw.name,
    description: raw.description ?? `Claude Code (${raw.name})`,
    endpoints,
    version: raw.version ?? "latest",
    models,
    effort: { allowed: allowedEffort, ...(defaultEffort ? { default: defaultEffort } : {}) },
    tools: { allowed, default: def },
    limits: { default: dflt, max, min_left_percent: { session: left.session ?? 0, week: left.week ?? 0 } },
    system: raw.system ?? "",
    repos: parseRepos(raw.repos, file),
    mcp: raw.mcp ?? [],
  };
}

export function loadPreset(file: string): Preset {
  return parsePreset(fs.readFileSync(file, "utf8"), file);
}

// readSecret reads an endpoint's key from its file or variable; "" for an
// endpoint without one.
export function readSecret(e: { key_file?: string; key_env?: string }, env: NodeJS.ProcessEnv = process.env): string {
  if (!e.key_file && !e.key_env) return "";
  let v: string | undefined;
  if (e.key_env) {
    v = env[e.key_env]?.trim();
    if (!v) throw new Error(`the preset's credential is in ${e.key_env}, which is not set`);
  } else if (e.key_file) {
    v = fs.readFileSync(e.key_file, "utf8").trim();
    if (!v) throw new Error(`${e.key_file} is empty`);
  }
  if (!v || /[\s\x00-\x1f]/.test(v)) throw new Error("the preset's credential is not one line of text");
  return v;
}

// readSecrets reads the key of each endpoint, by its name.
export function readSecrets(p: Preset, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of Object.values(p.endpoints)) {
    try {
      out[e.name] = readSecret(e, env);
    } catch (err) {
      throw new Error(`endpoint ${e.name}: ${(err as Error).message}`);
    }
  }
  return out;
}

// accessTools are the tools of an access level the preset allows; missing
// are those the level adds when the preset allows none of them.
export function accessTools(p: Preset, level: string): { tools: string[]; missing: string[] } {
  const i = LEVELS.indexOf(level);
  const adds = ACCESS[level].filter((t) => i === 0 || !ACCESS[LEVELS[i - 1]].includes(t));
  const missing = adds.some((t) => p.tools.allowed.includes(t)) ? [] : adds;
  return { tools: ACCESS[level].filter((t) => p.tools.allowed.includes(t)), missing };
}

// runSchema is the JSON Schema of the run node's settings, agent-run/1's,
// from the preset: its models, effort levels, tools and limits.
export function runSchema(p: Preset): Record<string, unknown> {
  const max = p.limits.max;
  const levels = LEVELS.filter((l) => !accessTools(p, l).missing.length);
  return {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: { type: "string", minLength: 1, description: "The task" },
      system: { type: "string", description: "The role: instructions for Claude Code's system prompt" },
      system_mode: { enum: ["append", "replace"], default: "append", description: "append: added to Claude Code's system prompt (--append-system-prompt-file); replace: in its place (--system-prompt-file)" },
      model: { enum: p.models.map((m) => m.name), default: p.models[0].name, description: "A model of the preset, which knows its endpoint: on Anthropic's, an alias (resolved by the installed version of Claude Code) or a model's id" },
      effort: { enum: p.effort.allowed, ...(p.effort.default ? { default: p.effort.default } : {}), description: "The effort level (--effort); a model without levels runs without one, and the output says so" },
      // As a pipeline writes it: gosidian hands the tool references instead.
      files: {
        description: "Files of the project the agent works on, in its in/ folder: a vault path, or a list of them",
        anyOf: [
          { type: "string" },
          { type: "array", maxItems: 100, items: { anyOf: [{ type: "string" }, { type: "object", required: ["path"] }] } },
        ],
      },
      ...(levels.length ? { access: { enum: levels, description: "read: Read, Grep, Glob; edit: also Write, Edit; exec: also Bash; those the preset allows" } } : {}),
      tools: { type: "array", items: { enum: p.tools.allowed }, uniqueItems: true, default: p.tools.default, description: "Claude Code's tools the agent may use, within the preset's; with access, within its tools (default: access's, else the preset's default)" },
      max_turns: { type: "integer", minimum: 1, maximum: max.max_turns, default: p.limits.default.max_turns },
      max_seconds: { type: "integer", minimum: 1, maximum: max.max_seconds, default: p.limits.default.max_seconds },
      max_tokens: { type: "integer", minimum: 1, maximum: max.max_tokens, default: p.limits.default.max_tokens, description: "The step's tokens, all four kinds together; the run's tokens left cap them too" },
      max_cost: { type: "number", exclusiveMinimum: 0, maximum: max.max_cost, default: p.limits.default.max_cost, description: "US dollars: on Anthropic's endpoints at the API's list prices (--max-budget-usd; with a subscription they measure the work, they are not billed), on the others at the preset's prices" },
      max_budget_usd: { type: "number", exclusiveMinimum: 0, maximum: max.max_cost, deprecated: true, description: "Deprecated: max_cost" },
      json: { type: "boolean", description: "The answer is a JSON value" },
      schema: { type: "object", description: "A JSON Schema the answer must follow (--json-schema; implies json)" },
      ...(p.repos.length ? { repo: repoSettingSchema(p.repos) } : {}),
      ...(p.mcp.length ? { mcp: { enum: ["none", ...p.mcp], default: "none", description: "gosidian's MCP for the step, with a token of the run's project that lasts the call: read, or write (reads too)" } } : {}),
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
    model: {
      type: "object",
      description: "The model the step ran on: the preset's name, the endpoint's id (on Anthropic's, the alias as resolved), the endpoint",
      properties: { name: { type: "string" }, id: { type: "string" }, endpoint: { type: "string" } },
    },
    stop: { enum: ["done", "length"], description: "length: the model's last answer was cut at its output tokens" },
    turns: { type: "integer" },
    usage: usageOut,
    cost: { type: "number", description: "US dollars: Claude Code's total_cost_usd on Anthropic's endpoints, the preset's prices on the others" },
    cost_source: { enum: ["agent", "prices", "none"], description: "agent: Claude Code's; prices: the preset's; none: the model has no prices" },
    tools: { type: "object", additionalProperties: { type: "integer" }, description: "Calls per tool" },
    denials: { type: "array", items: { type: "object", properties: { tool: { type: "string" }, input: { type: "string" } } } },
    executor: {
      type: "object",
      properties: { plugin: { type: "string" }, version: { type: "string" }, agent: { type: "string" }, agent_version: { type: "string" } },
    },
    effort: {
      type: "object",
      properties: { requested: { type: ["string", "null"] }, applied: { type: ["string", "null"] }, note: { type: "string" } },
    },
    subtype: { type: "string" },
    allowed_tools: { type: "array", items: { type: "string" }, description: "The tools Claude Code had" },
    claude_code: { type: "string" },
    subscription: subscriptionOut,
    skipped: { type: "array" },
  },
};

const repoOut = {
  type: "object",
  description: "The repository: the step's branch, the commit of what the agent changed (none when nothing did), the files it changed, whether it was pushed, the pull request",
  properties: {
    name: { type: "string" },
    base: { type: "string" },
    branch: { type: "string" },
    commit: { type: "string" },
    changed: { type: "integer" },
    files: { type: "array", items: { type: "string" }, description: "The paths in the repository of the files the commit changed, sorted: added, modified, deleted; a renamed one as its old path and its new one" },
    insertions: { type: "integer" },
    deletions: { type: "integer" },
    pushed: { type: "boolean" },
    pr_url: { type: "string" },
    note: { type: "string" },
  },
};

const mcpOut = {
  type: "object",
  description: "gosidian's MCP the step had: the level, the endpoint, and its state when Claude Code started (connected, failed…)",
  properties: { level: { enum: ["read", "write"] }, url: { type: "string" }, status: { type: "string" } },
};

// runOutputOf is the run node's output schema: repo and mcp only for a
// preset that has them.
export function runOutputOf(p: Preset): Record<string, unknown> {
  return {
    ...runOutput,
    properties: { ...runOutput.properties, ...(p.repos.length ? { repo: repoOut } : {}), ...(p.mcp.length ? { mcp: mcpOut } : {}) },
  };
}

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
    probe_skipped: { type: "string", description: "Why the aliases are not probed: the preset has no Anthropic endpoint" },
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
    endpoint: { type: "string" },
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
    repo: { type: "object", properties: { name: { type: "string" }, branch: { type: "string" }, commit: { type: "string" } } },
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
