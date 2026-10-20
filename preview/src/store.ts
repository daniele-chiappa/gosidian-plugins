// The previews on disk: <store>/<id>/meta.json and <store>/<id>/site/, the
// files. A preview is made in <id>.tmp/ and renamed when whole, so the
// HTTP server never sees half of one. The index of the live previews is in
// memory, read from the meta.json files at start; the sweep removes the
// expired ones, at start and every hour.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface Meta {
  id: string;
  project: string;
  run: string | null;
  title: string;
  created: string;
  expires: string;
  bytes: number;
  files: number;
  index: string;
  spa: boolean;
}

// An id: 128 random bits in base32, lower case, 26 characters.
export const ID = /^[a-z2-7]{26}$/;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
// What the store's folder may hold: previews, and what a publish leaves
// while it works. Anything else is not the plugin's, and stays.
const ENTRY = /^([a-z2-7]{26})(\.tmp|\.zip)?$/;

export function newId(): string {
  const b = crypto.randomBytes(17);
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of b) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

export class Store {
  readonly dir: string;
  private metas = new Map<string, Meta>();
  private readonly now: () => number;
  private readonly log: (msg: string, f?: Record<string, unknown>) => void;
  // A chain that runs the publishes one at a time: the room in the store
  // is counted, then taken.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, opts: { now?: () => number; log?: (msg: string, f?: Record<string, unknown>) => void } = {}) {
    this.dir = dir;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  // open reads the previews on disk, and removes what a publish stopped
  // halfway left.
  open(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o750 });
    for (const name of fs.readdirSync(this.dir)) {
      const m = ENTRY.exec(name);
      if (!m) continue;
      const p = path.join(this.dir, name);
      if (m[2]) {
        fs.rmSync(p, { recursive: true, force: true });
        continue;
      }
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(p, "meta.json"), "utf8")) as Meta;
        if (meta.id !== name) throw new Error(`its id is ${meta.id}`);
        this.metas.set(name, meta);
      } catch (e) {
        this.log("a preview without a valid meta.json: removed", { id: name, error: (e as Error).message });
        fs.rmSync(p, { recursive: true, force: true });
      }
    }
  }

  // get is a live preview, or undefined.
  get(id: string): Meta | undefined {
    if (!ID.test(id)) return undefined;
    const m = this.metas.get(id);
    return m && Date.parse(m.expires) > this.now() ? m : undefined;
  }

  // peek is a preview kept, live or expired.
  peek(id: string): Meta | undefined {
    return ID.test(id) ? this.metas.get(id) : undefined;
  }

  // ofProject are the live previews of a project, the newest first.
  ofProject(project: string): Meta[] {
    const now = this.now();
    return [...this.metas.values()]
      .filter((m) => m.project === project && Date.parse(m.expires) > now)
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  get count(): number {
    return this.metas.size;
  }

  // used is the bytes of the previews kept, expired or not.
  used(): number {
    let n = 0;
    for (const m of this.metas.values()) n += m.bytes;
    return n;
  }

  siteDir(id: string): string {
    return path.join(this.dir, id, "site");
  }

  // remove takes a preview away: out of the index first, so it is not
  // served while its files go.
  remove(id: string): boolean {
    if (!ID.test(id) || !this.metas.has(id)) return false;
    this.metas.delete(id);
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    return true;
  }

  // sweep removes the expired previews; it gives how many.
  sweep(): number {
    const now = this.now();
    let n = 0;
    for (const m of [...this.metas.values()]) {
      if (Date.parse(m.expires) <= now) {
        this.remove(m.id);
        this.log("preview expired: removed", { id: m.id, project: m.project });
        n++;
      }
    }
    return n;
  }

  // exclusive runs fn when the publishes before it are done.
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // add makes a preview whose files are in tmp/site live: its meta.json is
  // written, and tmp renamed to the id.
  add(tmp: string, meta: Meta): void {
    fs.writeFileSync(path.join(tmp, "meta.json"), JSON.stringify(meta, null, 2) + "\n", { mode: 0o640 });
    fs.renameSync(tmp, path.join(this.dir, meta.id));
    this.metas.set(meta.id, meta);
  }

  // isoNow is the store's clock, as an ISO date.
  isoAt(offsetSeconds = 0): string {
    return new Date(this.now() + offsetSeconds * 1000).toISOString();
  }

  get nowMs(): number {
    return this.now();
  }
}
