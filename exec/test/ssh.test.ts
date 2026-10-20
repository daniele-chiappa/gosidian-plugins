// Steps on a host of the preset. A fake ssh (helpers.ts) runs the host's
// commands here, with sh, as the host's shell would: the files sent and
// brought back, the exit code, the timeout of the host's timeout(1) and of
// the server, what a step leaves running, the quoting, the pinned host
// keys, the step's folder removed. When sshd is at hand (scripts/test.sh
// adds it), one step goes through a real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { runStep, StepError } from "../src/run.ts";
import type { Env } from "../src/step.ts";
import { alive, fakeSSH, fileServer, never, origin, preset, removeAll, stepDirs, testEnv, tmp } from "./helpers.ts";

const out = (r: Awaited<ReturnType<typeof runStep>>) => r.output as Record<string, any>;
const fileText = (r: Awaited<ReturnType<typeof runStep>>, name: string) => r.files.find((f) => f.name === name)?.data.toString("utf8");

interface Hosts {
  env: Env;
  remote: string;
  ssh: ReturnType<typeof fakeSSH>;
}

// withHosts makes a preset of fake hosts, all here: box (port 2222, with
// timeout(1)), bare (without), wrongkey, down, and linked, whose workdir is
// a link.
async function withHosts(fn: (h: Hosts) => Promise<void>, extra = ""): Promise<void> {
  const dir = tmp("exec-hosts-");
  const remote = path.join(dir, "remote");
  const key = path.join(dir, "key");
  fs.writeFileSync(key, "not a key: the fake ssh does not read it\n", { mode: 0o600 });
  fs.mkdirSync(path.join(dir, "elsewhere"));
  fs.symlinkSync(path.join(dir, "elsewhere"), path.join(dir, "linked"));
  const ssh = fakeSSH(dir);
  const host = (name: string, host: string, more = "") =>
    `  - {name: ${name}, host: ${host}, user: deploy, key_file: ${key}, known_hosts: "${host} fake-host-key-ok", workdir: ${remote}${more}}\n`;
  const p = preset(`hosts:
${host("box", "box.example", ", port: 2222, env: {FROM_HOST: host, SHARED: host}")}${host("bare", "bare")}${host("down", "down")}${host("linked", "linked", "").replace(remote, path.join(dir, "linked"))}  - {name: wrongkey, host: box.example, user: deploy, key_file: ${key}, known_hosts: "box.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther", workdir: ${remote}}
${extra}`);
  const te = testEnv(p, { ssh: ssh.bin });
  try {
    await fn({ env: te.env, remote, ssh });
    assert.deepEqual(stepDirs(te.env), [], "the step's folder is removed here");
    const left = fs.existsSync(remote) ? fs.readdirSync(remote) : [];
    assert.deepEqual(left, [], "the step's folder is removed on the host");
  } finally {
    te.close();
    removeAll(dir);
  }
}

test("a script on a host: files in and out, the variables, the exit code; its folder removed", async () => {
  const files = await fileServer({ "dati.csv": "a,b\n1,2\n" });
  try {
    await withHosts(async ({ env, ssh }) => {
      const r = await runStep(env, {
        target: "box",
        script: "echo hi\necho warn >&2\ncat in/dati.csv > out/copia.csv\nmkdir out/d && echo y > out/d/z.txt\nln -s /etc/passwd out/link\npwd > out/where\necho \"$FROM_HOST $SHARED $FROM_NODE ${FROM_PRESET:-no-preset}\" > out/vars\n",
        files: files.refs(),
        env: { SHARED: "node", FROM_NODE: "node" },
      }, never);
      const o = out(r);
      assert.equal(r.error, undefined);
      assert.equal(o.exit_code, 0);
      assert.equal(o.signal, null);
      assert.equal(o.timed_out, false);
      assert.equal(o.stdout, "hi\n");
      assert.equal(o.stderr, "warn\n");
      assert.equal(o.target, "box");
      assert.deepEqual(r.files.map((f) => f.name).sort(), ["copia.csv", "d-z.txt", "vars", "where"]);
      assert.equal(fileText(r, "copia.csv"), "a,b\n1,2\n");
      // The host's variables, then the node's; not the preset's (local).
      assert.equal(fileText(r, "vars"), "host node node no-preset\n");
      assert.match(fileText(r, "where")!, /\/remote\/step-[0-9a-f]{16}\n$/);
      assert.deepEqual(o.skipped, [{ name: "link", error: "not a regular file" }]);
      // Four connections: the folder and the files, the run, the output, the cleanup.
      const calls = ssh.calls();
      assert.equal(calls.length, 4);
      for (const c of calls) {
        assert.deepEqual(c.slice(-4, -1), ["2222", "--", "deploy@box.example"]);
        assert.ok(c.includes("StrictHostKeyChecking=yes") && c.includes("BatchMode=yes") && c.includes("IdentitiesOnly=yes"));
        assert.ok(c.some((a) => /^UserKnownHostsFile=.*\/step-[0-9a-f]{16}\/private\/known_hosts$/.test(a)));
      }
    });
  } finally {
    await files.close();
  }
});

