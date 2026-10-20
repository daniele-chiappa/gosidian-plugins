// Steps in the sandbox, with real scripts: exit codes, fail_on_error, the
// end of the output, the timeout, the files in and out, a repository at a
// ref, the caches, the environment, the limits, the cleanup. As the
// server's user: the slots' users are the separation test's.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runStep, StepError, VERSION, STEP_PATH } from "../src/run.ts";
import type { Preset } from "../src/preset.ts";
import type { Env } from "../src/step.ts";
import { alive, fileServer, never, origin, preset, removeAll, stepDirs, testEnv, tmp } from "./helpers.ts";

async function withEnv(p: Preset, fn: (env: Env) => Promise<void>, more: Partial<Env> = {}): Promise<void> {
  const te = testEnv(p, more);
  try {
    await fn(te.env);
    assert.deepEqual(stepDirs(te.env), [], "the step's folder is removed");
  } finally {
    te.close();
  }
}

const out = (r: Awaited<ReturnType<typeof runStep>>) => r.output as Record<string, any>;
const fileText = (r: Awaited<ReturnType<typeof runStep>>, name: string) => r.files.find((f) => f.name === name)?.data.toString("utf8");

test("a script: its output, its exit code, the output's fields", async () => {
  await withEnv(preset(), async (env) => {
    const r = await runStep(env, { script: "echo hello\necho oops >&2\npwd > out/where.txt\n" }, never);
    const o = out(r);
    assert.equal(r.error, undefined);
    assert.equal(o.exit_code, 0);
    assert.equal(o.signal, null);
    assert.equal(o.timed_out, false);
    assert.equal(o.stdout, "hello\n");
    assert.equal(o.stderr, "oops\n");
    assert.equal(o.truncated, false);
    assert.equal(typeof o.seconds, "number");
    assert.equal(o.target, "local");
    assert.deepEqual(o.executor, { plugin: "gosidian-exec", version: VERSION, image: "" });
    assert.equal(o.repo, undefined);
    assert.match(fileText(r, "where.txt")!, /\/step-[0-9a-f]{16}\/work\n$/);
  });
});

test("fail_on_error: an exit code other than 0 fails the node, or is the pipeline's to read", async () => {
  await withEnv(preset(), async (env) => {
    const script = "echo working\necho 'go: build failed' >&2\nexit 3\n";
    const r = await runStep(env, { script, fail_on_error: false }, never);
    assert.equal(r.error, undefined);
    assert.equal(out(r).exit_code, 3);
    const f = await runStep(env, { script }, never);
    assert.match(f.error!, /^exit 3 after [\d.]+ s: go: build failed$/);
    // bash -e: an error stops the script.
    const e = await runStep(env, { script: "false\necho after\n", fail_on_error: false }, never);
    assert.equal(out(e).exit_code, 1);
    assert.equal(out(e).stdout, "");
  });
});

test("the end of the output, within output_limit", async () => {
  await withEnv(preset(), async (env) => {
    const r = await runStep(env, { script: "for i in $(seq 1 5000); do echo line $i; done; echo end >&2", output_limit: 20 }, never);
    const o = out(r);
    assert.equal(o.truncated, true);
    assert.equal(o.stdout, "line 4999\nline 5000\n");
    assert.ok(Buffer.byteLength(o.stdout) <= 20);
    assert.equal(o.stderr, "end\n");
    const none = await runStep(env, { script: "echo x", output_limit: 0 }, never);
    assert.equal(out(none).stdout, "");
    assert.equal(out(none).truncated, true);
  });
});

test("the timeout: SIGTERM to the group, SIGKILL 3 s later; a process left behind is stopped", async () => {
  await withEnv(preset(), async (env) => {
    const t0 = Date.now();
    const r = await runStep(env, { script: "echo started\nsleep 30\n", timeout: 1, fail_on_error: false }, never);
    const o = out(r);
    assert.equal(o.timed_out, true);
    assert.equal(o.exit_code, null);
    assert.equal(o.signal, "SIGTERM");
    assert.equal(o.stdout, "started\n");
    assert.ok(Date.now() - t0 < 5000);
    const k = await runStep(env, { script: "trap '' TERM\nsleep 30 & wait\nsleep 30\n", timeout: 1 }, never);
    assert.match(k.error!, /^timed out after 1 s \(timeout\)/);
    assert.ok(Date.now() - t0 < 10000);
    // A process in the background, its pipes elsewhere: gone with the step.
    const b = await runStep(env, { script: "sleep 300 >/dev/null 2>&1 &\necho $! > out/pid\n" }, never);
    const pid = Number(fileText(b, "pid"));
    assert.ok(pid > 0);
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(alive(pid), false, "the background process is stopped");
    // One that keeps the step's stdout: the step still ends.
    const t1 = Date.now();
    const h = await runStep(env, { script: "sleep 300 &\necho bye\n" }, never);
    assert.equal(out(h).stdout, "bye\n");
    assert.ok(Date.now() - t1 < 4000);
  });
});

