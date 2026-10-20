// Signals to a step's processes. Without a slot's user the server signals
// the group itself, which these tests check as any user. The slot's user's
// path (a shell as that user sends the signal) needs root with CAP_SETUID
// and CAP_SETGID: the last test runs only as root, where it checks how the
// signal is sent, but root there holds CAP_KILL as well. That root without
// CAP_KILL stops a slot's agent all the same, the separation tests of the
// plugins check (claude/, pi/, exec/scripts/separation-test.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { killUser, signalGroup } from "../signal.ts";

// group starts a shell in a group of its own, with a sleep in the
// background: the leader's pid, the sleep's, and the leader's end (the
// signal that ended it, or "running" after 5 s, the group then killed).
async function group(user?: { uid: number; gid: number }): Promise<{ child: ChildProcess; bg: number; ended: () => Promise<string | null> }> {
  const child = spawn("/bin/sh", ["-c", "sleep 30 & echo $!; wait"], { detached: true, stdio: ["ignore", "pipe", "ignore"], cwd: "/", ...(user ?? {}) });
  const exit = new Promise<string | null>((ok) => child.on("exit", (_code, sig) => ok(sig)));
  const bg = await new Promise<number>((ok, ko) => {
    child.stdout!.once("data", (b: Buffer) => ok(Number(b.toString().trim())));
    child.once("error", ko);
  });
  const ended = async () => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<string>((ok) => (timer = setTimeout(() => ok("running"), 5000)));
    const sig = await Promise.race([exit, late]);
    clearTimeout(timer);
    if (sig === "running") process.kill(-child.pid!, "SIGKILL");
    return sig;
  };
  return { child, bg, ended };
}

// alive: the process runs (a zombie, which nobody reaped, does not).
function alive(pid: number): boolean {
  try {
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

test("signalGroup: the whole group, as the server", async () => {
  const g = await group();
  assert.ok(alive(g.bg));
  signalGroup(g.child.pid, "SIGTERM");
  assert.equal(await g.ended(), "SIGTERM");
  assert.ok(await gone(g.bg), "the background sleep of the group still runs");
});

test("signalGroup: no pid, or a group gone, is no error", async () => {
  signalGroup(undefined, "SIGKILL");
  signalGroup(0, "SIGKILL");
  const g = await group();
  signalGroup(g.child.pid, "SIGKILL");
  assert.equal(await g.ended(), "SIGKILL");
  assert.ok(await gone(g.bg));
  assert.doesNotThrow(() => signalGroup(g.child.pid, "SIGTERM"));
});

test("signalGroup and killUser as a slot's user", { skip: process.getuid?.() !== 0 && "needs root" }, async () => {
  const user = { uid: 10099, gid: 10099 };
  const g = await group(user);
  signalGroup(g.child.pid, "SIGTERM", user);
  assert.equal(await g.ended(), "SIGTERM");
  assert.ok(await gone(g.bg));
  // A process of the user's in a group of its own: killUser stops it.
  const other = await group(user);
  killUser(user);
  assert.equal(await other.ended(), "SIGKILL");
  assert.ok(await gone(other.bg));
  // A group gone, a user with no process: no error.
  assert.doesNotThrow(() => signalGroup(g.child.pid, "SIGTERM", user));
  assert.doesNotThrow(() => killUser(user));
});
