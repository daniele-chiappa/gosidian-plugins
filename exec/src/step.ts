// What a step's two targets share: the server's environment, the node's
// settings, the step's folders, how a run ended, and the end of an output
// kept within a limit.
import type { Preset } from "./preset.ts";

export interface Env {
  preset: Preset;
  runsDir: string;
  // slotUid/slotGid: as root, a local step runs as the user of its slot
  // (slotUid + slot), in a group of its own (slotGid + slot), the only one
  // besides root that may enter the step's folder; the end of the step can
  // stop every process that user left behind.
  slotUid?: number;
  slotGid?: number;
  maxFilesBytes: number;
  maxOutFiles: number;
  maxOutBytes: number;
  // ssh is the ssh the server runs (EXEC_SSH); image the image's name, for
  // the output's executor.
  ssh: string;
  image: string;
  log(msg: string, fields?: Record<string, unknown>): void;
}

// The node's settings, checked against the preset, with its defaults.
export interface Settings {
  script?: string;
  command?: string[];
  target: string;
  repo?: { name: string; ref?: string };
  env: Record<string, string>;
  timeout: number;
  output_limit: number;
  processes: number;
  file_size: number;
  cpu_seconds: number;
  fail_on_error: boolean;
}

// The folders of a step. root is the server's: the slot's user may enter
// it, and no other. work is the script's working folder, with in/ (the
// files, read-only), out/ (what it gives back) and repo/; home, tmp and
// cache are its own. private holds what only the server reads (the host
// keys of an SSH step).
export interface Dirs {
  id: string;
  root: string;
  home: string;
  tmp: string;
  cache: string;
  work: string;
  in: string;
  out: string;
  repo: string;
  script: string;
  private: string;
}

// How a run ended, on either target; out is the folder of the files it
// gave back.
export interface Ran {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  canceled: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  seconds: number;
  out: string;
  skipped?: { name: string; error: string }[];
}

// Tail keeps the last limit bytes of an output, and how many came.
export class Tail {
  private chunks: Buffer[] = [];
  private size = 0;
  private readonly limit: number;
  total = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(b: Buffer): void {
    this.total += b.length;
    if (this.limit === 0) return;
    this.chunks.push(b);
    this.size += b.length;
    if (this.size > 2 * this.limit + (64 << 10)) {
      const keep = Buffer.concat(this.chunks).subarray(this.size - this.limit);
      this.chunks = [Buffer.from(keep)];
      this.size = keep.length;
    }
  }

  get truncated(): boolean {
    return this.total > this.limit;
  }

  text(): string {
    return endOf(Buffer.concat(this.chunks), this.limit);
  }
}

// endOf is the last limit bytes of b as text: a character cut in two at
// the start is dropped.
export function endOf(b: Buffer, limit: number): string {
  if (b.length <= limit) return b.toString("utf8");
  let t = b.subarray(b.length - limit);
  for (let i = 0; i < 3 && t.length && (t[0] & 0xc0) === 0x80; i++) t = t.subarray(1);
  return t.toString("utf8");
}

// lastLines is the end of an output for an error: its last lines, short.
export function lastLines(s: string, n = 5, max = 600): string {
  const lines = s.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-n).join(" | ");
  return lines.length > max ? "…" + lines.slice(-max) : lines;
}
