// The preset of an agent: the endpoint and its key, the models, the tools
// it may use and the limits of a step. One container serves one preset,
// and registers in gosidian under the preset's name.
import fs from "node:fs";
import YAML from "yaml";
import { Ajv } from "ajv";

export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING)[number];

// The tools of pi a preset may allow. bash, edit and write change the
// workspace or run commands: a preset allows them on purpose.
export const TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
export const READ_ONLY = ["read", "grep", "find", "ls"];

export interface Limits {
  max_turns: number;
  max_seconds: number;
  max_tokens: number;
  max_cost: number;
}

export interface Model {
  // id is the model as the endpoint knows it; name is how a node picks it.
  id: string;
  name: string;
  context: number;
  max_output: number;
  reasoning: boolean;
  images: boolean;
  // cost is in dollars per million tokens, for max_cost.
  cost: { input: number; output: number; cache_read: number; cache_write: number };
  sampling: Record<string, unknown>;
  // body is merged into its requests over the endpoint's body: its keys
  // replace the endpoint's (a provider block of its own, say).
  body: Record<string, unknown>;
}

export interface Preset {
  name: string;
  description: string;
  endpoint: {
    base_url: string;
    // The key: the name of a variable of the server's environment, or a
    // file the server (root) reads. Neither reaches pi.
    api_key_env?: string;
    api_key_file?: string;
    // body is merged into every request to the endpoint (OpenRouter's
    // provider routing, say), over what pi sends.
    body: Record<string, unknown>;
  };
  models: Model[];
  default_model: string;
  thinking: Thinking;
  tools: { allowed: string[]; default: string[] };
  limits: { default: Limits; max: Limits };
  system: string;
  skills: string[];
}

const limitsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    max_turns: { type: "integer", minimum: 1 },
    max_seconds: { type: ["integer", "string"] },
    max_tokens: { type: "integer", minimum: 1 },
    max_cost: { type: "number", minimum: 0 },
  },
};

const presetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "endpoint", "models"],
  properties: {
    name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
    description: { type: "string" },
    endpoint: {
      type: "object",
      additionalProperties: false,
      required: ["base_url"],
      properties: {
        base_url: { type: "string", pattern: "^https?://" },
        api_key_env: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        api_key_file: { type: "string" },
        body: { type: "object" },
      },
    },
    models: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", minLength: 1 },
          name: { type: "string", pattern: "^[A-Za-z0-9._:/-]{1,128}$" },
          context: { type: "integer", minimum: 1024 },
          max_output: { type: "integer", minimum: 1 },
          reasoning: { type: "boolean" },
          images: { type: "boolean" },
          cost: {
            type: "object",
            additionalProperties: false,
            properties: {
              input: { type: "number", minimum: 0 },
              output: { type: "number", minimum: 0 },
              cache_read: { type: "number", minimum: 0 },
              cache_write: { type: "number", minimum: 0 },
            },
          },
          sampling: { type: "object" },
          body: { type: "object" },
        },
      },
    },
    default_model: { type: "string" },
    thinking: { enum: [...THINKING] },
    tools: {
      type: "object",
      additionalProperties: false,
      properties: {
        allowed: { type: "array", items: { enum: [...TOOLS] }, uniqueItems: true },
        default: { type: "array", items: { enum: [...TOOLS] }, uniqueItems: true },
      },
    },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: { default: limitsSchema, max: limitsSchema },
    },
    system: { type: "string" },
    skills: { type: "array", items: { type: "string" } },
  },
};

const DEFAULT_LIMITS: Limits = { max_turns: 30, max_seconds: 600, max_tokens: 300_000, max_cost: 1 };
const MAX_LIMITS: Limits = { max_turns: 100, max_seconds: 840, max_tokens: 2_000_000, max_cost: 10 };

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