test("the call's cancellation stops the script", async () => {
  await withEnv(preset(), async (env) => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    await assert.rejects(runStep(env, { script: "sleep 30" }, ac.signal), (e: Error) => e instanceof StepError && /canceled/.test(e.message));
  });
});

test("files in, files out: links and other files skipped", async () => {
  const files = await fileServer({ "dati.csv": "a,b\n1,2\n", "note.txt": "ciao" });
  try {
    await withEnv(preset(), async (env) => {
      const r = await runStep(env, {
        script: "ls in > out/list.txt\nwc -l < in/dati.csv | tr -d ' ' > out/righe.txt\nmkdir out/sub && echo x > out/sub/y.md\nln -s /etc/passwd out/link\nmkfifo out/fifo\n",
        files: files.refs(),
      }, never);
      assert.deepEqual(r.files.map((f) => f.name).sort(), ["list.txt", "righe.txt", "sub-y.md"]);
      assert.equal(fileText(r, "list.txt"), "dati.csv\nnote.txt\n");
      assert.equal(fileText(r, "righe.txt"), "2\n");
      assert.deepEqual(out(r).skipped.map((s: any) => s.name).sort(), ["fifo", "link"]);
      await assert.rejects(runStep(env, { script: "true", files: files.refs({ "note.txt": { sha256: "0".repeat(64) } }) }, never), /SHA-256 differs/);
      await assert.rejects(runStep(env, { script: "true", files: [{ name: "x" }] }, never), /by reference/);
    });
  } finally {
    await files.close();
  }
});

test("a command: its arguments as they are, no shell", async () => {
  await withEnv(preset(), async (env) => {
    const r = await runStep(env, { command: ["printf", "%s|", "$HOME", "a b", "*", "it's"] }, never);
    assert.equal(out(r).stdout, "$HOME|a b|*|it's|");
    const n = await runStep(env, { command: ["no-such-command-here"], fail_on_error: false }, never);
    assert.equal(out(n).exit_code, 127);
  });
});

