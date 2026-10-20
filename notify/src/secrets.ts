// The channels' credentials, read from the files the preset names (mounted
// secrets), never from the preset itself or a node. They stay in this
// module: every text that leaves the plugin (a node's output, an error, a
// log line) goes through redact, which takes out each of them and the key
// of a resume address.
import fs from "node:fs";
import type { Preset } from "./preset.ts";

export interface Secrets {
  telegram_token: string;
  ntfy_token: string;
  smtp_user: string;
  smtp_password: string;
}

const known = new Set<string>();

// remember adds a value to what redact takes out.
export function remember(v: string): void {
  if (v && v.length >= 4) known.add(v);
}

// redact takes the secrets out of a text, and the key of an address like
// gosidian's resume_url (?key=…).
export function redact(s: string): string {
  let t = String(s);
  for (const v of known) if (t.includes(v)) t = t.split(v).join("[secret]");
  return t.replace(/([?&](?:key|token|access_token|auth)=)[^&\s"']+/gi, "$1[secret]").replace(/\/bot\d+:[A-Za-z0-9_-]+/g, "/bot[secret]");
}

// redactAll redacts every string in a value (a log's fields, an output).
export function redactAll<T>(v: T): T {
  if (typeof v === "string") return redact(v) as T;
  if (Array.isArray(v)) return v.map(redactAll) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = redactAll(x);
    return out as T;
  }
  return v;
}

// readFile reads a credential; secret: redact takes it out (the SMTP
// user is not one: it is often the sender's address, or a common word).
function readFile(file: string, what: string, secret = true): string {
  let v: string;
  try {
    v = fs.readFileSync(file, "utf8").trim();
  } catch (e) {
    throw new Error(`${what}: ${file} cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  if (!v) throw new Error(`${what}: ${file} is empty`);
  if (/[\r\n]/.test(v)) throw new Error(`${what}: ${file} holds more than one line`);
  if (secret) remember(v);
  return v;
}

// loadSecrets reads the files of the channels the preset has; a missing or
// empty one stops the plugin at start, saying which.
export function loadSecrets(p: Preset): Secrets {
  const c = p.channels;
  const s: Secrets = { telegram_token: "", ntfy_token: "", smtp_user: "", smtp_password: "" };
  if (c.telegram) {
    s.telegram_token = readFile(c.telegram.token_file, "channels.telegram.token_file");
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(s.telegram_token)) throw new Error(`channels.telegram.token_file: ${c.telegram.token_file} does not hold a bot's token (<id>:<secret>, as BotFather gives it)`);
  }
  if (c.ntfy?.token_file) s.ntfy_token = readFile(c.ntfy.token_file, "channels.ntfy.token_file");
  if (c.email?.user_file) {
    s.smtp_user = readFile(c.email.user_file, "channels.email.user_file", false);
    s.smtp_password = readFile(c.email.password_file!, "channels.email.password_file");
  }
  return s;
}
