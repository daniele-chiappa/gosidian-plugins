// The preset: its defaults, every field, the destinations it allows, the
// channels its people and rooms need, the secrets in files, and what it
// refuses; the plain text, the cuts, the quiet hours in a time zone.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LIMITS, DEFAULT_STRINGS, hostsOfPreset, parsePreset, parseQuiet } from "../src/preset.ts";
import { loadSecrets, redact } from "../src/secrets.ts";
import { capBytes, capUnits, clean, topicName, linkError } from "../src/text.ts";
import { inQuiet, minuteOf } from "../src/dispatch.ts";
import { tmp } from "./helpers.ts";

const MIN = `name: n
channels: {ntfy: {server: "https://ntfy.example.com"}}
people: {alice: {ntfy: alice-1}}
`;

test("defaults", () => {
  const p = parsePreset(MIN, "p", {});
  assert.equal(p.public_url, "");
  assert.equal(p.gosidian_url, "");
  assert.equal(p.gosidian_api, "");
  assert.equal(p.time_zone, "UTC");
  assert.equal(p.store_dir, "/var/lib/gosidian-notify");
  assert.deepEqual(p.limits, DEFAULT_LIMITS);
  assert.deepEqual(p.limits.per_hour, { person: 30, room: 60, channel: 300 });
  assert.equal(p.limits.group_window, 600);
  assert.deepEqual(p.strings, DEFAULT_STRINGS);
  assert.deepEqual(p.channels, { ntfy: { server: "https://ntfy.example.com" } });
  assert.deepEqual(p.people.alice, { name: "alice", ntfy: "alice-1" });
  assert.deepEqual(hostsOfPreset(p), ["ntfy.example.com:443"]);
});

test("every field, and the environment's public_url", () => {
  const p = parsePreset(`
name: avvisi
description: Gli avvisi
public_url: https://notify.example.com/base/
gosidian_url: https://gosidian.example.com
gosidian_api: http://gosidian:8080
time_zone: Europe/Rome
store_dir: /data/notify/
channels:
  telegram: {token_file: /run/secrets/tg, poll: false, poll_timeout: 30}
  ntfy: {server: "http://ntfy.example.com:8090/", token_file: /run/secrets/ntfy}
  email: {host: smtp.example.com, user_file: /run/secrets/u, password_file: /run/secrets/p, from: "Notify <notify@example.com>"}
people:
  alice: {telegram: 111, ntfy: alice-topic, email: alice@example.com, quiet: "22:30-7:00"}
  bob: {email: bob@example.com}
groups: {ops: [alice, bob]}
rooms:
  team:
    telegram: {chat: -1001234567890, topics: {Agents: 15, "release notes": 12}, auto_topics: true, max_auto_topics: 9}
    ntfy: {topic: team, topics: {errors: team-errors}}
    email: team@example.com
    quiet: "23:00-06:00"
limits:
  title: 120
  text: {telegram: 3000, ntfy: 2000, email: 9000}
  per_hour: {person: 5, room: 6, channel: 7}
  group_window: 5m
  expires: 2h
  max_expires: 2d
  held: 20
strings: {lang: it, answer: Rispondi, digest: "{count} avvisi durante il silenzio"}
`, "p", { NOTIFY_PUBLIC_URL: "http://ignored" });
  assert.equal(p.public_url, "https://notify.example.com/base");
  assert.equal(p.gosidian_api, "http://gosidian:8080");
  assert.equal(p.store_dir, "/data/notify");
  assert.deepEqual(p.channels.telegram, { token_file: "/run/secrets/tg", api_url: "https://api.telegram.org", poll: false, poll_timeout: 30 });
  assert.deepEqual(p.channels.email, { host: "smtp.example.com", port: 587, security: "starttls", user_file: "/run/secrets/u", password_file: "/run/secrets/p", from: "Notify <notify@example.com>" });
  assert.deepEqual(p.people.alice.quiet, { from: 22 * 60 + 30, to: 7 * 60, text: "22:30-07:00" });
  assert.deepEqual(p.groups.ops, ["alice", "bob"]);
  assert.deepEqual(p.rooms.team.telegram, { chat: -1001234567890, topics: { agents: 15, "release notes": 12 }, names: { agents: "Agents", "release notes": "release notes" }, auto_topics: true, max_auto_topics: 9 });
  assert.deepEqual(p.rooms.team.ntfy, { topic: "team", topics: { errors: "team-errors" } });
  assert.deepEqual(p.limits, { title: 120, text: { telegram: 3000, ntfy: 2000, email: 9000 }, per_hour: { person: 5, room: 6, channel: 7 }, group_window: 300, expires: 7200, max_expires: 172800, held: 20 });
  assert.equal(p.strings.answer, "Rispondi");
  assert.equal(p.strings.recorded, DEFAULT_STRINGS.recorded);
  assert.deepEqual(hostsOfPreset(p), ["api.telegram.org:443", "ntfy.example.com:8090", "smtp.example.com:587", "gosidian:8080"]);
  assert.equal(parsePreset(MIN, "p", { NOTIFY_PUBLIC_URL: "http://notify.lan:8086/" }).public_url, "http://notify.lan:8086");
  // TLS from the start on 465, unless the preset says otherwise.
  assert.equal(parsePreset(MIN.replace('ntfy: {server: "https://ntfy.example.com"}', "email: {host: smtp.example.com, port: 465, from: a@example.com}").replace("ntfy: alice-1", "email: a@example.com"), "p", {}).channels.email!.security, "tls");
});

