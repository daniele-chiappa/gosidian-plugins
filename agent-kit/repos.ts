// The repositories of a preset: the closed list a step may work on. The
// plugin's server clones, commits and pushes, with the credentials of the
// preset, which the agent never reads; the agent only edits the files. A
// repository reached over SSH has a deploy key of its own and its host key
// pinned; a pull request goes through its server's API (Gitea) with a token
// of the plugin's.
import fs from "node:fs";

// RepoError is an error of a repository's (a clone, a commit, a pull
// request): it fails the node with its message.
export class RepoError extends Error {}

export interface PullRequests {
  kind: "gitea";
  // api is the server's API, up to /api/v1; repo is owner/name.
  api: string;
  repo: string;
  token_file: string;
}

export interface Repo {
  name: string;
  url: string;
  // key_file is the repository's deploy key (SSH), a file only the
  // server reads; known_hosts the host keys it accepts, checked out of band.
  key_file?: string;
  known_hosts?: string;
  base: string;
  // A step commits on a branch of its own, under branch_prefix; never on
  // base nor on a protected one.
  branch_prefix: string;
  protected: string[];
  author: { name: string; email: string };
  // depth: the commits a clone fetches; 0 is the whole history.
  depth: number;
  // A step that changed more files, or more bytes, commits nothing.
  max_files: number;
  max_bytes: number;
  pr?: PullRequests;
}

export const repoSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "url"],
  properties: {
    name: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}$" },
    url: { type: "string", minLength: 1, maxLength: 1024 },
    key_file: { type: "string", minLength: 1 },
    known_hosts: { type: "string", minLength: 1 },
    known_hosts_file: { type: "string", minLength: 1 },
    base: { type: "string", minLength: 1 },
    branch_prefix: { type: "string", pattern: "^[A-Za-z0-9._-]+/$" },
    protected: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
    author: {
      type: "object",
      additionalProperties: false,
      required: ["name", "email"],
      properties: { name: { type: "string", minLength: 1 }, email: { type: "string", minLength: 3 } },
    },
    depth: { type: "integer", minimum: 0 },
    max_files: { type: "integer", minimum: 1 },
    max_bytes: { type: "integer", minimum: 1 },
    pr: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "api", "repo", "token_file"],
      properties: {
        kind: { enum: ["gitea"] },
        api: { type: "string", pattern: "^https?://" },
        repo: { type: "string", pattern: "^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$" },
        token_file: { type: "string", minLength: 1 },
      },
    },
  },
};

export const reposSchema = { type: "array", items: repoSchema };

const DEFAULT_AUTHOR = { name: "gosidian agent", email: "agent@gosidian.invalid" };

// isSSH says whether a repository's URL goes over SSH: ssh://… or the
// scp-like user@host:path.
export function isSSH(url: string): boolean {
  return url.startsWith("ssh://") || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(url);
}

// parseRepos fills in the defaults of a preset's repos, already checked
// against reposSchema, and checks what a schema does not say.
export function parseRepos(raw: any[] | undefined, file: string): Repo[] {
  const seen = new Set<string>();
  return (raw ?? []).map((r) => {
    const what = `${file}: repos ${r.name}`;
    if (seen.has(r.name)) throw new Error(`${what} twice`);
    seen.add(r.name);
    if (/^-|[\s\x00-\x1f]/.test(r.url) || /^ext::/.test(r.url)) throw new Error(`${what}: ${JSON.stringify(r.url)} is not a repository's URL`);
    if (r.known_hosts && r.known_hosts_file) throw new Error(`${what}: known_hosts or known_hosts_file, not both`);
    const known = r.known_hosts_file ? fs.readFileSync(r.known_hosts_file, "utf8") : r.known_hosts;
    if (isSSH(r.url)) {
      if (!r.key_file) throw new Error(`${what}: an SSH repository needs its deploy key (key_file)`);
      if (!known?.trim()) throw new Error(`${what}: an SSH repository needs its host keys (known_hosts), checked out of band`);
    }
    const base = r.base ?? "main";
    return {
      name: r.name,
      url: r.url,
      ...(r.key_file ? { key_file: r.key_file } : {}),
      ...(known ? { known_hosts: String(known).trim() + "\n" } : {}),
      base,
      branch_prefix: r.branch_prefix ?? "agent/",
      protected: [...new Set([base, ...(r.protected ?? [])])],
      author: r.author ?? DEFAULT_AUTHOR,
      depth: r.depth ?? 0,
      max_files: r.max_files ?? 500,
      max_bytes: r.max_bytes ?? 20 << 20,
      ...(r.pr ? { pr: { ...r.pr, api: String(r.pr.api).replace(/\/+$/, "") } } : {}),
    };
  });
}

// hostsOf gives the hosts a preset's repositories reach, for the manifest's
// permissions.network.
export function hostsOf(repos: Repo[]): string[] {
  const hosts = new Set<string>();
  for (const r of repos) {
    const h = hostOf(r.url);
    if (h) hosts.add(h);
    if (r.pr) hosts.add(new URL(r.pr.api).host);
  }
  return [...hosts];
}

function hostOf(url: string): string | undefined {
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):/.exec(url);
  if (scp && !url.includes("://")) return scp[1];
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}
