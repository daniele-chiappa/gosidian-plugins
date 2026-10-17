// The version store with a fake installer and prober: the first install,
// an update aside (switch or not), a probe that fails, a switch that waits
// for the running steps and the steps that wait for it, the versions kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Versions, type Prober } from "../src/versions.ts";
import { FakeInstaller, FakeRegistry } from "./helpers.ts";

// FakeProber resolves an alias the way fake-claude.ts does, without a
// process: 1.x to the 4.5 models, the others to the 5.5; "broken" fails.
class FakeProber implements Prober {
  calls: string[] = [];
  // fail: every probe fails, as when the step's folder was not writable.
  fail = false;
  async probe(bin: string, alias: string): Promise<string> {
    const v = path.basename(path.dirname(bin));
    this.calls.push(`${v}:${alias}`);
    if (this.fail) throw new Error("EACCES, Permission denied");
    if (v.includes("broken")) throw new Error("no result (exit 1): Error: this version is broken");
    return v.startsWith("1.") ? `claude-${alias}-4-5-20251001` : `claude-${alias}-5-5`;
  }
}

function store(o: { keep?: number; channel?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-store-"));
  const installer = new FakeInstaller();
  const prober = new FakeProber();
  const registry = new FakeRegistry({ latest: "1.0.0", stable: "1.0.0" });
  const v = new Versions({ dir, installer, prober, registry, channel: o.channel ?? "latest", aliases: ["haiku", "sonnet"], keep: o.keep });
  return { v, dir, installer, prober, registry, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("the first start installs the preset's version, makes it current, then probes it", async () => {
  const s = store();
  try {
    assert.equal(s.v.current(), null);
    await s.v.ensure();
    assert.equal(s.v.current(), "1.0.0");
    await s.v.probing;
    assert.deepEqual(s.v.meta("1.0.0")!.probe!.aliases, { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-4-5-20251001" });
    assert.deepEqual(s.v.meta("1.0.0")!.effort_levels, ["low", "medium", "high", "xhigh", "max"]);
    await s.v.ensure();
    assert.deepEqual(s.installer.installs, ["1.0.0"], "installed once");
    assert.deepEqual(fs.readdirSync(path.join(s.dir, "versions")), ["1.0.0"], "no folder of a half install");
    s.registry.tags.latest = "2.0.0";
    const info: any = await s.v.info();
    assert.equal(info.installed, "1.0.0");
    assert.equal(info.latest, "2.0.0");
    assert.equal(info.update_available, true);
    assert.equal(info.aliases.haiku, "claude-haiku-4-5-20251001");
    assert.equal(info.release_notes, "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md");
  } finally {
    s.done();
  }
});

test("a failed install leaves nothing, and the next try installs", async () => {
  const s = store();
  try {
    s.installer.fail.add("1.0.0");
    await assert.rejects(s.v.ensure(), /installing Claude Code 1.0.0 failed: npm install failed/);
    assert.equal(s.v.current(), null);
    assert.deepEqual(fs.readdirSync(path.join(s.dir, "versions")), []);
    await assert.rejects(s.v.use(async () => "never"), /Claude Code is not installed/);
    s.installer.fail.clear();
    assert.equal(await s.v.use(async (m) => m.version), "1.0.0");
  } finally {
    s.done();
  }
});

test("update with switch false installs and probes aside; with switch it becomes current", async () => {
  const s = store();
  try {
    await s.v.ensure();
    await s.v.probing;
    s.registry.tags.latest = "2.0.0";
    const aside = await s.v.update(undefined, false);
    assert.deepEqual(aside, {
      old_version: "1.0.0",
      new_version: "2.0.0",
      current: "1.0.0",
      switched: false,
      old_aliases: { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-4-5-20251001" },
      new_aliases: { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5" },
      changed: [
        { alias: "haiku", old: "claude-haiku-4-5-20251001", new: "claude-haiku-5-5" },
        { alias: "sonnet", old: "claude-sonnet-4-5-20251001", new: "claude-sonnet-5-5" },
      ],
      release_notes: "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md",
      installed_versions: ["2.0.0", "1.0.0"],
    });
    assert.equal(s.v.current(), "1.0.0");
    const sw = await s.v.update("2.0.0", true);
    assert.equal(sw.switched, true);
    assert.equal(sw.current, "2.0.0");
    assert.deepEqual(s.installer.installs, ["1.0.0", "2.0.0"], "the version installed aside is not installed again");
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, "state.json"), "utf8")).previous, "1.0.0");
    const again = await s.v.update(undefined, true);
    assert.equal(again.switched, false, "already current");
    assert.deepEqual(again.changed, []);
  } finally {
    s.done();
  }
});

test("a version that fails its probe is not switched to", async () => {
  const s = store();
  try {
    await s.v.ensure();
    await s.v.probing;
    await assert.rejects(s.v.update("3.0.0-broken", true), /Claude Code 3.0.0-broken failed its probe: haiku: no result/);
    assert.equal(s.v.current(), "1.0.0");
    assert.equal(s.v.meta("3.0.0-broken")!.probe!.ok, false);
    const info: any = await s.v.info();
    assert.equal(info.installed, "1.0.0");
  } finally {
    s.done();
  }
});

test("a version in use whose probe failed is probed again: at the start, and before an update compares its aliases", async () => {
  const s = store();
  try {
    s.prober.fail = true;
    await s.v.ensure();
    await s.v.probing;
    assert.equal(s.v.current(), "1.0.0");
    assert.equal(s.v.meta("1.0.0")!.probe!.ok, false);
    s.prober.fail = false;
    // A restart: a new store on the same folder.
    const again = new Versions({ dir: s.dir, installer: s.installer, prober: s.prober, registry: s.registry, channel: "latest", aliases: ["haiku", "sonnet"] });
    await again.ensure();
    await again.probing;
    assert.deepEqual(again.meta("1.0.0")!.probe!.aliases, { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-4-5-20251001" });

    // The probe failed again, and an update comes: the version in use is
    // probed first, so the same models are no change.
    const m = again.meta("1.0.0")!;
    fs.writeFileSync(path.join(s.dir, "versions", "1.0.0", "meta.json"), JSON.stringify({ ...m, probe: { ...m.probe, ok: false, aliases: {} } }));
    s.registry.tags.latest = "1.0.1";
    const r = await again.update(undefined, false);
    assert.deepEqual(r.changed, [], "the same models after the version in use was probed again");
    assert.equal(again.meta("1.0.0")!.probe!.ok, true);
  } finally {
    s.done();
  }
});

test("a switch waits for the running steps, and the steps that come wait for it", async () => {
  const s = store();
  try {
    await s.v.ensure();
    await s.v.probing;
    let release!: () => void;
    const running = s.v.use((m) => new Promise<string>((ok) => (release = () => ok(m.version))));
    await new Promise((ok) => setTimeout(ok, 10));
    s.registry.tags.latest = "2.0.0";
    let switched = false;
    const upd = s.v.update(undefined, true).then((r) => ((switched = true), r));
    // Wait until the switch waits for the lock.
    for (let i = 0; i < 100 && !s.v.phase.startsWith("switching"); i++) await new Promise((ok) => setTimeout(ok, 5));
    assert.equal(s.v.phase, "switching 2.0.0");
    const later = s.v.use(async (m) => m.version);
    await new Promise((ok) => setTimeout(ok, 30));
    assert.equal(switched, false, "the running step holds the version");
    assert.equal(s.v.current(), "1.0.0");
    release();
    assert.equal(await running, "1.0.0");
    assert.equal((await upd).current, "2.0.0");
    assert.equal(await later, "2.0.0", "the step that came during the switch runs on the new version");
  } finally {
    s.done();
  }
});

test("the store keeps the version in use, the one before, and the newest up to keep", async () => {
  const s = store({ keep: 2 });
  try {
    await s.v.ensure();
    await s.v.probing;
    await s.v.update("1.5.0", false);
    assert.deepEqual(s.v.installed(), ["1.5.0", "1.0.0"]);
    await s.v.update("2.0.0", true);
    assert.deepEqual(s.v.installed(), ["2.0.0", "1.0.0"], "1.5.0 goes: neither in use nor the one before");
    await s.v.update("3.0.0", true);
    assert.deepEqual(s.v.installed(), ["3.0.0", "2.0.0"]);
  } finally {
    s.done();
  }
});

test("a pinned version installs as it is; a tag the registry lacks fails", async () => {
  const s = store({ channel: "1.2.3" });
  try {
    await s.v.ensure();
    assert.equal(s.v.current(), "1.2.3");
    await assert.rejects(s.v.update("next", false), /no version for the tag next/);
  } finally {
    s.done();
  }
});