test("a host: fail_on_error, the end of the output, a command quoted", async () => {
  await withHosts(async ({ env }) => {
    const r = await runStep(env, { target: "box", script: "echo out\necho 'it broke' >&2\nexit 4\n", fail_on_error: false }, never);
    assert.equal(out(r).exit_code, 4);
    const f = await runStep(env, { target: "box", script: "echo 'it broke' >&2\nexit 4\n" }, never);
    assert.match(f.error!, /^on box: exit 4 after [\d.]+ s: it broke$/);
    const t = await runStep(env, { target: "box", script: "for i in $(seq 1 3000); do echo line $i; done", output_limit: 10 }, never);
    assert.equal(out(t).stdout, "line 3000\n");
    assert.equal(out(t).truncated, true);
    const c = await runStep(env, { target: "box", command: ["printf", "%s|", "$HOME", "a b", "*", "it's", "$(id)"] }, never);
    assert.equal(out(c).stdout, "$HOME|a b|*|it's|$(id)|");
  });
});

test("a host's timeout: timeout(1) there, else the server's; what it left running is stopped", async () => {
  await withHosts(async ({ env }) => {
    const t0 = Date.now();
    const r = await runStep(env, { target: "box", script: "sleep 300 >/dev/null 2>&1 &\necho $! > out/pid\necho started\nsleep 30\n", timeout: 1, fail_on_error: false }, never);
    const o = out(r);
    assert.equal(o.timed_out, true);
    assert.equal(o.exit_code, null);
    assert.equal(o.signal, "SIGKILL");
    assert.equal(o.stdout, "started\n");
    assert.ok(Date.now() - t0 < 8000, `${Date.now() - t0} ms`);
    const pid = Number(fileText(r, "pid"));
    assert.ok(pid > 0 && !alive(pid), "the background process is stopped");
    // A host without timeout(1): the server stops ssh, and the output's
    // fetch stops what runs.
    const t1 = Date.now();
    const b = await runStep(env, { target: "bare", script: "echo $$ > out/pid\necho started\nsleep 30\n", timeout: 1 }, never);
    assert.match(b.error!, /^on bare: timed out after 1 s \(timeout\): started$/);
    assert.ok(Date.now() - t1 < 8000, `${Date.now() - t1} ms`);
    const ok = await runStep(env, { target: "bare", script: "echo fine" }, never);
    assert.equal(out(ok).stdout, "fine\n");
  });
});

test("a host whose key is not the pinned one, or that cannot be reached, fails the node whatever fail_on_error says", async () => {
  await withHosts(async ({ env, remote }) => {
    await assert.rejects(runStep(env, { target: "wrongkey", script: "echo no", fail_on_error: false }, never), (e: Error) => e instanceof StepError && /^host wrongkey: its host key is not the one the preset pins \(known_hosts\): Host key verification failed\.$/.test(e.message));
    assert.equal(fs.existsSync(remote), false, "nothing was made on the host");
    await assert.rejects(runStep(env, { target: "down", script: "echo no", fail_on_error: false }, never), /host down: the step's folder could not be made \(ssh failed\): ssh: connect to host down port 22: Connection refused$/);
    await assert.rejects(runStep(env, { target: "nowhere", script: "echo no" }, never), /with.target nowhere: not local nor a host of the preset/);
  });
});

test("a host's workdir that is a link is refused", async () => {
  await withHosts(async ({ env }) => {
    await assert.rejects(runStep(env, { target: "linked", script: "echo no" }, never), /host linked: the step's folder could not be made \(exit 97\): gosidian-exec: .*linked is not a folder of .*'s/);
  });
});

test("a repository on a host: its files without .git", async () => {
  const o = origin();
  await withHosts(async ({ env }) => {
    const r = await runStep(env, { target: "box", script: "ls -a repo | tr '\\n' ' '\ncat repo/b.txt", repo: { name: "app", ref: "feature" } }, never);
    assert.equal(out(r).stdout, ". .. a.txt b.txt feature\n");
    assert.deepEqual(out(r).repo, { name: "app", ref: "feature", commit: o.feature });
  }, `repos:\n  - {name: app, url: ${o.url}}`);
  removeAll(path.dirname(o.url));
});

test("the call's cancellation on a host: the folder is still removed", async () => {
  await withHosts(async ({ env }) => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    await assert.rejects(runStep(env, { target: "box", script: "sleep 30" }, ac.signal), /canceled/);
  });
});

