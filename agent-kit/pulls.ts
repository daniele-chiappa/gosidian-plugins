// The pull requests of a preset's repositories, on their server's API
// (Gitea) with the plugin's token, which the agent never reads: a step
// opens one for its branch (git.ts), and the node pr merges or closes one a
// step opened, then deletes its branch. pr acts only on a pull request of
// the repository itself, from a branch under the preset's prefix.
import fs from "node:fs";
import { RepoError, type Repo } from "./repos.ts";

const API_TIMEOUT = 30_000;

// prDescription is the node pr's.
export const prDescription = "Merges or closes a pull request a step opened (its branch under the preset's prefix) on a repository of the preset (Gitea), with the preset's token, then deletes the branch";

export interface PRRequest {
  repo: string;
  number?: number;
  url?: string;
  action: "merge" | "close";
  style?: "merge" | "rebase" | "squash";
  delete_branch?: boolean;
  title?: string;
  message?: string;
}

export interface PROutput {
  repo: string;
  number: number;
  url: string;
  action: "merge" | "close";
  // branch is the pull request's, the step's.
  branch: string;
  merged: boolean;
  closed: boolean;
  // sha is the merge commit, when merged.
  sha?: string;
  branch_deleted: boolean;
  note?: string;
}

// prSchema is the JSON Schema of the node pr's settings, from the preset's
// repositories that have pull requests.
export function prSchema(repos: Repo[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["repo", "action"],
    anyOf: [{ required: ["number"] }, { required: ["url"] }],
    properties: {
      repo: { enum: repos.filter((r) => r.pr).map((r) => r.name), description: "A repository of the preset with pull requests" },
      number: { type: "integer", minimum: 1, description: "The pull request's number; or url" },
      url: { type: "string", minLength: 1, description: "The pull request's URL, as run gives it (repo.pr_url); or number" },
      action: { enum: ["merge", "close"], description: "merge: into its base; close: unmerged" },
      style: { enum: ["merge", "rebase", "squash"], default: "merge", description: "How a merge is made (Gitea's Do): a merge commit, the commits rebased, or one commit" },
      delete_branch: { type: "boolean", default: true, description: "Then delete the pull request's branch: never a protected one" },
      title: { type: "string", description: "The merge commit's title" },
      message: { type: "string", description: "The merge commit's message" },
    },
  };
}

export const prOutput = {
  type: "object",
  properties: {
    repo: { type: "string" },
    number: { type: "integer" },
    url: { type: "string" },
    action: { enum: ["merge", "close"] },
    branch: { type: "string", description: "The pull request's branch" },
    merged: { type: "boolean" },
    closed: { type: "boolean" },
    sha: { type: "string", description: "The merge commit, when merged" },
    branch_deleted: { type: "boolean", description: "The branch is gone: deleted now, or before" },
    note: { type: "string" },
  },
};

// What the plugin reads of Gitea's pull request.
interface GiteaPR {
  html_url?: string;
  state?: string;
  merged?: boolean;
  merge_commit_sha?: string | null;
  head?: { ref?: string; repo?: { full_name?: string } | null };
}

