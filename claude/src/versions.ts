// The versions of Claude Code in the plugin's volume: none is in the image
// (its license is not open). Each is installed aside, in versions/<v>/,
// probed (each alias of the preset, haiku, sonnet, opus…, run once with a
// prompt of one word, to learn the model it resolves to), and made the
// version in use by a pointer, state.json. A step runs on the version in
// use and holds it while it runs: a switch waits for the running steps,
// and the steps that come during a switch wait for it.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { StepError } from "./files.ts";

export const PACKAGE = "@anthropic-ai/claude-code";
export const RELEASE_NOTES = "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md";

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function isVersion(s: string): boolean {
  return VERSION.test(s);
}

// compareVersions orders two versions x.y.z(-pre): negative when a is
// older; a prerelease comes before its release.
export function compareVersions(a: string, b: string): number {
  const x = VERSION.exec(a);
  const y = VERSION.exec(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d;
  }
  if (x[4] === y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  return x[4] < y[4] ? -1 : 1;
}

// RWLock lets many readers (the steps) or one writer (a switch) hold it;
// a waiting writer goes before the readers that come after it.
export class RWLock {
  private readers = 0;
  private writer = false;
  private queue: { write: boolean; go: () => void }[] = [];

  private pump(): void {
    while (this.queue.length) {
      const next = this.queue[0];
      if (next.write) {
        if (this.writer || this.readers) return;
        this.queue.shift();
        this.writer = true;
        next.go();
        return;
      }
      if (this.writer) return;
      this.queue.shift();
      this.readers++;
      next.go();
    }
  }

  private take(write: boolean): Promise<() => void> {
    return new Promise((ok) => {
      this.queue.push({
        write,
        go: () =>
          ok(() => {
            if (write) this.writer = false;
            else this.readers--;
            this.pump();
          }),
      });
      this.pump();
    });
  }

  async read<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.take(false);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async write<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.take(true);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  get state(): { readers: number; writer: boolean; waiting: number } {
    return { readers: this.readers, writer: this.writer, waiting: this.queue.length };
  }
}

export interface Probe {
  at: string;
  ok: boolean;
  aliases: Record<string, string>;
  error?: string;
}

export interface VersionMeta {
  version: string;
  // bin is the native binary, relative to the version's folder.
  bin: string;
  installed_at: string;
  // effort_levels are those --effort takes, from the version's --help.
  effort_levels: string[];
  probe?: Probe;
}

export interface Installer {
  // install puts a version into dir, a new folder, and says where its
  // binary is (relative to dir) and the effort levels it takes.
  install(version: string, dir: string): Promise<{ bin: string; effort_levels: string[] }>;
}

export interface Prober {
  // probe runs the binary once with the alias, and gives the model it
  // resolved to.
  probe(bin: string, alias: string): Promise<string>;
}

export interface Registry {
  distTags(): Promise<Record<string, string>>;
}

export interface VersionsOptions {
  dir: string;
  installer: Installer;
  prober: Prober;
  registry: Registry;
  // channel is the preset's version: a tag (latest) or a version.
  channel: string;
  // aliases are the preset's models a probe runs.
  aliases: string[];
  // noProbe says why there is nothing to probe: a preset without an
  // Anthropic endpoint has no aliases of Claude Code.
  noProbe?: string;
  // keep is how many versions stay installed at most (the one in use, the
  // one before it and the newest among them).
  keep?: number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface UpdateResult {
  old_version: string | null;
  new_version: string;
  current: string | null;
  switched: boolean;
  old_aliases: Record<string, string>;
  new_aliases: Record<string, string>;
  changed: { alias: string; old: string | null; new: string }[];
  release_notes: string;
  installed_versions: string[];
}

interface State {
  current: string | null;
  previous: string | null;
  updated_at?: string;
}

export class Versions {
  readonly lock = new RWLock();
  // phase says what the store is doing: ready, installing <v>, probing <v>,
  // switching <v>; error is why the first install failed.
  phase = "ready";
  error = "";
  private o: VersionsOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private first: Promise<void> | undefined;
  // reprobed: the version in use was probed again at the start (ensure).
  private reprobed = false;
  // probing is the probe after the first install, for whoever waits for it.
  probing: Promise<void> = Promise.resolve();

  constructor(o: VersionsOptions) {
    this.o = o;
    fs.mkdirSync(path.join(o.dir, "versions"), { recursive: true });
  }

  private log(msg: string, fields: Record<string, unknown> = {}): void {
    this.o.log?.(msg, fields);
  }

  private get statePath(): string {
    return path.join(this.o.dir, "state.json");
  }

  private state(): State {
    try {
      const s = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      return { current: s.current ?? null, previous: s.previous ?? null, updated_at: s.updated_at };
    } catch {
      return { current: null, previous: null };
    }
  }

  private writeState(s: State): void {
    const tmp = `${this.statePath}.${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...s, updated_at: new Date().toISOString() }, null, 2) + "\n");
    fs.renameSync(tmp, this.statePath);
  }

  current(): string | null {
    const c = this.state().current;
    return c && this.meta(c) ? c : null;
  }

  versionDir(v: string): string {
    return path.join(this.o.dir, "versions", v);
  }

  meta(v: string): VersionMeta | undefined {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.versionDir(v), "meta.json"), "utf8"));
    } catch {
      return undefined;
    }
  }

  private writeMeta(m: VersionMeta): void {
    const f = path.join(this.versionDir(m.version), "meta.json");
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(m, null, 2) + "\n");
    fs.renameSync(`${f}.tmp`, f);
  }

  binOf(m: VersionMeta): string {
    return path.join(this.versionDir(m.version), m.bin);
  }

  installed(): string[] {
    return fs
      .readdirSync(path.join(this.o.dir, "versions"))
      .filter((v) => isVersion(v) && this.meta(v))
      .sort((a, b) => compareVersions(b, a));
  }

  // resolve turns a tag of the registry into a version.
  async resolve(spec: string): Promise<string> {
    if (isVersion(spec)) return spec;
    const tags = await this.o.registry.distTags();
    const v = tags[spec];
    if (!v || !isVersion(v)) throw new StepError(`the npm registry has no version for the tag ${spec}`);
    return v;
  }

  // serial runs the store's changes one at a time.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async install(v: string): Promise<VersionMeta> {
    const have = this.meta(v);
    if (have) return have;
    const tmp = path.join(this.o.dir, "versions", `.${v}-${crypto.randomBytes(4).toString("hex")}`);
    this.phase = `installing ${v}`;
    this.log("installing Claude Code", { version: v });
    try {
      const got = await this.o.installer.install(v, tmp);
      fs.rmSync(this.versionDir(v), { recursive: true, force: true });
      fs.renameSync(tmp, this.versionDir(v));
      const m: VersionMeta = { version: v, bin: got.bin, installed_at: new Date().toISOString(), effort_levels: got.effort_levels };
      this.writeMeta(m);
      this.log("Claude Code installed", { version: v, effort_levels: got.effort_levels });
      return m;
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e instanceof StepError ? e : new StepError(`installing Claude Code ${v} failed: ${(e as Error).message}`);
    } finally {
      this.phase = "ready";
    }
  }

  // probe runs each alias of the preset on a version, and keeps what they
  // resolved to; a version that fails it is not switched to.
  private async probe(m: VersionMeta): Promise<Record<string, string>> {
    this.phase = `probing ${m.version}`;
    const aliases: Record<string, string> = {};
    try {
      for (const a of this.o.aliases) {
        try {
          aliases[a] = await this.o.prober.probe(this.binOf(m), a);
        } catch (e) {
          const error = `${a}: ${(e as Error).message}`;
          this.writeMeta({ ...m, probe: { at: new Date().toISOString(), ok: false, aliases, error } });
          throw new StepError(`Claude Code ${m.version} failed its probe: ${error}`);
        }
      }
      this.writeMeta({ ...m, probe: { at: new Date().toISOString(), ok: true, aliases } });
      this.log("Claude Code probed", { version: m.version, aliases });
      return aliases;
    } finally {
      this.phase = "ready";
    }
  }

  private async switchTo(v: string): Promise<void> {
    this.phase = `switching ${v}`;
    try {
      // The steps running on the version in use end first.
      await this.lock.write(async () => {
        const s = this.state();
        if (s.current === v) return;
        this.writeState({ current: v, previous: s.current });
        this.prune();
      });
      this.log("Claude Code switched", { version: v });
    } finally {
      this.phase = "ready";
    }
  }

  // prune keeps the version in use, the one before it, and the newest of
  // the others, up to keep.
  private prune(): void {
    const keep = Math.max(2, this.o.keep ?? 3);
    const s = this.state();
    const all = this.installed();
    const stay = new Set([s.current, s.previous].filter(Boolean) as string[]);
    for (const v of all) if (stay.size < keep) stay.add(v);
    for (const v of all) {
      if (!stay.has(v)) {
        fs.rmSync(this.versionDir(v), { recursive: true, force: true });
        this.log("Claude Code removed", { version: v });
      }
    }
  }

  // ensure installs the preset's version when none is in use, and then
  // probes it, after the steps that waited for it have started (a probe
  // needs a slot): its failure is only logged, there is no other version.
  // The server tries a failed install again (installLoop).
  ensure(): Promise<void> {
    const cur = this.current();
    if (cur) {
      // A version in use whose probe failed (a step folder it could not
      // write, the network) is probed again at the start: its aliases are
      // what an update compares the new ones with.
      const m = this.meta(cur);
      if (m && !m.probe?.ok && !this.reprobed) {
        this.reprobed = true;
        this.probing = this.serial(() => this.probe(m)).then(
          () => undefined,
          (e) => this.log("probing the version in use failed", { error: (e as Error).message }),
        );
      }
      return Promise.resolve();
    }
    this.first ??= this.serial(async () => {
      if (this.current()) return;
      const v = await this.resolve(this.o.channel);
      const m = await this.install(v);
      this.writeState({ current: v, previous: null });
      this.error = "";
      this.probing = this.serial(() => this.probe(m)).then(
        () => undefined,
        (e) => this.log("the first probe failed", { error: (e as Error).message }),
      );
    }).catch((e) => {
      this.error = (e as Error).message;
      this.first = undefined;
      throw e;
    });
    return this.first;
  }

  // use runs fn on the version in use, holding it: a switch waits for it.
  async use<T>(fn: (m: VersionMeta, bin: string) => Promise<T>): Promise<T> {
    if (!this.current()) {
      try {
        await this.ensure();
      } catch (e) {
        throw new StepError(`Claude Code is not installed: ${(e as Error).message}`);
      }
    }
    return this.lock.read(async () => {
      const v = this.current();
      const m = v ? this.meta(v) : undefined;
      if (!m) throw new StepError("Claude Code is not installed");
      return fn(m, this.binOf(m));
    });
  }

  // update installs a version aside, probes it and, with doSwitch, makes it
  // the version in use.
  update(spec: string | undefined, doSwitch: boolean): Promise<UpdateResult> {
    return this.serial(async () => {
      const v = await this.resolve(spec ?? this.o.channel);
      const old = this.current();
      // Without a probe that passed, the version in use would seem to change
      // every alias: it is probed again first, and if it fails again its
      // aliases stay unknown (null in changed).
      const om = old ? this.meta(old) : undefined;
      if (om && !om.probe?.ok && old !== v) {
        await this.probe(om).catch((e) => this.log("probing the version in use failed", { error: (e as Error).message }));
      }
      const oldAliases = (old && this.meta(old)?.probe?.aliases) || {};
      const m = await this.install(v);
      const aliases = await this.probe(m);
      if (doSwitch) await this.switchTo(v);
      const now = this.current();
      const changed = Object.entries(aliases)
        .filter(([a, id]) => oldAliases[a] !== id)
        .map(([alias, id]) => ({ alias, old: oldAliases[alias] ?? null, new: id }));
      return {
        old_version: old,
        new_version: v,
        current: now,
        switched: doSwitch && now === v && old !== v,
        old_aliases: oldAliases,
        new_aliases: aliases,
        changed,
        release_notes: RELEASE_NOTES,
        installed_versions: this.installed(),
      };
    });
  }

  // info is what the version node says, latest from the registry.
  async info(): Promise<Record<string, unknown>> {
    const cur = this.current();
    const m = cur ? this.meta(cur) : undefined;
    let latest: string | null = null;
    let registryError = "";
    try {
      latest = await this.resolve(isVersion(this.o.channel) ? "latest" : this.o.channel);
    } catch (e) {
      registryError = (e as Error).message;
    }
    return {
      installed: cur,
      channel: this.o.channel,
      latest,
      update_available: Boolean(cur && latest && compareVersions(latest, cur) > 0),
      aliases: m?.probe?.aliases ?? {},
      probed_at: m?.probe?.at ?? null,
      ...(m?.probe && !m.probe.ok ? { probe_error: m.probe.error } : {}),
      ...(this.o.noProbe ? { probe_skipped: this.o.noProbe } : {}),
      effort_levels: m?.effort_levels ?? [],
      installed_versions: this.installed(),
      state: this.phase,
      ...(this.error ? { error: this.error } : {}),
      ...(registryError ? { registry_error: registryError } : {}),
      release_notes: RELEASE_NOTES,
    };
  }
}
