// The repository of a step (agent-run/1's repo setting). The plugin's
// server clones it on a branch of the step's own, the agent edits the
// files, and the server commits what changed, pushes the branch and opens a
// pull request. The agent never holds the preset's credentials, and the
// server runs nothing of the repository's: the git folder lies outside the
// work tree, where the agent reads it (git log, git diff) and cannot write
// it, and every git command runs without hooks, without the system's or a
// user's configuration, without filters.
import fs from "node:fs";
import path from "node:path";
import type { Repo } from "./repos.ts";
import { exec } from "./exec.ts";

export interface RepoRequest {
  name: string;
  base?: string;
  branch?: string;
  push?: boolean;
  pr?: boolean | { title?: string; body?: string };
}

export interface RepoOutput {
  name: string;
  base: string;
  branch: string;
  commit?: string;
  changed: number;
  insertions: number;
  deletions: number;
  pushed: boolean;
  pr_url?: string;
  note?: string;
}

export class RepoError extends Error {}

// What every git command of the server runs with, whatever the repository
// or the agent wrote: no hooks, no fsmonitor, no ext:: transport, no
// credential helper, no signing.
const SAFE = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "protocol.ext.allow=never",
  "-c", "credential.helper=",
  "-c", "commit.gpgSign=false",
  "-c", "core.autocrlf=false",
  "-c", "advice.detachedHead=false",
];

const GIT_TIMEOUT = 10 * 60_000;

// repoSettingSchema is the JSON Schema of the node's repo setting, from the
// preset's repositories.
export function repoSettingSchema(repos: Repo[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    description: "A repository of the preset to work on: the plugin clones it on a branch of the step's own and commits what the agent changed; the agent only edits",
    properties: {
      name: { enum: repos.map((r) => r.name) },
      base: { type: "string", description: "The branch to start from; default the preset's" },
      branch: { type: "string", description: "The branch to commit on, under the preset's prefix; default <prefix><run>-<step>" },
      push: { type: "boolean", default: true },
      pr: {
        description: "Open a pull request (a repository with pr in the preset)",
        anyOf: [{ type: "boolean" }, { type: "object", additionalProperties: false, properties: { title: { type: "string" }, body: { type: "string" } } }],
      },
    },
  };
}

