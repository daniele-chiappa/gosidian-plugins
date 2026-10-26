// The node pr against a fake Gitea: a step's pull request merged or closed,
// its branch deleted, never a protected one; a pull request of another
// repository, of a branch outside the prefix or of a fork refused, before
// anything changes; Gitea's refusals with their status.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { parseRepos, RepoError } from "../repos.ts";
import { prSchema, pullRequest } from "../pulls.ts";

interface FakePR {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  head: string;
  headRepo?: string;
}

const SHA = "c0ffee".padEnd(40, "0");

// fakeGitea answers the API of team/app's pull requests and branches as
// Gitea does, and keeps the requests it got; merge, when set, is its answer
// to a merge.
async function fakeGitea(prs: FakePR[]) {
  const seen: { method: string; url: string; auth?: string; body?: any }[] = [];
  const branches = new Set(prs.map((p) => p.head));
  const g = { merge: undefined as { status: number; body: unknown } | undefined };
  const json = (p: FakePR) => ({
    number: p.number,
    html_url: `https://git.example.com/team/app/pulls/${p.number}`,
    state: p.state,
    merged: p.merged,
    merge_commit_sha: p.merged ? SHA : null,
    head: { ref: p.head, repo: { full_name: p.headRepo ?? "team/app" } },
    base: { ref: "main", repo: { full_name: "team/app" } },
  });
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, ...(b ? { body: JSON.parse(b) } : {}) });
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      const m = /^\/api\/v1\/repos\/team\/app\/(?:pulls\/(\d+)(\/merge)?|branches\/(.+))$/.exec(req.url ?? "");
      if (m?.[3] && req.method === "DELETE") {
        const name = m[3].split("/").map(decodeURIComponent).join("/");
        return branches.delete(name) ? send(204) : send(404, { message: "branch not found" });
      }
      const pr = m?.[1] ? prs.find((p) => p.number === Number(m[1])) : undefined;
      if (!pr) return send(404, { message: "pull request not found" });
      if (req.method === "GET" && !m![2]) return send(200, json(pr));
      if (req.method === "POST" && m![2]) {
        if (g.merge) return send(g.merge.status, g.merge.body);
        pr.merged = true;
        pr.state = "closed";
        return send(200);
      }
      if (req.method === "PATCH" && !m![2]) {
        pr.state = "closed";
        return send(201, json(pr));
      }
      send(405, { message: "method not allowed" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  return Object.assign(g, { api, seen, branches, close: () => new Promise<void>((r) => server.close(() => r())) });
}

// reposOf: app, with pull requests on the fake Gitea; web, over SSH, without.
function reposOf(api: string, more: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulls-"));
  const token = path.join(dir, "token");
  fs.writeFileSync(token, "gitea-test-token\n", { mode: 0o600 });
  return parseRepos([
    { name: "app", url: "/srv/app.git", pr: { kind: "gitea", api, repo: "team/app", token_file: token }, ...more },
    { name: "web", url: "git@git.example.com:team/web.git", key_file: "/k", known_hosts: "git.example.com ssh-ed25519 AAAA" },
  ], "preset");
}

const calls = (g: { seen: { method: string; url: string }[] }) => g.seen.map((r) => `${r.method} ${r.url.replace("/api/v1/repos/team/app", "")}`);

test("prSchema: the repositories with pull requests, a number or a URL", () => {
  const s: any = prSchema(reposOf("https://git.example.com/api/v1"));
  assert.deepEqual(s.properties.repo.enum, ["app"]);
  assert.deepEqual(s.required, ["repo", "action"]);
  assert.deepEqual(s.anyOf, [{ required: ["number"] }, { required: ["url"] }]);
  assert.deepEqual(s.properties.style.enum, ["merge", "rebase", "squash"]);
  assert.equal(s.properties.delete_branch.default, true);
});

test("merge: by the run's pr_url, with the preset's token, then the branch goes; again, nothing more", async () => {
  const g = await fakeGitea([{ number: 7, state: "open", merged: false, head: "agent/r1-s1" }]);
  try {
    const repos = reposOf(g.api);
    const out = await pullRequest(repos, { repo: "app", url: "https://git.example.com/team/app/pulls/7", action: "merge", style: "squash", title: "Add d", message: "The agent's report" });
    assert.deepEqual(out, { repo: "app", number: 7, url: "https://git.example.com/team/app/pulls/7", action: "merge", branch: "agent/r1-s1", merged: true, closed: true, sha: SHA, branch_deleted: true });
    assert.deepEqual(calls(g), ["GET /pulls/7", "POST /pulls/7/merge", "GET /pulls/7", "DELETE /branches/agent/r1-s1"]);
    assert.deepEqual(g.seen[1].body, { Do: "squash", delete_branch_after_merge: false, MergeTitleField: "Add d", MergeMessageField: "The agent's report" });
    assert.ok(g.seen.every((r) => r.auth === "token gitea-test-token"));
    assert.equal(g.branches.size, 0);
    // A retry: merged already, the branch gone; no second merge.
    const again = await pullRequest(repos, { repo: "app", number: 7, action: "merge" });
    assert.equal(again.merged, true);
    assert.equal(again.sha, SHA);
    assert.equal(again.branch_deleted, true);
    assert.equal(again.note, "merged already; the branch agent/r1-s1 was gone already");
    assert.equal(g.seen.filter((r) => r.method === "POST").length, 1);
  } finally {
    await g.close();
  }
});

test("close: by number; delete_branch false keeps the branch, a protected one is never deleted", async () => {
  const g = await fakeGitea([
    { number: 3, state: "open", merged: false, head: "agent/r2-s1" },
    { number: 4, state: "open", merged: false, head: "agent/keep" },
  ]);
  try {
    const repos = reposOf(g.api, { protected: ["agent/keep"] });
    const out = await pullRequest(repos, { repo: "app", number: 3, action: "close", delete_branch: false });
    assert.deepEqual(out, { repo: "app", number: 3, url: "https://git.example.com/team/app/pulls/3", action: "close", branch: "agent/r2-s1", merged: false, closed: true, branch_deleted: false });
    assert.deepEqual(calls(g), ["GET /pulls/3", "PATCH /pulls/3", "GET /pulls/3"]);
    assert.deepEqual(g.seen[1].body, { state: "closed" });
    const kept = await pullRequest(repos, { repo: "app", url: "https://git.example.com/Team/App/pulls/4/", action: "close" });
    assert.equal(kept.closed, true);
    assert.equal(kept.branch_deleted, false);
    assert.equal(kept.note, "the branch agent/keep is protected: kept");
    assert.equal(g.seen.filter((r) => r.method === "DELETE").length, 0);
    assert.deepEqual([...g.branches].sort(), ["agent/keep", "agent/r2-s1"]);
  } finally {
    await g.close();
  }
});

test("only a step's pull request of the repository: another repository's, a branch outside the prefix, a fork's, a repository without pull requests", async () => {
  const g = await fakeGitea([
    { number: 5, state: "open", merged: false, head: "feature/x" },
    { number: 6, state: "open", merged: false, head: "agent/r3-s1", headRepo: "someone/app" },
  ]);
  try {
    const repos = reposOf(g.api);
    await assert.rejects(pullRequest(repos, { repo: "app", url: "https://git.example.com/team/other/pulls/5", action: "merge" }), /url https:\/\/git\.example\.com\/team\/other\/pulls\/5 is a pull request of team\/other, not of repository app \(team\/app\)/);
    await assert.rejects(pullRequest(repos, { repo: "app", url: "https://git.example.com/team/app/issues/5", action: "merge" }), /is not a pull request's URL/);
    await assert.rejects(pullRequest(repos, { repo: "app", url: "pulls/5", action: "merge" }), /is not a pull request's URL/);
    await assert.rejects(pullRequest(repos, { repo: "app", number: 6, url: "https://git.example.com/team/app/pulls/5", action: "merge" }), /number 6 and url .* are two pull requests/);
    await assert.rejects(pullRequest(repos, { repo: "app", action: "merge" }), /number or url/);
    await assert.rejects(pullRequest(repos, { repo: "web", number: 5, action: "merge" }), (e: Error) => e instanceof RepoError && e.message === "repository web has no pull requests in the preset");
    await assert.rejects(pullRequest(repos, { repo: "nope", number: 5, action: "merge" }), /the preset has no repository nope/);
    assert.equal(g.seen.length, 0, "nothing asked of Gitea");
    await assert.rejects(pullRequest(repos, { repo: "app", number: 5, action: "merge" }), /repository app: pull request #5: its branch "feature\/x" is not under agent\/: only a step's pull request/);
    await assert.rejects(pullRequest(repos, { repo: "app", number: 6, action: "close" }), /pull request #6: its branch is not in team\/app/);
    assert.deepEqual(calls(g), ["GET /pulls/5", "GET /pulls/6"], "nothing merged, closed or deleted");
  } finally {
    await g.close();
  }
});

test("Gitea's refusals fail with their status, and keep the branch", async () => {
  const g = await fakeGitea([
    { number: 9, state: "open", merged: false, head: "agent/r4-s1" },
    { number: 10, state: "closed", merged: false, head: "agent/r4-s2" },
  ]);
  try {
    const repos = reposOf(g.api);
    g.merge = { status: 409, body: { message: "merge conflict between agent/r4-s1 and main", url: "https://git.example.com/api/swagger" } };
    await assert.rejects(pullRequest(repos, { repo: "app", number: 9, action: "merge" }), (e: Error) => e instanceof RepoError && e.message === "repository app: pull request #9: the merge: 409 merge conflict between agent/r4-s1 and main");
    g.merge = { status: 405, body: { message: "Please try again later" } };
    await assert.rejects(pullRequest(repos, { repo: "app", number: 9, action: "merge", style: "rebase" }), /pull request #9: the merge: 405 Please try again later/);
    await assert.rejects(pullRequest(repos, { repo: "app", number: 10, action: "merge" }), /pull request #10 is closed: nothing to merge/);
    await assert.rejects(pullRequest(repos, { repo: "app", number: 99, action: "close" }), /pull request #99: 404 pull request not found/);
    assert.equal(g.seen.filter((r) => r.method === "DELETE").length, 0);
    assert.deepEqual([...g.branches].sort(), ["agent/r4-s1", "agent/r4-s2"]);
  } finally {
    await g.close();
  }
});
