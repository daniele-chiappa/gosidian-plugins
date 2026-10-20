// Signals from the plugin's server to the processes of a step. The server
// runs as root with CAP_SETUID and CAP_SETGID only: without CAP_KILL,
// kill(2) to a process of another user fails with EPERM, and the step's
// agent, which runs as the user of the step's slot, would run on. The
// signal is sent instead by a shell the server starts as the slot's user,
// whose kill reaches that user's processes.
import { spawnSync } from "node:child_process";

export interface SlotUser {
  uid: number;
  gid: number;
}

// The shell's kill: a minimal environment, no stdio, a few seconds at most.
const AS_USER = { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore", timeout: 5000 } as const;

// signalGroup sends sig to the process group pid leads (a child spawned
// with detached: true). With the slot's user, as that user; without one
// (the server is not root, as in the tests), from the server itself. It
// never throws: a group already gone is no error. It is synchronous, so a
// timer or an event handler may call it as it is.
export function signalGroup(pid: number | undefined, sig: NodeJS.Signals, user?: SlotUser): void {
  if (!pid) return;
  if (user) {
    try {
      spawnSync("/bin/sh", ["-c", 'kill -s "$0" "-$1" 2>/dev/null; true', sig.replace(/^SIG/, ""), String(pid)], { ...user, ...AS_USER });
    } catch {
      // no shell to start: nothing more to try
    }
    return;
  }
  try {
    process.kill(-pid, sig);
  } catch {
    // gone already
  }
}

// killUser stops every process of a slot's user (kill -9 -1 as that
// user), of any group or session: what a step's tools left behind. It never
// throws.
export function killUser(user: SlotUser): void {
  try {
    spawnSync("/bin/sh", ["-c", "kill -9 -1 2>/dev/null; true"], { ...user, ...AS_USER });
  } catch {
    // no shell to start: nothing more to try
  }
}