// parsePreset checks a preset (YAML) and fills in its defaults.
export function parsePreset(text: string, file = "preset"): Preset {
  const raw: any = YAML.parse(text);
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  const validate = ajv.compile(presetSchema);
  // A plain boolean: the type guard would narrow raw to {}.
  if (!(validate as (d: unknown) => boolean)(raw)) {
    throw new Error(`${file}: ${ajv.errorsText(validate.errors, { dataVar: "preset" })}`);
  }
  const models: Model[] = raw.models.map((m: any) => ({
    id: m.id,
    name: m.name ?? m.id,
    context: m.context ?? 128_000,
    max_output: m.max_output ?? 16_000,
    reasoning: m.reasoning ?? false,
    images: m.images ?? false,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, ...(m.cost ?? {}) },
    sampling: m.sampling ?? {},
    body: m.body ?? {},
  }));
  const names = new Set<string>();
  for (const m of models) {
    if (names.has(m.name)) throw new Error(`${file}: the model name ${m.name} twice`);
    names.add(m.name);
  }
  const defaultModel = raw.default_model ?? models[0].name;
  if (!names.has(defaultModel)) throw new Error(`${file}: default_model ${defaultModel} is not one of the models`);
  const allowed: string[] = raw.tools?.allowed ?? READ_ONLY;
  const def: string[] = raw.tools?.default ?? allowed;
  for (const t of def) {
    if (!allowed.includes(t)) throw new Error(`${file}: the default tool ${t} is not allowed`);
  }
  if (raw.endpoint.api_key_env && raw.endpoint.api_key_file) throw new Error(`${file}: endpoint has api_key_env and api_key_file: one of them`);
  const max = limits(raw.limits?.max, MAX_LIMITS, `${file}: limits.max`);
  const dflt = limits(raw.limits?.default, DEFAULT_LIMITS, `${file}: limits.default`);
  for (const k of Object.keys(max) as (keyof Limits)[]) {
    if (dflt[k] > max[k]) throw new Error(`${file}: limits.default.${k} ${dflt[k]} is over limits.max.${k} ${max[k]}`);
  }
  return {
    name: raw.name,
    description: raw.description ?? `A pi agent (${raw.name})`,
    endpoint: {
      base_url: raw.endpoint.base_url.replace(/\/+$/, ""),
      api_key_env: raw.endpoint.api_key_env,
      api_key_file: raw.endpoint.api_key_file,
      body: raw.endpoint.body ?? {},
    },
    models,
    default_model: defaultModel,
    thinking: raw.thinking ?? "off",
    tools: { allowed, default: def },
    limits: { default: dflt, max },
    system: raw.system ?? "",
    skills: raw.skills ?? [],
  };
}

export function loadPreset(file: string): Preset {
  return parsePreset(fs.readFileSync(file, "utf8"), file);
}

// nodeSchema is the JSON Schema of the run node's settings, from the preset:
// the models and tools it has, the limits it allows.
export function nodeSchema(p: Preset): Record<string, unknown> {
  const max = p.limits.max;
  return {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: { type: "string", minLength: 1, description: "The task" },
      system: { type: "string", description: "Instructions added to the agent's system prompt" },
      system_mode: { enum: ["append", "replace"], default: "append", description: "append to pi's system prompt, or replace it" },
      model: { enum: p.models.map((m) => m.name), default: p.default_model },
      thinking: { enum: [...THINKING], default: p.thinking },
      // As a pipeline writes it: gosidian hands the tool references instead.
      files: {
        description: "Files of the project the agent works on, in its in/ folder: a vault path, or a list of them",
        anyOf: [
          { type: "string" },
          { type: "array", maxItems: 100, items: { anyOf: [{ type: "string" }, { type: "object", required: ["path"] }] } },
        ],
      },
      tools: { type: "array", items: { enum: p.tools.allowed }, uniqueItems: true, default: p.tools.default },
      temperature: { type: "number", minimum: 0, maximum: 2 },
      max_output: { type: "integer", minimum: 1, description: "Tokens of one response, at most the model's" },
      max_turns: { type: "integer", minimum: 1, maximum: max.max_turns, default: p.limits.default.max_turns },
      max_seconds: { type: "integer", minimum: 1, maximum: max.max_seconds, default: p.limits.default.max_seconds },
      max_tokens: { type: "integer", minimum: 1, maximum: max.max_tokens, default: p.limits.default.max_tokens },
      max_cost: { type: "number", minimum: 0, maximum: max.max_cost, default: p.limits.default.max_cost },
      json: { type: "boolean", description: "The answer is a JSON value" },
      schema: { type: "object", description: "A JSON Schema the answer must follow (implies json)" },
      json_retries: { type: "integer", minimum: 0, maximum: 3, default: 1 },
      inline_files: {
        type: "boolean",
        default: false,
        description: "Put the text files in the prompt too (256 KiB together at most), for a model that reads them badly with its tools",
      },
    },
  };
}

export const outputSchema = {
  type: "object",
  properties: {
    text: { type: "string" },
    json: {},
    model: { type: "string" },
    stop: { enum: ["done", "length"] },
    turns: { type: "integer" },
    tools: { type: "object", additionalProperties: { type: "integer" } },
    usage: {
      type: "object",
      properties: {
        input: { type: "integer" },
        output: { type: "integer" },
        cache_read: { type: "integer" },
        cache_write: { type: "integer" },
        total_tokens: { type: "integer" },
        cost: { type: "number" },
      },
    },
    skipped: { type: "array" },
  },
};
