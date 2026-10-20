// The repository of a step, against bare repositories on disk and a fake
// Gitea API: the clone on the step's branch, what the agent may and may not
// touch, the commit, the push, the pull request and the limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { parseRepos, hostsOf, isSSH } from "../repos.ts";
import { Workspace, RepoError, redact } from "../git.ts";
import { toolsFor } from "../contract.ts";
import { knownHostsFile, sshOptions, sshCommand } from "../ssh.ts";

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: os.tmpdir() };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, env, encoding: "utf8" });

// origin makes a bare repository with a commit on main: a.txt and a script.
function origin(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-"));
  const bare = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  git(dir, "init", "--quiet", "--bare", bare);
  git(dir, "init", "--quiet", seed);
  fs.writeFileSync(path.join(seed, "a.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(seed, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "push", "--quiet", bare, "main");
  return bare;
}

function step(): { root: string; workTree: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "step-"));
  fs.mkdirSync(path.join(root, "work"), { mode: 0o777 });
  return { root, workTree: path.join(root, "work", "repo") };
}

function repoOf(url: string, more: Record<string, unknown> = {}) {
  return parseRepos([{ name: "app", url, ...more }], "preset")[0];
}

test("parseRepos: defaults, SSH needs a key and pinned host keys", () => {
  const r = repoOf("/srv/app.git");
  assert.equal(r.base, "main");
  assert.equal(r.branch_prefix, "agent/");
  assert.deepEqual(r.protected, ["main"]);
  assert.equal(isSSH("git@git.example.com:team/app.git"), true);
  assert.equal(isSSH("ssh://git@git.example.com:2222/team/app.git"), true);
  assert.equal(isSSH("https://git.example.com/team/app.git"), false);
  assert.throws(() => repoOf("git@git.example.com:team/app.git"), /deploy key/);
  assert.throws(() => repoOf("git@git.example.com:team/app.git", { key_file: "/k" }), /host keys/);
  assert.throws(() => repoOf("ext::sh -c touch% /tmp/x"), /not a repository's URL/);
  assert.throws(() => repoOf("--upload-pack=x"), /not a repository's URL/);
  assert.throws(() => parseRepos([{ name: "a", url: "/x" }, { name: "a", url: "/y" }], "preset"), /twice/);
  const ssh = repoOf("git@git.example.com:team/app.git", { key_file: "/k", known_hosts: "git.example.com ssh-ed25519 AAAA", pr: { kind: "gitea", api: "https://git.example.com/api/v1/", repo: "team/app", token_file: "/t" } });
  assert.deepEqual(hostsOf([ssh]), ["git.example.com"]);
  assert.equal(ssh.pr?.api, "https://git.example.com/api/v1");
});

test("redact: no credentials of a URL in an error", () => {
  assert.equal(redact("fatal: unable to access 'https://bot:s3cret@git.example.com/a.git/'"), "fatal: unable to access 'https://***@git.example.com/a.git/'");
  assert.equal(redact("git@git.example.com:team/app.git"), "git@git.example.com:team/app.git");
});

test("toolsFor: a level and the ones under it, within the preset", () => {
  const byLevel = { read: ["Read", "Grep"], edit: ["Write", "Edit"], exec: ["Bash"] };
  assert.deepEqual(toolsFor("read", byLevel, ["Read", "Grep", "Write"]), ["Read", "Grep"]);
  assert.deepEqual(toolsFor("edit", byLevel, ["Read", "Grep", "Write"]), ["Read", "Grep", "Write"]);
  assert.throws(() => toolsFor("exec", byLevel, ["Read", "Grep", "Write"]), /Bash/);
});

test("a step: clone on its branch, the agent edits, the server commits and pushes", async () => {
  const bare = origin();
  const s = step();
  const w = await Workspace.open(repoOf(bare), { name: "app" }, { ...s, defaultBranch: "agent/r1-s1" });
  // The agent may edit every file, and not the git folder.
  assert.equal(fs.statSync(path.join(s.workTree, "a.txt")).mode & 0o777, 0o666);
  assert.equal(fs.statSync(path.join(s.workTree, "run.sh")).mode & 0o777, 0o777);
  assert.equal(fs.statSync(s.workTree).mode & 0o777, 0o777);
  assert.equal(fs.statSync(w.gitDir).mode & 0o022, 0);
  assert.ok(!w.gitDir.startsWith(s.workTree));
  assert.match(w.agentConfig(), /directory = /);
  // A hook in the git folder, and a filter the repository asks for, run
  // nothing.
  const mark = path.join(s.root, "hook-ran");
  fs.writeFileSync(path.join(w.gitDir, "hooks", "pre-commit"), `#!/bin/sh\ntouch ${mark}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(s.workTree, ".gitattributes"), "*.txt filter=evil\n");
  // The agent's work.
  fs.appendFileSync(path.join(s.workTree, "a.txt"), "three\n");
  fs.writeFileSync(path.join(s.workTree, "b.txt"), "new\n");
  const out = await w.finish("agent r1: add b\n\nThe agent's report.");
  assert.equal(fs.existsSync(mark), false, "a hook ran");
  assert.equal(out.branch, "agent/r1-s1");
  assert.equal(out.changed, 3);
  assert.equal(out.insertions, 3);
  assert.equal(out.pushed, true);
  assert.match(out.commit ?? "", /^[0-9a-f]{40}$/);
  assert.equal(git(bare, "rev-parse", "agent/r1-s1").trim(), out.commit);
  assert.equal(git(bare, "log", "-1", "--format=%s%n%an", "agent/r1-s1").trim(), "agent r1: add b\ngosidian agent");
  assert.equal(git(bare, "rev-list", "--count", "main").trim(), "1", "main moved");
});

test("nothing changed: no commit, no push", async () => {
  const s = step();
  const w = await Workspace.open(repoOf(origin()), { name: "app" }, { ...s, defaultBranch: "agent/r2-s1" });
  const out = await w.finish("nothing");
  assert.equal(out.changed, 0);
  assert.equal(out.pushed, false);
  assert.equal(out.commit, undefined);
  assert.match(out.note ?? "", /nothing changed/);
});

test("branches: under the prefix, never base or a protected one", async () => {
  const bare = origin();
  const repo = repoOf(bare, { protected: ["release"] });
  for (const branch of ["main", "release", "feature/x", "agent/../x", "-x"]) {
    await assert.rejects(Workspace.open(repo, { name: "app", branch }, { ...step(), defaultBranch: "agent/d" }), RepoError, branch);
  }
  const prefixed = repoOf(bare, { branch_prefix: "bots/", protected: ["bots/keep"] });
  await assert.rejects(Workspace.open(prefixed, { name: "app", branch: "bots/keep" }, { ...step(), defaultBranch: "bots/d" }), /protected/);
});

test("limits and odd files: nothing committed", async () => {
  const bare = origin();
  let s = step();
  let w = await Workspace.open(repoOf(bare, { max_files: 1 }), { name: "app" }, { ...s, defaultBranch: "agent/r3-s1" });
  fs.writeFileSync(path.join(s.workTree, "x.txt"), "x");
  fs.writeFileSync(path.join(s.workTree, "y.txt"), "y");
  await assert.rejects(w.finish("too many"), /2 files changed, at most 1/);
  s = step();
  w = await Workspace.open(repoOf(bare, { max_bytes: 10 }), { name: "app" }, { ...s, defaultBranch: "agent/r3-s2" });
  fs.writeFileSync(path.join(s.workTree, "big.txt"), "0123456789abcdef");
  await assert.rejects(w.finish("too big"), /bytes changed, at most 10/);
  // A hard link could bring in a file only the server reads.
  s = step();
  w = await Workspace.open(repoOf(bare), { name: "app" }, { ...s, defaultBranch: "agent/r3-s3" });
  const secret = path.join(s.root, "secret");
  fs.writeFileSync(secret, "token", { mode: 0o600 });
  fs.linkSync(secret, path.join(s.workTree, "leak.txt"));
  await assert.rejects(w.finish("leak"), /hard link/);
  assert.throws(() => git(bare, "rev-parse", "--verify", "--quiet", "agent/r3-s3"));
});

test("push: false commits and keeps the branch here", async () => {
  const bare = origin();
  const s = step();
  const w = await Workspace.open(repoOf(bare), { name: "app", push: false }, { ...s, defaultBranch: "agent/r4-s1" });
  fs.writeFileSync(path.join(s.workTree, "c.txt"), "c\n");
  const out = await w.finish("local");
  assert.equal(out.pushed, false);
  assert.ok(out.commit);
  assert.throws(() => git(bare, "rev-parse", "--verify", "--quiet", "agent/r4-s1"));
});

test("pull request on Gitea, with the plugin's token", async () => {
  const bare = origin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-"));
  const tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, "gitea-test-token\n", { mode: 0o600 });
  const seen: { url?: string; auth?: string; body?: any } = {};
  const api = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.url = req.url;
      seen.auth = req.headers.authorization;
      seen.body = JSON.parse(b);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ number: 7, html_url: "https://git.example.com/team/app/pulls/7" }));
    });
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  try {
    const port = (api.address() as { port: number }).port;
    const repo = repoOf(bare, { pr: { kind: "gitea", api: `http://127.0.0.1:${port}/api/v1`, repo: "team/app", token_file: tokenFile } });
    const s = step();
    const w = await Workspace.open(repo, { name: "app", pr: { title: "Add d" } }, { ...s, defaultBranch: "agent/r5-s1" });
    fs.writeFileSync(path.join(s.workTree, "d.txt"), "d\n");
    const out = await w.finish("agent r5: add d\n\nreport");
    assert.equal(out.pr_url, "https://git.example.com/team/app/pulls/7");
    assert.equal(seen.url, "/api/v1/repos/team/app/pulls");
    assert.equal(seen.auth, "token gitea-test-token");
    assert.deepEqual(seen.body, { head: "agent/r5-s1", base: "main", title: "Add d", body: "agent r5: add d\n\nreport" });
  } finally {
    api.close();
  }
});

test("checkout: a branch, a tag or a commit, detached; nothing is committed", async () => {
  const bare = origin();
  // A branch and a tag beyond main.
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), "seed2-"));
  git(seed, "clone", "--quiet", bare, "w");
  const w = path.join(seed, "w");
  git(w, "checkout", "--quiet", "-b", "agent/r9-s1");
  fs.writeFileSync(path.join(w, "branch.txt"), "on the branch\n");
  git(w, "add", ".");
  git(w, "commit", "--quiet", "-m", "branch");
  git(w, "tag", "v1");
  git(w, "push", "--quiet", "origin", "agent/r9-s1", "v1");
  const branchSha = git(w, "rev-parse", "HEAD").trim();
  const mainSha = git(bare, "rev-parse", "main").trim();
  const repo = repoOf(bare);
  for (const [ref, sha, has] of [["agent/r9-s1", branchSha, true], ["v1", branchSha, true], [mainSha, mainSha, false], [undefined, mainSha, false]] as const) {
    const s = step();
    const ws = await Workspace.checkout(repo, ref, s);
    assert.equal(await ws.head(), sha, String(ref));
    assert.equal(fs.existsSync(path.join(s.workTree, "branch.txt")), has, String(ref));
    assert.equal(fs.statSync(path.join(s.workTree, "a.txt")).mode & 0o777, 0o666);
    assert.equal(fs.statSync(ws.gitDir).mode & 0o022, 0);
    fs.appendFileSync(path.join(s.workTree, "a.txt"), "changed\n");
    await assert.rejects(ws.finish("no"), /is a checkout/);
  }
  await assert.rejects(Workspace.checkout(repo, "nope", step()), /no branch, tag or commit nope/);
  await assert.rejects(Workspace.checkout(repo, "--upload-pack=x", step()), /not a branch, a tag or a commit/);
});

test("ssh: one key, the host keys pinned, nothing of a file or an agent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-"));
  const known = knownHostsFile(dir, "host.example ssh-ed25519 AAAA");
  assert.equal(fs.readFileSync(known, "utf8"), "host.example ssh-ed25519 AAAA\n");
  assert.equal(fs.statSync(known).mode & 0o777, 0o600);
  const opts = sshOptions("/keys/k", known);
  for (const o of ["-F", "/dev/null", "IdentitiesOnly=yes", "IdentityAgent=none", "StrictHostKeyChecking=yes", "GlobalKnownHostsFile=/dev/null", "BatchMode=yes"]) assert.ok(opts.includes(o), o);
  assert.match(sshCommand("/keys/it's", known), /^ssh -F '\/dev\/null' -i '\/keys\/it'\\''s' /);
});