test("what a preset may not be", () => {
  const bad = (y: string, why: RegExp) => assert.throws(() => parsePreset(y, "p", {}), why);
  bad("people: {}\n", /must have required property 'name'/);
  bad("name: x\n", /at least one of telegram, ntfy and email/);
  bad(`${MIN}extra: 1\n`, /must NOT have additional properties/);
  bad(MIN.replace("alice: {ntfy: alice-1}", "alice: {telegram: 1}"), /people.alice.telegram: the preset has no channels.telegram/);
  bad(MIN.replace("alice: {ntfy: alice-1}", "Alice: {ntfy: a}"), /must match pattern/);
  bad(MIN.replace("alice: {ntfy: alice-1}", "alice: {ntfy: 'has space'}"), /must match pattern/);
  bad(MIN.replace("alice: {ntfy: alice-1}", "alice: {ntfy: a, quiet: '25:00-07:00'}"), /is not hours like 22:00-07:00/);
  bad(MIN.replace("alice: {ntfy: alice-1}", "alice: {ntfy: a, quiet: '07:00-07:00'}"), /starts and ends at the same time/);
  bad(`${MIN}groups: {ops: [alice, zed]}\n`, /groups.ops: "zed" is not one of the people/);
  bad(`${MIN}rooms: {team: {}}\n`, /a room needs a channel/);
  bad(`${MIN}rooms: {team: {telegram: {chat: -1}}}\n`, /rooms.team.telegram: the preset has no channels.telegram/);
  bad(`${MIN}rooms: {team: {ntfy: {topic: t, topics: {"a/b": x}}}}\n`, /a topic's name holds no \/ or #/);
  bad(`${MIN}time_zone: Mars/Olympus\n`, /is not a time zone/);
  bad(`${MIN}limits: {expires: 9d}\n`, /limits.expires 9d is over limits.max_expires 7d/);
  bad(`${MIN}public_url: "http://x/?a=1"\n`, /a query/);
  bad(`${MIN}gosidian_url: "ftp://x"\n`, /not http\(s\)/);
  bad(MIN.replace('server: "https://ntfy.example.com"', 'server: "https://u:p@ntfy.example.com"'), /credentials/);
  bad(MIN.replace("alice: {ntfy: alice-1}", "alice: {ntfy: a, email: 'x@example.com\\nBcc: y@example.com'}"), /people\.alice\.email|must match pattern/);
  bad(`${MIN.replace('ntfy: {server: "https://ntfy.example.com"}', 'ntfy: {server: "https://ntfy.example.com"}, email: {host: h, from: a@example.com, user_file: /u}')}`, /user_file and password_file go together/);
  bad(`${MIN}strings: {recorded: "a\\nb"}\n`, /must match pattern/);
});

test("the example preset, presets/notify.yaml, is a valid one", () => {
  const p = parsePreset(fs.readFileSync(new URL("../presets/notify.yaml", import.meta.url), "utf8"), "presets/notify.yaml", {});
  assert.equal(p.name, "notify");
  assert.equal(p.time_zone, "Europe/Rome");
  assert.ok(p.rooms.team.telegram?.auto_topics);
  assert.deepEqual(p.limits, DEFAULT_LIMITS);
});

test("the secrets: read from their files, a missing or empty one stops the start, redact takes them out", () => {
  const dir = tmp("notify-secrets-");
  const f = (n: string, v: string) => {
    fs.writeFileSync(path.join(dir, n), v, { mode: 0o600 });
    return path.join(dir, n);
  };
  const tg = f("tg", "987654:AAEsecretpartofthetoken-xyz123\n");
  const nt = f("ntfy", "tk_anothersecret0123456789\n");
  const u = f("u", "mailer\n");
  const pw = f("p", "hunter2-smtp-pass\n");
  const p = parsePreset(`name: x
channels:
  telegram: {token_file: ${tg}}
  ntfy: {server: "https://ntfy.example.com", token_file: ${nt}}
  email: {host: smtp.example.com, user_file: ${u}, password_file: ${pw}, from: a@example.com}
people: {alice: {telegram: 1}}
`, "p", {});
  const s = loadSecrets(p);
  assert.deepEqual(s, { telegram_token: "987654:AAEsecretpartofthetoken-xyz123", ntfy_token: "tk_anothersecret0123456789", smtp_user: "mailer", smtp_password: "hunter2-smtp-pass" });
  assert.equal(redact("a 987654:AAEsecretpartofthetoken-xyz123 b tk_anothersecret0123456789 c hunter2-smtp-pass d mailer"), "a [secret] b [secret] c [secret] d mailer");
  assert.equal(redact("POST https://x/bot123:ABCdef_-ghi/sendMessage"), "POST https://x/bot[secret]/sendMessage");
  assert.equal(redact("http://g/api/v1/runs/r1/resume?key=abcdef0123&step=w"), "http://g/api/v1/runs/r1/resume?key=[secret]&step=w");
  fs.writeFileSync(tg, "");
  assert.throws(() => loadSecrets(p), /channels.telegram.token_file: .* is empty/);
  fs.writeFileSync(tg, "not a token");
  assert.throws(() => loadSecrets(p), /does not hold a bot's token/);
  fs.rmSync(tg);
  assert.throws(() => loadSecrets(p), /cannot be read \(ENOENT\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("plain text: no control characters, no reordering, one line for a title; the cuts", () => {
  const ch = (...c: number[]) => String.fromCharCode(...c);
  assert.equal(clean(`a${ch(0x202e)}b${ch(0x2066)}c${ch(0x200f)}d${ch(0)}e${ch(0x1b)}f${ch(0x7f)}g${ch(0x85)}h${ch(0x2028)}i`, false), "abcdefghi");
  assert.equal(clean("  uno\r\ndue\rtre\n\n\n\nquattro\t \n", true), "uno\ndue\ntre\n\nquattro");
  assert.equal(clean("titolo\nsu\tdue  righe", false), "titolo su due righe");
  assert.equal(clean("<b>bold</b> *md* [x](javascript:alert(1))", true), "<b>bold</b> *md* [x](javascript:alert(1))", "HTML and markdown stay text");
  assert.equal(capUnits("abcdef", 6), "abcdef");
  assert.equal(capUnits("abcdefg", 6), "abcde…");
  // A pair is never cut in half.
  assert.equal(capUnits("abcd😀xyz", 6), "abcd…");
  assert.equal(capBytes("àààà", 8), "àààà");
  assert.equal(capBytes("àààà", 7), "àà…");
  assert.ok(Buffer.byteLength(capBytes("é".repeat(5000), 4096)) <= 4096);
  assert.deepEqual(topicName("  release   notes "), { ok: true, name: "release notes" });
  assert.equal(topicName("a/b").ok, false);
  assert.equal(topicName("x".repeat(129)).ok, false);
  assert.equal(topicName(ch(0x202e)).ok, false);
  assert.equal(linkError("https://example.com/a?b=1"), "");
  assert.match(linkError("javascript:alert(1)"), /not http\(s\)/);
  assert.match(linkError("https://u:p@example.com/"), /no credentials/);
  assert.match(linkError("nope"), /not an address/);
});

test("quiet hours in the preset's time zone", () => {
  const q = parseQuiet("22:00-07:00", "q");
  const rome = (s: string) => Date.parse(`2026-10-20T${s}:00+02:00`);
  assert.equal(minuteOf(rome("22:15"), "Europe/Rome"), 22 * 60 + 15);
  assert.equal(minuteOf(rome("22:15"), "UTC"), 20 * 60 + 15);
  assert.equal(inQuiet(q, rome("21:59"), "Europe/Rome"), false);
  assert.equal(inQuiet(q, rome("22:00"), "Europe/Rome"), true);
  assert.equal(inQuiet(q, rome("03:00"), "Europe/Rome"), true);
  assert.equal(inQuiet(q, rome("07:00"), "Europe/Rome"), false);
  // In UTC, the same instants are two hours earlier.
  assert.equal(inQuiet(q, rome("23:30"), "UTC"), false);
  assert.equal(inQuiet(q, rome("00:30"), "UTC"), true);
  const day = parseQuiet("12:00-14:00", "q");
  assert.equal(inQuiet(day, rome("13:00"), "Europe/Rome"), true);
  assert.equal(inQuiet(day, rome("14:00"), "Europe/Rome"), false);
  // After the change to winter time (25 October): 22:30 is UTC+1.
  assert.equal(inQuiet(q, Date.parse("2026-10-26T21:30:00Z"), "Europe/Rome"), true);
  assert.equal(inQuiet(q, Date.parse("2026-10-26T20:30:00Z"), "Europe/Rome"), false);
});