// sshd, when this machine has it and can run it: a step through the real
// ssh, as this user, with keys made here.
async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => ok(port));
    });
  });
}

test("a step through a real sshd", async (t) => {
  const sshd = ["/usr/sbin/sshd", "/usr/bin/sshd"].find((f) => fs.existsSync(f));
  if (!sshd) return t.skip("no sshd here");
  let hasSSH = true;
  try {
    execFileSync("sh", ["-c", "command -v ssh && command -v ssh-keygen"], { stdio: "ignore" });
  } catch {
    hasSSH = false;
  }
  if (!hasSSH) return t.skip("no ssh here");
  const dir = tmp("exec-sshd-");
  fs.chmodSync(dir, 0o755);
  let daemon: ChildProcess | undefined;
  try {
    const user = os.userInfo().username;
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, "host_key")]);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, "user_key")]);
    fs.copyFileSync(path.join(dir, "user_key.pub"), path.join(dir, "authorized_keys"));
    fs.chmodSync(path.join(dir, "authorized_keys"), 0o600);
    const port = await freePort();
    fs.writeFileSync(path.join(dir, "sshd_config"), [
      `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${dir}/host_key`, `AuthorizedKeysFile ${dir}/authorized_keys`,
      "PasswordAuthentication no", "KbdInteractiveAuthentication no", "PubkeyAuthentication yes", "PermitRootLogin prohibit-password",
      "StrictModes no", `PidFile ${dir}/sshd.pid`, ...(process.getuid?.() === 0 ? [] : ["UsePAM no"]),
    ].join("\n") + "\n");
    daemon = spawn(sshd, ["-D", "-e", "-f", path.join(dir, "sshd_config")], { stdio: ["ignore", "ignore", "pipe"] });
    let said = "";
    daemon.stderr!.on("data", (b: Buffer) => (said += b.toString()));
    let up = false;
    for (let i = 0; i < 50 && daemon.exitCode === null; i++) {
      up = await new Promise<boolean>((ok) => net.connect(port, "127.0.0.1").on("connect", function (this: net.Socket) {
        this.destroy();
        ok(true);
      }).on("error", () => ok(false)));
      if (up) break;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    if (!up) return t.skip(`sshd did not start here: ${said.trim().split("\n").slice(-2).join(" ")}`);
    const hostKey = fs.readFileSync(path.join(dir, "host_key.pub"), "utf8").split(" ").slice(0, 2).join(" ");
    const remote = path.join(dir, "remote");
    const host = (name: string, known: string) => `  - {name: ${name}, host: 127.0.0.1, port: ${port}, user: ${user}, key_file: ${dir}/user_key, known_hosts: "[127.0.0.1]:${port} ${known}", workdir: ${remote}}\n`;
    const te = testEnv(preset(`hosts:\n${host("real", hostKey)}${host("forged", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFake")}`));
    try {
      let r: Awaited<ReturnType<typeof runStep>>;
      try {
        r = await runStep(te.env, { target: "real", script: "echo over ssh\necho done > out/r.txt\nsleep 30", timeout: 2, fail_on_error: false }, never);
      } catch (e) {
        // A machine whose sshd takes no login of this user (a CI runner's).
        if (e instanceof StepError && /Permission denied|Connection (refused|closed)/.test(e.message)) return t.skip(`ssh could not log in here: ${e.message}`);
        throw e;
      }
      assert.equal(out(r).stdout, "over ssh\n");
      assert.equal(out(r).timed_out, true);
      assert.equal(fileText(r, "r.txt"), "done\n");
      const ok = await runStep(te.env, { target: "real", command: ["sh", "-c", "exit 6"], fail_on_error: false }, never);
      assert.equal(out(ok).exit_code, 6);
      await assert.rejects(runStep(te.env, { target: "forged", script: "echo no", fail_on_error: false }, never), /host forged: its host key is not the one the preset pins/);
      assert.deepEqual(fs.readdirSync(remote), []);
      assert.deepEqual(stepDirs(te.env), []);
    } finally {
      te.close();
    }
  } finally {
    daemon?.kill("SIGKILL");
    removeAll(dir);
  }
});
