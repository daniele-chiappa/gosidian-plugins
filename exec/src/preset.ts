// The preset of an executor: the shell of its scripts, the limits of a
// step, the variables every step gets, the hosts its scripts reach (declared:
// the container enforces them), the repositories a step may check out, the
// hosts a step may run on over SSH, and the dependency cache. One container
// serves one preset, and registers in gosidian under the preset's name.
import fs from "node:fs";
import YAML from "yaml";
import { Ajv } from "ajv";
import { hostsOf, parseRepos, reposSchema, type Repo } from "./kit/repos.ts";

// The limits of a local step: its wall time, the bytes of stdout and of
// stderr it keeps (their end), and the ulimits of its processes: the
// processes and threads of the slot's user (-u), the size of a file in MiB
// (-f), the CPU seconds of a process (-t; default the step's timeout).
export interface Limits {
  timeout: number;
  output_limit: number;
  processes: number;
  file_size: number;
  cpu_seconds?: number;
}

// A host a step may run on: the plugin's key for it (a file only root
// reads), its host keys, checked out of band, the folder where the steps'
// folders are made, and the shell of its scripts.
export interface Host {
  name: string;
  host: string;
  port: number;
  user: string;
  key_file: string;
  known_hosts: string;
  workdir: string;
  shell: string;
  // env are variables of every step on the host, before the node's.
  env: Record<string, string>;
}

export interface Preset {
  name: string;
  description: string;
  // shell runs a local step's script, with -e.
  shell: string;
  limits: { default: Limits; max: Required<Limits> };
  // env are variables of every local step, before the node's.
  env: Record<string, string>;
  // network are the hosts the scripts reach (registries, proxies):
  // declared in the manifest, enforced by the container's network.
  network: string[];
  repos: Repo[];
  hosts: Host[];
  // cache: none, every step downloads its dependencies again; project, a
  // folder of the project's in cache_dir keeps them between its steps.
  cache: "none" | "project";
  cache_dir: string;
}

// The name of a variable a node may set, and those it may not: the
// plugin's own (the step's folders, the tools' path), what changes how a
// shell or the dynamic linker starts, git's and Python's and Node's own.
export const ENV_NAME = "^[A-Z_][A-Z0-9_]{0,63}$";
export const RESERVED_ENV = [
  "PATH", "HOME", "TMPDIR", "SHELL", "USER", "LOGNAME", "IFS", "ENV", "BASH_ENV",
  "SHELLOPTS", "BASHOPTS", "PS4", "POSIXLY_CORRECT", "NODE_OPTIONS",
];
export const RESERVED_PREFIXES = ["LD_", "GIT_", "PYTHON"];
export const MAX_ENV = 64;
export const MAX_ENV_VALUE = 8 << 10;

// What a preset's variables may not be: the step's folders and what
// changes how the shell that sets the limits starts.
const PRESET_RESERVED_ENV = ["HOME", "TMPDIR", "IFS", "ENV", "BASH_ENV", "SHELLOPTS", "BASHOPTS", "PS4", "POSIXLY_CORRECT"];

// envError says why a node's variable is refused, or "" when it is not.
export function envError(name: string): string {
  if (!new RegExp(ENV_NAME).test(name)) return `${JSON.stringify(name)} is not a variable's name (A-Z, 0-9, _)`;
  if (RESERVED_ENV.includes(name)) return `${name} is the plugin's`;
  const pre = RESERVED_PREFIXES.find((p) => name.startsWith(p));
  if (pre) return `${name}: the ${pre}* variables are the plugin's`;
  return "";
}

const durationSchema = { type: ["integer", "string"] };

const limitsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    timeout: durationSchema,
    output_limit: { type: "integer", minimum: 0 },
    processes: { type: "integer", minimum: 16 },
    file_size: { type: "integer", minimum: 1 },
    cpu_seconds: durationSchema,
  },
};

const shellSchema = { type: "string", pattern: "^[A-Za-z0-9/._+][A-Za-z0-9/._+-]{0,127}$" };

const presetEnvSchema = {
  type: "object",
  propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]{0,127}$" },
  additionalProperties: { type: ["string", "number", "boolean"] },
};

const hostSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "host", "user", "key_file"],
  properties: {
    name: { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" },
    host: { type: "string", pattern: "^[A-Za-z0-9_.:][A-Za-z0-9_.:-]{0,252}$" },
    port: { type: "integer", minimum: 1, maximum: 65535 },
    user: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_.-]{0,31}$" },
    key_file: { type: "string", minLength: 1 },
    known_hosts: { type: "string", minLength: 1 },
    known_hosts_file: { type: "string", minLength: 1 },
    workdir: { type: "string", pattern: "^/[^\\x00-\\x1f]{0,1023}$" },
    shell: shellSchema,
    env: presetEnvSchema,
  },
};

const presetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
    description: { type: "string" },
    shell: shellSchema,
    limits: {
      type: "object",
      additionalProperties: false,
      properties: { default: limitsSchema, max: limitsSchema },
    },
    env: presetEnvSchema,
    network: { type: "array", items: { type: "string", pattern: "^[A-Za-z0-9.:\\[\\]-]{1,261}$" }, uniqueItems: true },
    repos: reposSchema,
    hosts: { type: "array", items: hostSchema },
    cache: { enum: ["none", "project"] },
    cache_dir: { type: "string", pattern: "^/[^\\x00-\\x1f]{0,1023}$" },
  },
};

export const DEFAULT_LIMITS: Limits = { timeout: 600, output_limit: 64 << 10, processes: 512, file_size: 2048 };
const MAX_TIMEOUT = 1800;
const MAX_OUTPUT_LIMIT = 4 << 20;

// seconds reads a duration: a number of seconds, or "90s", "10m", "1h".
export function seconds(v: unknown, what: string): number {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  const m = typeof v === "string" ? /^(\d+)\s*(s|m|h)?$/.exec(v.trim()) : null;
  if (!m) throw new Error(`${what}: ${JSON.stringify(v)} is not a duration (seconds, or 90s, 10m, 1h)`);
  const n = Number(m[1]) * ({ s: 1, m: 60, h: 3600 } as Record<string, number>)[m[2] ?? "s"];
  if (n <= 0) throw new Error(`${what}: the duration is zero`);
  return n;
}

function envOf(raw: Record<string, unknown> | undefined, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (PRESET_RESERVED_ENV.includes(k)) throw new Error(`${what}.${k}: the plugin sets it for each step`);
    out[k] = String(v);
  }
  return out;
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
  const rd = raw.limits?.default ?? {};
  const rm = raw.limits?.max ?? {};
  const dflt: Limits = {
    timeout: seconds(rd.timeout ?? DEFAULT_LIMITS.timeout, `${file}: limits.default.timeout`),
    output_limit: rd.output_limit ?? DEFAULT_LIMITS.output_limit,
    processes: rd.processes ?? DEFAULT_LIMITS.processes,
    file_size: rd.file_size ?? DEFAULT_LIMITS.file_size,
    ...(rd.cpu_seconds !== undefined ? { cpu_seconds: seconds(rd.cpu_seconds, `${file}: limits.default.cpu_seconds`) } : {}),
  };
  const maxTimeout = seconds(rm.timeout ?? Math.max(MAX_TIMEOUT, dflt.timeout), `${file}: limits.max.timeout`);
  // A ulimit the preset gives no max of: a node may lower it, not raise it.
  const max: Required<Limits> = {
    timeout: maxTimeout,
    output_limit: rm.output_limit ?? Math.max(MAX_OUTPUT_LIMIT, dflt.output_limit),
    processes: rm.processes ?? dflt.processes,
    file_size: rm.file_size ?? dflt.file_size,
    cpu_seconds: rm.cpu_seconds !== undefined ? seconds(rm.cpu_seconds, `${file}: limits.max.cpu_seconds`) : Math.max(maxTimeout, dflt.cpu_seconds ?? 0),
  };
  for (const k of Object.keys(dflt) as (keyof Limits)[]) {
    if ((dflt[k] ?? 0) > max[k]) throw new Error(`${file}: limits.default.${k} ${dflt[k]} is over limits.max.${k} ${max[k]}`);
  }
  const hosts: Host[] = [];
  for (const h of raw.hosts ?? []) {
    const what = `${file}: hosts ${h.name}`;
    if (h.name === "local") throw new Error(`${what}: local is the plugin's own sandbox, not a host's name`);
    if (hosts.some((x) => x.name === h.name)) throw new Error(`${what} twice`);
    if (h.known_hosts && h.known_hosts_file) throw new Error(`${what}: known_hosts or known_hosts_file, not both`);
    const known = h.known_hosts_file ? fs.readFileSync(h.known_hosts_file, "utf8") : h.known_hosts;
    if (!known?.trim()) throw new Error(`${what}: the host needs its host keys (known_hosts or known_hosts_file), checked out of band`);
    hosts.push({
      name: h.name,
      host: h.host,
      port: h.port ?? 22,
      user: h.user,
      key_file: h.key_file,
      known_hosts: String(known).trim() + "\n",
      workdir: String(h.workdir ?? "/tmp/gosidian-exec").replace(/(.)\/+$/, "$1"),
      shell: h.shell ?? "sh",
      env: envOf(h.env, `${what}: env`),
    });
  }
  return {
    name: raw.name,
    description: raw.description ?? `Scripts and commands (${raw.name})`,
    shell: raw.shell ?? "bash",
    limits: { default: dflt, max },
    env: envOf(raw.env, `${file}: env`),
    network: raw.network ?? [],
    repos: parseRepos(raw.repos, file),
    hosts,
    cache: raw.cache ?? "none",
    cache_dir: String(raw.cache_dir ?? "/var/cache/gosidian-exec").replace(/(.)\/+$/, "$1"),
  };
}

