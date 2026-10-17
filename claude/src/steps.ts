// The last steps the plugin ran, for a dashboard of what the agent spent:
// when, for which project and run, on which model, how many tokens and
// dollars, and the error of those that failed. They are kept in a file of
// the versions' volume, so a restart keeps them; the newest CLAUDE_KEEP_STEPS.
import fs from "node:fs";
import path from "node:path";

export interface Step {
  // at is when the step ended.
  at: string;
  seconds: number;
  project?: string;
  run?: string;
  // model is the model it ran on, or the one asked for when it failed
  // before Claude Code started.
  model?: string;
  effort?: string | null;
  subtype?: string;
  turns?: number;
  tokens?: number;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  cost?: number;
  claude_code?: string;
  error?: string;
}

export class StepLog {
  private steps: Step[] = [];
  private file?: string;
  private keep: number;
  private log?: (msg: string, fields?: Record<string, unknown>) => void;

  constructor(opts: { file?: string; keep?: number; log?: (msg: string, fields?: Record<string, unknown>) => void } = {}) {
    this.file = opts.file;
    this.keep = Math.max(1, opts.keep ?? 100);
    this.log = opts.log;
    if (!this.file) return;
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(v)) this.steps = v.slice(-this.keep);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.log?.("the steps' file is unreadable: starting a new one", { error: (e as Error).message });
    }
  }

  add(s: Step): void {
    this.steps.push(s);
    if (this.steps.length > this.keep) this.steps.splice(0, this.steps.length - this.keep);
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.steps));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log?.("writing the steps' file failed", { error: (e as Error).message });
    }
  }

  // list gives the newest steps first: at most limit, those that ended
  // after since when it is given.
  list(limit: number, since?: string): Step[] {
    const after = since ? Date.parse(since) : NaN;
    const out: Step[] = [];
    for (let i = this.steps.length - 1; i >= 0 && out.length < limit; i--) {
      const s = this.steps[i];
      if (!Number.isNaN(after) && !(Date.parse(s.at) > after)) break;
      out.push(s);
    }
    return out;
  }

  get size(): number {
    return this.steps.length;
  }
}

// stepOf reads a step's record from the run's output.
export function stepOf(o: any, meta: Record<string, unknown> | undefined, t0: number, end: number): Step {
  const u = o?.usage ?? {};
  return {
    at: new Date(end).toISOString(),
    seconds: Math.round((end - t0) / 100) / 10,
    ...origin(meta),
    ...(o?.model ? { model: String(o.model) } : {}),
    effort: o?.effort?.applied ?? null,
    ...(o?.subtype ? { subtype: String(o.subtype) } : {}),
    ...(typeof o?.turns === "number" ? { turns: o.turns } : {}),
    ...(typeof u.total_tokens === "number" ? { tokens: u.total_tokens, input: u.input, output: u.output, cache_read: u.cache_read, cache_write: u.cache_write } : {}),
    ...(typeof o?.cost === "number" ? { cost: o.cost } : {}),
    ...(o?.claude_code ? { claude_code: String(o.claude_code) } : {}),
  };
}

// origin names the project and the run of gosidian that called.
export function origin(meta: Record<string, unknown> | undefined): { project?: string; run?: string } {
  const p = meta?.["gosidian/project"];
  const r = meta?.["gosidian/run"];
  return { ...(typeof p === "string" && p ? { project: p } : {}), ...(typeof r === "string" && r ? { run: r } : {}) };
}