test("the environment: the plugin's whitelist, then the preset's, then the node's", async () => {
  process.env.EXEC_TEST_SECRET = "s3cret";
  try {
    await withEnv(preset(), async (env) => {
      const r = await runStep(env, { script: "env", env: { SHARED: "node", FROM_NODE: "node" } }, never);
      const vars = Object.fromEntries(out(r).stdout.trim().split("\n").map((l: string) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
      for (const shell of ["PWD", "SHLVL", "_", "OLDPWD"]) delete vars[shell];
      assert.deepEqual(Object.keys(vars).sort(), [
        "CI", "FROM_NODE", "FROM_PRESET", "GOCACHE", "GOMODCACHE", "GOPATH", "HOME", "LANG", "PATH",
        "PIP_CACHE_DIR", "PIP_DISABLE_PIP_VERSION_CHECK", "SHARED", "TMPDIR", "npm_config_cache", "npm_config_update_notifier",
      ]);
      assert.equal(vars.PATH, STEP_PATH);
      assert.equal(vars.SHARED, "node");
      assert.equal(vars.FROM_PRESET, "preset");
      assert.equal(vars.CI, "true");
      assert.match(vars.HOME, /\/step-[0-9a-f]{16}\/home$/);
      assert.match(vars.TMPDIR, /\/step-[0-9a-f]{16}\/tmp$/);
      assert.match(vars.GOCACHE, /\/step-[0-9a-f]{16}\/cache\/go-build$/);
      assert.match(vars.GOPATH, /\/step-[0-9a-f]{16}\/home\/go$/);
    });
  } finally {
    delete process.env.EXEC_TEST_SECRET;
  }
});

test("the limits: ulimit -u, -f, -t, umask; a file beyond file_size stops", async () => {
  await withEnv(preset(), async (env) => {
    const r = await runStep(env, { script: "ulimit -u; ulimit -f; ulimit -t; ulimit -c; umask", processes: 300, file_size: 3, cpu_seconds: 7 }, never);
    assert.equal(out(r).stdout, "300\n3072\n7\n0\n0000\n");
    const d = await runStep(env, { script: "ulimit -t", timeout: 42 }, never);
    assert.equal(out(d).stdout, "42\n");
    const f = await runStep(env, { script: "head -c 3145728 /dev/zero > big || echo rc=$?\nwc -c < big | tr -d ' '\n", file_size: 1 }, never);
    assert.equal(out(f).stdout, "rc=153\n1048576\n");
    // The script cannot raise them.
    const u = await runStep(env, { script: "ulimit -f 4096 2>/dev/null && echo raised || echo kept", file_size: 1 }, never);
    assert.equal(out(u).stdout, "kept\n");
  });
});

test("the preset's shell runs the script", async () => {
  await withEnv(preset("shell: sh"), async (env) => {
    const r = await runStep(env, { script: 'echo "bash=${BASH_VERSION:-none}"' }, never);
    assert.equal(out(r).stdout, "bash=none\n");
  });
  await withEnv(preset(), async (env) => {
    const r = await runStep(env, { script: 'echo "bash=${BASH_VERSION:+yes}"' }, never);
    assert.equal(out(r).stdout, "bash=yes\n");
  });
});

test("a repository at a branch, a tag, a commit, or its base; nothing of its own runs", async () => {
  const o = origin();
  await withEnv(preset(`repos:\n  - {name: app, url: ${o.url}}`), async (env) => {
    const script = "cat repo/a.txt; cat repo/b.txt 2>/dev/null || true; git -C repo log --format=%s -1";
    const at = async (ref?: string) => out(await runStep(env, { script, repo: { name: "app", ...(ref ? { ref } : {}) } }, never));
    const f = await at("feature");
    assert.equal(f.stdout, "two\nfeature\nfeature\n");
    assert.deepEqual(f.repo, { name: "app", ref: "feature", commit: o.feature });
    const t = await at("v1");
    assert.equal(t.stdout, "one\none\n");
    assert.deepEqual(t.repo, { name: "app", ref: "v1", commit: o.v1 });
    const c = await at(o.v1);
    assert.equal(c.repo.commit, o.v1);
    const b = await at();
    assert.deepEqual(b.repo, { name: "app", ref: "main", commit: o.main });
    await assert.rejects(runStep(env, { script, repo: { name: "app", ref: "nope" } }, never), (e: Error) => e instanceof StepError && /no branch, tag or commit nope/.test(e.message));
  });
  removeAll(path.dirname(o.url));
});

test("cache: none keeps the step's; project keeps a project's, out of the others' reach", async () => {
  const cacheDir = tmp("exec-cache-");
  try {
    await withEnv(preset(`cache: project\ncache_dir: ${cacheDir}`), async (env) => {
      const script = 'cat "$GOCACHE/marker" 2>/dev/null || echo none\nmkdir -p "$GOCACHE" && echo "$MARK" > "$GOCACHE/marker"\nreadlink -f "$GOCACHE"';
      const step = (project: string | undefined, mark: string) =>
        runStep(env, { script, env: { MARK: mark } }, never, 0, project === undefined ? {} : { "gosidian/project": project });
      const a1 = out(await step("Demo X", "a1")).stdout.split("\n");
      assert.equal(a1[0], "none");
      const where = a1[1];
      assert.ok(where.startsWith(path.join(fs.realpathSync(cacheDir), "demo-x") + "/"), where);
      assert.match(path.basename(path.dirname(where)), /^[0-9a-f]{32}$/);
      const a2 = out(await step("Demo X", "a2")).stdout.split("\n");
      assert.equal(a2[0], "a1");
      assert.equal(a2[1], where);
      // Another project: another folder, whose name the first cannot know.
      const b = out(await step("other", "b")).stdout.split("\n");
      assert.equal(b[0], "none");
      assert.notEqual(path.dirname(b[1]), path.dirname(where));
      // No project: the step's own.
      const n = out(await step(undefined, "n")).stdout.split("\n");
      assert.equal(n[0], "none");
      assert.match(n[1], /\/step-[0-9a-f]{16}\/cache\/go-build$/);
      assert.equal(fs.statSync(cacheDir).mode & 0o777, 0o711);
      assert.equal(fs.statSync(path.join(cacheDir, "demo-x")).mode & 0o777, 0o711);
      assert.equal(fs.statSync(path.join(cacheDir, ".key")).mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(path.join(where, "marker"), "utf8"), "a2\n");
    });
  } finally {
    removeAll(cacheDir);
  }
});

test("the cleanup: read-only folders, a folder of mode 0700", async () => {
  await withEnv(preset(), async (env) => {
    const r = await runStep(env, {
      script: 'mkdir -p "$GOMODCACHE/m@v1/sub" && echo x > "$GOMODCACHE/m@v1/sub/f" && chmod -R a-w "$GOMODCACHE/m@v1"\nmkdir -m 700 "$HOME/.private" && touch "$HOME/.private/f"\nmkdir ro && chmod 555 ro\n',
    }, never);
    assert.equal(out(r).exit_code, 0);
  });
});