export function loadPreset(file: string): Preset {
  return parsePreset(fs.readFileSync(file, "utf8"), file);
}

// hostPort is a host's address as the manifest's network lists it.
export function hostPort(h: Host): string {
  return h.host.includes(":") ? `[${h.host}]:${h.port}` : `${h.host}:${h.port}`;
}

// hostsOfPreset are the hosts the plugin and its scripts reach: gosidian
// (the files), the hosts of the preset, the repositories' servers and the
// preset's network.
export function hostsOfPreset(p: Preset): string[] {
  return [...new Set(["gosidian", ...p.hosts.map(hostPort), ...hostsOf(p.repos), ...p.network])];
}

// nodeSchema is the JSON Schema of the run node's settings, command-run/1's,
// from the preset: its targets, its repositories, its limits.
export function nodeSchema(p: Preset): Record<string, unknown> {
  const { default: d, max } = p.limits;
  const hosts = p.hosts.map((h) => h.name);
  return {
    type: "object",
    additionalProperties: false,
    oneOf: [{ required: ["script"] }, { required: ["command"] }],
    properties: {
      script: {
        type: "string",
        minLength: 1,
        maxLength: 1 << 20,
        description: `A script: run by ${p.shell} -e in the sandbox, by the host's shell (-e) on a host; an error stops it`,
      },
      command: {
        type: "array",
        minItems: 1,
        maxItems: 1024,
        items: { type: "string", maxLength: 128 << 10 },
        description: "A command and its arguments, run with no shell",
      },
      target: {
        enum: ["local", ...hosts],
        default: "local",
        description: hosts.length ? `local: the plugin's sandbox; or a host of the preset: ${hosts.join(", ")}` : "local: the plugin's sandbox (the preset has no hosts)",
      },
      // As a pipeline writes it: gosidian hands the tool references instead.
      files: {
        description: "Files of the project, in the step's in/: a vault path, or a list of them",
        anyOf: [
          { type: "string" },
          { type: "array", maxItems: 100, items: { anyOf: [{ type: "string" }, { type: "object", required: ["path"] }] } },
        ],
      },
      ...(p.repos.length
        ? {
            repo: {
              type: "object",
              additionalProperties: false,
              required: ["name"],
              description: "A repository of the preset at a ref, in the step's repo/: its changes are never committed",
              properties: {
                name: { enum: p.repos.map((r) => r.name) },
                ref: { type: "string", minLength: 1, maxLength: 255, description: "A branch, a tag or a commit; default the repository's base branch" },
              },
            },
          }
        : {}),
      env: {
        type: "object",
        maxProperties: MAX_ENV,
        description: "Variables of the script, besides the plugin's and the preset's",
        propertyNames: {
          pattern: ENV_NAME,
          not: { anyOf: [{ enum: RESERVED_ENV }, { pattern: `^(${RESERVED_PREFIXES.join("|")})` }] },
        },
        additionalProperties: { type: "string", maxLength: MAX_ENV_VALUE },
      },
      timeout: { type: "integer", minimum: 1, maximum: max.timeout, default: d.timeout, description: "Seconds" },
      output_limit: { type: "integer", minimum: 0, maximum: max.output_limit, default: d.output_limit, description: "Bytes of stdout and of stderr kept, their end" },
      processes: { type: "integer", minimum: 16, maximum: max.processes, default: d.processes, description: "In the sandbox: the processes and threads of the step (ulimit -u)" },
      file_size: { type: "integer", minimum: 1, maximum: max.file_size, default: d.file_size, description: "In the sandbox: the size of a file it writes, MiB (ulimit -f)" },
      cpu_seconds: { type: "integer", minimum: 1, maximum: max.cpu_seconds, description: "In the sandbox: the CPU seconds of each process (ulimit -t); default the preset's, else the timeout" },
      fail_on_error: { type: "boolean", default: true, description: "true: an exit code other than 0, a signal or the timeout fails the node; false: the output says it, and the pipeline decides" },
    },
  };
}

export const outputSchema = {
  type: "object",
  properties: {
    exit_code: { type: ["integer", "null"], description: "null when a signal or the timeout ended it" },
    signal: { type: ["string", "null"], description: "The signal that ended it (SIGKILL…)" },
    timed_out: { type: "boolean" },
    stdout: { type: "string", description: "The end of what it wrote, within output_limit" },
    stderr: { type: "string" },
    truncated: { type: "boolean", description: "stdout or stderr was longer than output_limit" },
    seconds: { type: "number" },
    files: { type: "array", items: { type: "object" }, description: "The files it wrote in out/, stored by gosidian" },
    repo: { type: "object", properties: { name: { type: "string" }, ref: { type: "string" }, commit: { type: "string" } } },
    target: { type: "string" },
    executor: { type: "object", properties: { plugin: { type: "string" }, version: { type: "string" }, image: { type: "string" } } },
    skipped: { type: "array", description: "The files of out/ not given back, and why" },
  },
};
