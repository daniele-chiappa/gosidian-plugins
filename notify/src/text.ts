// The text a node hands the plugin, made plain: it comes from pipelines,
// often from agents, and goes to people. No HTML or markdown is
// interpreted on any channel (Telegram without parse_mode, ntfy without
// markdown, email text/plain); here the control characters and the
// characters that reorder text (bidi overrides, which can make a line read
// as another) go, and the lengths are cut.

// Control characters but tab and line feed; C1 too.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
// The bidi marks, embeddings, overrides and isolates; the line and
// paragraph separators, the BOM. Written as escapes, in a string: the
// characters themselves would hide in the source, and U+2028 ends a line.
const REORDER = new RegExp("[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\u2028\\u2029\\ufeff]", "g");

// clean makes text plain: one line (a title) or several.
export function clean(s: string, multiline: boolean): string {
  let t = String(s ?? "").normalize("NFC").replace(/\r\n?/g, "\n").replace(REORDER, "").replace(CONTROL, "");
  if (multiline) {
    t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  } else {
    t = t.replace(/\s+/g, " ");
  }
  return t.trim();
}

const ELLIPSIS = "…";

// capUnits cuts s to at most n UTF-16 units (Telegram's and JavaScript's
// count), never inside a pair, with an ellipsis when cut.
export function capUnits(s: string, n: number): string {
  if (s.length <= n) return s;
  let end = Math.max(0, n - ELLIPSIS.length);
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end).trimEnd() + ELLIPSIS;
}

// capBytes cuts s to at most n bytes of UTF-8 (ntfy's count), on a
// character's boundary, with an ellipsis when cut.
export function capBytes(s: string, n: number): string {
  if (Buffer.byteLength(s) <= n) return s;
  const room = n - Buffer.byteLength(ELLIPSIS);
  let out = "";
  let used = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch);
    if (used + b > room) break;
    out += ch;
    used += b;
  }
  return out.trimEnd() + ELLIPSIS;
}

// topicName is the name of a room's topic, as `#room/topic` names it and a
// Telegram topic is called: plain, on one line, 1 to 128 characters,
// without / or #.
export function topicName(s: string): { ok: true; name: string } | { ok: false; error: string } {
  const t = clean(s, false);
  if (!t) return { ok: false, error: "an empty topic" };
  if (/[/#]/.test(t)) return { ok: false, error: "a topic's name holds no / or #" };
  if ([...t].length > 128) return { ok: false, error: "a topic's name is at most 128 characters" };
  return { ok: true, name: t };
}

// fill puts the values in a text of the preset: {person}, {choice}…
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([a-z_]+)\}/g, (m, k: string) => (Object.hasOwn(values, k) ? String(values[k]) : m));
}

// linkError says why a link a node gives is refused, or "": http(s) only,
// with no credentials in it, at most 2048 characters.
export function linkError(v: string): string {
  if (v.length > 2048) return "a link is at most 2048 characters";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return `${JSON.stringify(v.slice(0, 100))} is not an address`;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `${u.protocol} is not http(s)`;
  if (u.username || u.password) return "a link holds no credentials";
  if (/[\x00-\x20\x7f]/.test(v)) return "a link holds no spaces or control characters";
  return "";
}

// escapeHTML for the reply page.
export function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