// shq quotes a word for the shell that runs GIT_SSH_COMMAND.
function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export class Workspace {
  readonly repo: Repo;
  readonly req: RepoRequest;
  readonly base: string;
  readonly branch: string;
  readonly gitDir: string;
  readonly workTree: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly signal?: AbortSignal;

  private constructor(repo: Repo, req: RepoRequest, base: string, branch: string, root: string, workTree: string, signal?: AbortSignal) {
    this.repo = repo;
    this.req = req;
    this.base = base;
    this.branch = branch;
    this.gitDir = path.join(root, "git");
    this.workTree = workTree;
    this.signal = signal;
    // The server's own home for git and ssh: only it reads it.
    const home = path.join(root, "git-home");
    fs.mkdirSync(home, { mode: 0o700 });
    this.env = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    if (repo.key_file) {
      const known = path.join(home, "known_hosts");
      fs.writeFileSync(known, repo.known_hosts ?? "", { mode: 0o600 });
      this.env.GIT_SSH_COMMAND = [
        "ssh", "-F", "/dev/null", "-i", shq(repo.key_file),
        "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
        "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${shq(known)}`, "-o", "GlobalKnownHostsFile=/dev/null",
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=20",
      ].join(" ");
    }
  }

  // open clones repo into workTree (which must not exist) on base and
  // starts the step's branch; the git folder goes in root, a folder only
  // the server writes. The slot's user may then edit every file.
  static async open(repo: Repo, req: RepoRequest, o: { root: string; workTree: string; defaultBranch: string; signal?: AbortSignal }): Promise<Workspace> {
    const base = req.base ?? repo.base;
    const branch = req.branch ?? o.defaultBranch;
    const w = new Workspace(repo, req, base, branch, o.root, o.workTree, o.signal);
    await w.checkRef(base, "base");
    await w.checkRef(branch, "branch");
    if (!branch.startsWith(repo.branch_prefix)) throw new RepoError(`branch ${branch}: a step commits under ${repo.branch_prefix}`);
    if (repo.protected.includes(branch)) throw new RepoError(`branch ${branch} is protected: a step never commits on it`);
    const depth = repo.depth > 0 ? [`--depth=${repo.depth}`] : [];
    await w.git(["clone", "--quiet", "--no-checkout", "--single-branch", `--branch=${base}`, `--separate-git-dir=${w.gitDir}`, ...depth, "--", repo.url, w.workTree], { bare: true });
    await w.git(["checkout", "--quiet", "-b", branch]);
    openUp(w.workTree);
    return w;
  }

  // agentConfig is a git configuration for the agent's home: it may read
  // the repository (log, diff, status), which belongs to the server.
  agentConfig(): string {
    return `[safe]\n\tdirectory = ${this.workTree}\n[core]\n\thooksPath = /dev/null\n`;
  }

  // finish commits what the agent changed, within the preset's limits,
  // pushes the branch and opens the pull request, as the request says.
  async finish(message: string): Promise<RepoOutput> {
    const out: RepoOutput = { name: this.repo.name, base: this.base, branch: this.branch, changed: 0, insertions: 0, deletions: 0, pushed: false };
    const { files, bytes } = await this.scan();
    if (files > this.repo.max_files) throw new RepoError(`${files} files changed, at most ${this.repo.max_files}: nothing committed`);
    if (bytes > this.repo.max_bytes) throw new RepoError(`${bytes} bytes changed, at most ${this.repo.max_bytes}: nothing committed`);
    await this.git(["add", "--all", "--", "."]);
    const stat = await this.git(["diff", "--cached", "--numstat", "--no-renames", "-z", "HEAD"]);
    for (const entry of stat.split("\0")) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(entry);
      if (!m) continue;
      out.changed++;
      out.insertions += m[1] === "-" ? 0 : Number(m[1]);
      out.deletions += m[2] === "-" ? 0 : Number(m[2]);
    }
    if (out.changed === 0) return { ...out, note: "nothing changed: no commit" };
    const { name, email } = this.repo.author;
    await this.git(["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "--quiet", "--no-verify", "--file=-"], { input: message });
    out.commit = (await this.git(["rev-parse", "HEAD"])).trim();
    if (this.req.push === false) return out;
    await this.git(["push", "--porcelain", "origin", `HEAD:refs/heads/${this.branch}`]);
    out.pushed = true;
    if (!this.req.pr) return out;
    if (!this.repo.pr) return { ...out, note: `repository ${this.repo.name} has no pull requests in the preset: the branch is pushed` };
    const ask = typeof this.req.pr === "object" ? this.req.pr : {};
    const first = message.split("\n")[0].trim();
    out.pr_url = await openPR(this.repo, this.branch, this.base, ask.title ?? first, ask.body ?? message, this.signal);
    return out;
  }

  // scan checks the files the agent changed before git reads them: plain
  // files of one link, folders and symbolic links only (a hard link could
  // bring in a file only the server reads), within the limits.
  private async scan(): Promise<{ files: number; bytes: number }> {
    const list = await this.git(["ls-files", "-z", "--modified", "--deleted", "--others", "--exclude-standard"]);
    const paths = [...new Set(list.split("\0").filter(Boolean))];
    let bytes = 0;
    for (const p of paths) {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(path.join(this.workTree, p));
      } catch {
        continue; // deleted
      }
      if (st.isSymbolicLink()) continue;
      if (!st.isFile()) throw new RepoError(`${p} is not a file: nothing committed`);
      if (st.nlink > 1) throw new RepoError(`${p} is a hard link: nothing committed`);
      bytes += st.size;
    }
    return { files: paths.length, bytes };
  }

  private async checkRef(name: string, what: string): Promise<void> {
    if (name.startsWith("-")) throw new RepoError(`${what} ${name} is not a branch's name`);
    try {
      await this.git(["check-ref-format", "--branch", name], { bare: true });
    } catch {
      throw new RepoError(`${what} ${name} is not a branch's name`);
    }
  }

  private async git(args: string[], o: { bare?: boolean; input?: string } = {}): Promise<string> {
    const where = o.bare ? [] : [`--git-dir=${this.gitDir}`, `--work-tree=${this.workTree}`];
    try {
      // A command of no repository runs in the step's folder, never in a
      // repository the server's own folder may be in.
      const r = await exec("git", [...SAFE, ...where, ...args], {
        cwd: o.bare ? path.dirname(this.gitDir) : this.workTree,
        env: this.env,
        timeoutMs: GIT_TIMEOUT,
        signal: this.signal,
        input: o.input,
      });
      return r.stdout;
    } catch (err) {
      throw new RepoError(`repository ${this.repo.name}: ${redact((err as Error).message)}`);
    }
  }
}

// redact hides the credentials a URL may carry (https://user:token@host)
// in what git says, which goes into the node's error.
export function redact(s: string): string {
  return s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@");
}

// openUp lets the slot's user edit the checked-out files: folders 0777,
// files 0666 (0777 when executable). Links stay as they are; .git, the
// pointer to the git folder, stays the server's.
function openUp(dir: string, top = true): void {
  fs.chmodSync(dir, 0o777);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink() || (top && e.name === ".git")) continue;
    if (e.isDirectory()) openUp(p, false);
    else if (e.isFile()) fs.chmodSync(p, fs.statSync(p).mode & 0o111 ? 0o777 : 0o666);
  }
}

// openPR opens a pull request of head into base on the repository's server.
async function openPR(repo: Repo, head: string, base: string, title: string, body: string, signal?: AbortSignal): Promise<string> {
  const pr = repo.pr!;
  const token = fs.readFileSync(pr.token_file, "utf8").trim();
  const signals = [AbortSignal.timeout(30_000), ...(signal ? [signal] : [])];
  const res = await fetch(`${pr.api}/repos/${pr.repo}/pulls`, {
    method: "POST",
    headers: { Authorization: `token ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ head, base, title: title.slice(0, 255) || head, body }),
    redirect: "error",
    signal: AbortSignal.any(signals),
  });
  const text = await res.text();
  if (res.status !== 201) throw new RepoError(`repository ${repo.name}: the pull request: ${res.status} ${text.slice(0, 300)}`);
  const url = (JSON.parse(text) as { html_url?: string }).html_url;
  if (!url) throw new RepoError(`repository ${repo.name}: the pull request has no URL`);
  return url;
}