// gitea calls the API of a repository's server, under
// /repos/<owner>/<name>, with the plugin's token.
async function gitea(repo: Repo, what: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  const pr = repo.pr!;
  const token = fs.readFileSync(pr.token_file, "utf8").trim();
  const signals = [AbortSignal.timeout(API_TIMEOUT), ...(signal ? [signal] : [])];
  try {
    const res = await fetch(`${pr.api}/repos/${pr.repo}${path}`, {
      method,
      headers: { Authorization: `token ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.any(signals),
    });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    throw new RepoError(`${what}: ${(e as Error).message}`);
  }
}

// said is what Gitea said: the message of its JSON, else the text.
function said(text: string): string {
  try {
    const m = (JSON.parse(text) as { message?: unknown }).message;
    if (typeof m === "string" && m) return m.slice(0, 300);
  } catch {
    // not JSON
  }
  return text.slice(0, 300);
}

// openPR opens a pull request of head into base on the repository's server.
export async function openPR(repo: Repo, head: string, base: string, title: string, body: string, signal?: AbortSignal): Promise<string> {
  const what = `repository ${repo.name}: the pull request`;
  const r = await gitea(repo, what, "POST", "/pulls", { head, base, title: title.slice(0, 255) || head, body }, signal);
  if (r.status !== 201) throw new RepoError(`${what}: ${r.status} ${r.text.slice(0, 300)}`);
  const url = (JSON.parse(r.text) as { html_url?: string }).html_url;
  if (!url) throw new RepoError(`${what} has no URL`);
  return url;
}

// pullRequest merges or closes a pull request a step opened, and deletes
// its branch. A merge or a close done already is no error: the output says
// how the pull request is.
export async function pullRequest(repos: Repo[], req: PRRequest, signal?: AbortSignal): Promise<PROutput> {
  const repo = repos.find((r) => r.name === req.repo);
  if (!repo) throw new RepoError(`the preset has no repository ${req.repo}`);
  if (!repo.pr) throw new RepoError(`repository ${repo.name} has no pull requests in the preset`);
  if (req.action !== "merge" && req.action !== "close") throw new RepoError(`action ${JSON.stringify(req.action)}: merge or close`);
  const number = numberOf(repo, req);
  const what = `repository ${repo.name}: pull request #${number}`;
  const get = async (): Promise<GiteaPR> => {
    const r = await gitea(repo, what, "GET", `/pulls/${number}`, undefined, signal);
    if (r.status !== 200) throw new RepoError(`${what}: ${r.status} ${said(r.text)}`);
    try {
      return JSON.parse(r.text) as GiteaPR;
    } catch {
      throw new RepoError(`${what}: the server's answer is not JSON`);
    }
  };
  let pr = await get();
  const branch = pr.head?.ref ?? "";
  if (!branch.startsWith(repo.branch_prefix)) throw new RepoError(`${what}: its branch ${JSON.stringify(branch)} is not under ${repo.branch_prefix}: only a step's pull request`);
  if (pr.head?.repo?.full_name?.toLowerCase() !== repo.pr.repo.toLowerCase()) throw new RepoError(`${what}: its branch is not in ${repo.pr.repo}: only a step's pull request`);
  const notes: string[] = [];
  if (req.action === "merge" && !pr.merged) {
    if (pr.state === "closed") throw new RepoError(`${what} is closed: nothing to merge`);
    // The plugin deletes the branch itself, after its checks.
    const body = { Do: req.style ?? "merge", delete_branch_after_merge: false, ...(req.title ? { MergeTitleField: req.title } : {}), ...(req.message ? { MergeMessageField: req.message } : {}) };
    const r = await gitea(repo, what, "POST", `/pulls/${number}/merge`, body, signal);
    if (r.status < 200 || r.status > 299) throw new RepoError(`${what}: the merge: ${r.status} ${said(r.text)}`);
    pr = await get();
    if (!pr.merged) throw new RepoError(`${what}: the merge: ${r.status}, and the pull request is not merged`);
  } else if (req.action === "close" && pr.state !== "closed") {
    const r = await gitea(repo, what, "PATCH", `/pulls/${number}`, { state: "closed" }, signal);
    if (r.status < 200 || r.status > 299) throw new RepoError(`${what}: the close: ${r.status} ${said(r.text)}`);
    pr = await get();
  } else {
    notes.push(pr.merged ? "merged already" : "closed already");
  }
  const out: PROutput = {
    repo: repo.name, number, url: pr.html_url ?? "", action: req.action, branch,
    merged: Boolean(pr.merged), closed: pr.state === "closed", ...(pr.merged && pr.merge_commit_sha ? { sha: pr.merge_commit_sha } : {}), branch_deleted: false,
  };
  if ((req.delete_branch ?? true) && out.closed) {
    if (repo.protected.includes(branch)) {
      notes.push(`the branch ${branch} is protected: kept`);
    } else {
      // A failure here keeps the branch, and the merge or the close stands.
      try {
        const r = await gitea(repo, what, "DELETE", `/branches/${branch.split("/").map(encodeURIComponent).join("/")}`, undefined, signal);
        if (r.status === 404) notes.push(`the branch ${branch} was gone already`);
        else if (r.status < 200 || r.status > 299) throw new RepoError(`${r.status} ${said(r.text)}`);
        // Deleted now, or gone before (Gitea may delete it at the merge).
        out.branch_deleted = true;
      } catch (e) {
        notes.push(`the branch ${branch} is kept: ${(e as Error).message}`);
      }
    }
  }
  return notes.length ? { ...out, note: notes.join("; ") } : out;
}

// numberOf is the pull request's number: the setting's, or its URL's, which
// must be a pull request of the repository (…/<owner>/<name>/pulls/<n>).
// The URL's host is not checked: the API may be reached at another.
function numberOf(repo: Repo, req: PRRequest): number {
  let n = req.number;
  if (req.url !== undefined) {
    let p = "";
    try {
      p = new URL(req.url).pathname;
    } catch {
      // not a URL
    }
    const m = /\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/?$/.exec(p);
    if (!m) throw new RepoError(`url ${JSON.stringify(req.url)} is not a pull request's URL`);
    const of = `${m[1]}/${m[2]}`;
    if (of.toLowerCase() !== repo.pr!.repo.toLowerCase()) throw new RepoError(`url ${req.url} is a pull request of ${of}, not of repository ${repo.name} (${repo.pr!.repo})`);
    const u = Number(m[3]);
    if (n !== undefined && n !== u) throw new RepoError(`number ${n} and url ${req.url} are two pull requests`);
    n = u;
  }
  if (n === undefined || !Number.isInteger(n) || n < 1) throw new RepoError("number or url: the pull request to act on");
  return n;
}
