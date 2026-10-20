// ssh from the plugin's server to a host of its preset: one key of the
// plugin's, the host's keys pinned, no agent, no configuration of a file,
// no prompt. The repositories over SSH (git.ts) and the hosts a command
// runs on (exec) go through it. The key is a file only the server reads;
// the known hosts, checked out of band, are written in a folder of its own.
import fs from "node:fs";
import path from "node:path";

export interface SSHKey {
  // key_file is the private key; known_hosts the host keys it accepts.
  key_file: string;
  known_hosts: string;
}

// knownHostsFile writes the pinned host keys in dir (a folder only the
// server reads) and gives the file's path.
export function knownHostsFile(dir: string, knownHosts: string): string {
  const file = path.join(dir, "known_hosts");
  fs.writeFileSync(file, knownHosts.endsWith("\n") ? knownHosts : knownHosts + "\n", { mode: 0o600 });
  return file;
}

// sshOptions are the options of every ssh of the server, with the key and
// the known hosts' file.
export function sshOptions(keyFile: string, knownFile: string): string[] {
  return [
    "-F", "/dev/null", "-i", keyFile,
    "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownFile}`, "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=20",
  ];
}

// shq quotes a word for a POSIX shell.
export function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// sshCommand is the same ssh as one line for a shell, as git's
// GIT_SSH_COMMAND takes it.
export function sshCommand(keyFile: string, knownFile: string): string {
  return ["ssh", ...sshOptions(keyFile, knownFile).map((o) => (o.startsWith("-") ? o : shq(o)))].join(" ");
}
