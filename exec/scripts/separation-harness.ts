// The harness of separation-test.sh: a server of files by reference, and
// calls of run through MCP whose scripts look for what they must not reach
// (the server's environment, the plugin's token, a host's key, the cache's
// key, another slot's folder), leave processes behind, fork until the
// limit stops them, write a file beyond its size, build with the
// toolchains, check out a repository, and run on a host over SSH (files in
// and out, its timeout, a host key that is not the pinned one). It prints
// what the scripts saw and exits non-zero if something leaked.
import http from "node:http";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const plugin = process.env.PLUGIN_URL ?? "http://exec-plugin:8000";
const TOKEN = "t0k-separation";

// The files a step gets by reference, as gosidian hands them.
const files: Record<string, string> = { "dati.txt": "riga uno\nriga due\n" };
const fileServer = http.createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? "").replace(/^\/f\//, ""));
  if (!(name in files)) return void res.writeHead(404).end();
  res.writeHead(200).end(files[name]);
});
await new Promise<void>((ok) => fileServer.listen(9000, "0.0.0.0", ok));
const refs = Object.entries(files).map(([name, data]) => ({
  name, mime: "text/plain", size: Buffer.byteLength(data), sha256: crypto.createHash("sha256").update(data).digest("hex"), url: `http://exec-harness:9000/f/${encodeURIComponent(name)}`,
}));

for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${plugin}/health`)).ok) break;
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 500));
}
const c = new Client({ name: "separation-test", version: "0" });
await c.connect(new StreamableHTTPClientTransport(new URL(`${plugin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
const meta = { "gosidian/project": "sep", "gosidian/run": "sep-run-1" };
const call = async (args: Record<string, unknown>) => (await c.callTool({ name: "run", arguments: args, _meta: meta }, undefined, { timeout: 300_000 })) as any;
const lines = (r: any): string[] => String(r.structuredContent?.stdout ?? "").split("\n");
const fail: string[] = [];
const expect = (what: string, r: any, want: string[], refuse: RegExp) => {
  const got = lines(r);
  console.log(`--- ${what}\n${r.structuredContent?.stdout ?? ""}${r.structuredContent?.stderr ? `stderr: ${r.structuredContent.stderr}` : ""}${r.isError ? `error: ${r.content?.[0]?.text}\n` : ""}`);
  for (const w of want) if (!got.includes(w)) fail.push(`${what}: no ${w}`);
  for (const l of got) if (l && refuse.test(l)) fail.push(`${what}: ${l}`);
};

// 1. What a step must not reach; processes left behind, one of another
// session; a link in out/.
const leak = await call({
  script: [
    "echo uid=$(id -u)",
    "cat /proc/1/environ >/dev/null 2>&1 && echo ENVIRON-READABLE || echo environ-denied",
    "for p in /proc/[0-9]*; do [ \"$(stat -c %u $p)\" = 0 ] && cat $p/environ >/dev/null 2>&1 && echo ROOT-ENVIRON-READABLE; done; true",
    "echo token-in-env=${GOSIDIAN_PLUGIN_TOKEN:-none}",
    // The pattern does not match itself: the command's own line holds it.
    `grep -l '${TOKEN.slice(0, -1)}[${TOKEN.slice(-1)}]' /proc/[0-9]*/environ /proc/[0-9]*/cmdline 2>/dev/null | sed 's/^/TOKEN-FOUND-IN /'`,
    "cat /etc/gosidian-exec/box_key >/dev/null 2>&1 && echo KEY-READABLE || echo key-denied",
    "cat /var/cache/gosidian-exec/.key >/dev/null 2>&1 && echo CACHE-KEY-READABLE || echo cache-key-denied",
    "ls /var/cache/gosidian-exec >/dev/null 2>&1 && echo CACHE-LISTED || echo cache-unlisted",
    "ls /tmp/gosidian-exec >/dev/null 2>&1 && echo STEPS-LISTED || echo steps-unlisted",
    ": > in/new 2>/dev/null && echo IN-WRITABLE || echo in-read-only",
    "mv in in2 2>/dev/null && echo IN-MOVED || echo in-stays",
    "echo x > ../script.sh 2>/dev/null && echo SCRIPT-WRITABLE || echo script-read-only",
    "touch /app/x 2>/dev/null && echo APP-WRITABLE || echo app-read-only",
    "cat in/dati.txt | wc -l | sed 's/^ */in-lines=/'",
    "echo hi > out/ok.txt",
    "ln -s /etc/passwd out/link.txt",
    "nohup sleep 300 >/dev/null 2>&1 &",
    "setsid sleep 301 >/dev/null 2>&1 </dev/null &",
    "echo done",
  ].join("\n"),
  files: refs,
});
expect("separation", leak, ["environ-denied", "token-in-env=none", "key-denied", "cache-key-denied", "cache-unlisted", "steps-unlisted", "in-read-only", "in-stays", "script-read-only", "app-read-only", "in-lines=2", "done"], /READABLE|TOKEN-FOUND|LISTED|WRITABLE|MOVED/);
if (!/^uid=1010[1-8]$/.test(lines(leak)[0])) fail.push(`the step did not run as a slot's user: ${lines(leak)[0]}`);
const back = (leak.content ?? []).filter((x: any) => x.type === "resource").map((x: any) => decodeURIComponent(new URL(x.resource.uri).pathname));
if (back.join() !== "/ok.txt") fail.push(`the files given back: ${back.join()}`);
if (JSON.stringify(leak.structuredContent?.skipped) !== JSON.stringify([{ name: "link.txt", error: "not a regular file" }])) fail.push(`skipped: ${JSON.stringify(leak.structuredContent?.skipped)}`);

// 2. Two slots at once: the second finds the first's folder by its
// command line, and cannot enter it.
const [a, b] = await Promise.all([
  call({ script: "echo secret > ../home/secret\necho uid=$(id -u)\nsleep 5\n" }),
  call({
    script: [
      "sleep 1.5",
      "echo uid=$(id -u)",
      "mine=$(dirname \"$PWD\")",
      "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -oE '/tmp/gosidian-exec/step-[0-9a-f]{16}' | sort -u | grep -v \"$mine\" > \"$TMPDIR/others\" || true",
      "echo others=$(wc -l < \"$TMPDIR/others\")",
      "for d in $(cat \"$TMPDIR/others\"); do",
      "  ls \"$d\" >/dev/null 2>&1 && echo OTHER-LISTED",
      "  cat \"$d/home/secret\" >/dev/null 2>&1 && echo OTHER-READ",
      "  ls \"$d/work\" >/dev/null 2>&1 && echo OTHER-WORK-LISTED",
      "  touch \"$d/work/x\" 2>/dev/null && echo OTHER-WRITTEN",
      "done",
      "echo cross-done",
    ].join("\n"),
  }),
]);
expect("another slot", b, ["others=1", "cross-done"], /OTHER-/);
if (lines(a)[0] === lines(b)[0]) fail.push(`two slots, one user: ${lines(a)[0]}`);

// 3. A fork bomb stops at the slot's processes, and the server answers
// meanwhile; what it made is gone after the step.
const forks = await call({
  script: "python3 -c '\nimport os, time\nn = 0\ntry:\n    while n < 10000:\n        if os.fork() == 0:\n            time.sleep(60)\n            os._exit(0)\n        n += 1\nexcept OSError as e:\n    print(\"forks\", n, e.errno)\n'\n",
  processes: 64,
  timeout: 20,
});
const fl = lines(forks).find((l) => l.startsWith("forks ")) ?? "";
console.log(`--- forks: ${fl}`);
const n = Number(fl.split(" ")[1]);
if (!(n > 0 && n < 64 && fl.endsWith(" 11"))) fail.push(`the fork loop was not stopped by the limit: ${JSON.stringify(fl)}`);
let healthy = 0;
let sick = 0;
const bomb = call({ script: "b() { b | b & }\nb\nsleep 20\n", processes: 64, timeout: 5, fail_on_error: false });
const watch = (async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      if ((await fetch(`${plugin}/health`, { signal: AbortSignal.timeout(2000) })).ok) healthy++;
      else sick++;
    } catch {
      sick++;
    }
  }
})();
const bombed = await bomb;
await watch;
console.log(`--- fork bomb: ${JSON.stringify({ exit_code: bombed.structuredContent?.exit_code, signal: bombed.structuredContent?.signal, timed_out: bombed.structuredContent?.timed_out, seconds: bombed.structuredContent?.seconds })}, health ${healthy} ok, ${sick} not`);
if (bombed.isError || !bombed.structuredContent?.timed_out || !(bombed.structuredContent?.seconds < 9.5)) fail.push(`the fork bomb's step: ${JSON.stringify(bombed.structuredContent ?? bombed.content)}`);
if (sick) fail.push(`the server did not answer during the fork bomb (${sick} times)`);

// A script that ignores SIGTERM: SIGKILL 3 s later, sent as the slot's
// user (root without CAP_KILL could not).
const stubborn = await call({ script: "trap '' TERM\nsleep 60 & wait\nsleep 60\n", timeout: 2, fail_on_error: false });
console.log(`--- SIGTERM ignored: ${JSON.stringify({ signal: stubborn.structuredContent?.signal, timed_out: stubborn.structuredContent?.timed_out, seconds: stubborn.structuredContent?.seconds })}`);
if (stubborn.structuredContent?.signal !== "SIGKILL" || !stubborn.structuredContent?.timed_out || !(stubborn.structuredContent?.seconds < 7)) fail.push(`a script that ignores SIGTERM: ${JSON.stringify(stubborn.structuredContent ?? stubborn.content)}`);

// 4. A file beyond file_size stops.
const big = await call({ script: "head -c 3145728 /dev/zero > big || echo rc=$?\nwc -c < big | sed 's/^ */size=/'\n", file_size: 1 });
expect("file size", big, ["rc=153", "size=1048576"], /(?!)/);

// 5. The toolchains, as the slot's user, in a read-only container.
const tools = await call({
  script: [
    "go version | cut -d' ' -f3",
    "node --version | sed 's/^/node-/'",
    "python3 -c 'import sys; print(\"python\", sys.version_info[0])'",
    "git --version | cut -d' ' -f1",
    "mkdir hello && cd hello",
    "printf 'package main\\n\\nimport \"fmt\"\\n\\nfunc main() { fmt.Println(\"ciao\") }\\n' > main.go",
    "go mod init example.com/hello 2>/dev/null",
    "go build -o hello . && ./hello",
    "printf 'int main(void) { return 0; }\\n' > t.c && cc t.c -o t && ./t && echo cc-ok",
    "python3 -m venv \"$TMPDIR/v\" && \"$TMPDIR/v/bin/python\" -c 'print(\"venv-ok\")'",
    "readlink -f \"$GOCACHE\" | sed 's|/[0-9a-f]\\{32\\}/|/<mac>/|'",
  ].join("\n"),
});
expect("toolchains", tools, ["ciao", "cc-ok", "venv-ok", "git", "python 3", "/var/cache/gosidian-exec/sep/<mac>/go-build"], /(?!)/);
if (!lines(tools).some((l) => /^go1\.27/.test(l))) fail.push("toolchains: no go1.27");

// 6. A repository at a tag: the files the slot's user may edit, the git
// folder the server's.
const repo = await call({
  repo: { name: "app", ref: "v1" },
  script: [
    "cat repo/a.txt",
    "git -C repo log --format=%s -1",
    "gd=$(sed -n 's/^gitdir: //p' repo/.git)",
    "touch \"$gd/hooks/post-checkout\" 2>/dev/null && echo GITDIR-WRITABLE || echo gitdir-denied",
    "echo more >> repo/a.txt && echo repo-editable",
  ].join("\n"),
});
expect("repository", repo, ["one", "seed", "gitdir-denied", "repo-editable"], /WRITABLE/);
if (!/^[0-9a-f]{40}$/.test(repo.structuredContent?.repo?.commit ?? "")) fail.push(`repository: ${JSON.stringify(repo.structuredContent?.repo)}`);

// 7. A host over SSH: files in and out, its timeout, a key that is not
// the pinned one.
const ssh = await call({ target: "box", script: "echo on-host $(id -un)\nwc -l < in/dati.txt | sed 's/^ */in-lines=/'\ncp in/dati.txt out/copia.txt\nsleep 300 >/dev/null 2>&1 &\n", files: refs });
expect("host", ssh, ["on-host deploy", "in-lines=2"], /(?!)/);
const sshBack = (ssh.content ?? []).filter((x: any) => x.type === "resource").map((x: any) => Buffer.from(x.resource.blob, "base64").toString());
if (sshBack.join() !== files["dati.txt"]) fail.push(`host: the files given back: ${JSON.stringify(sshBack)}`);
const slow = await call({ target: "box", script: "echo started\nsleep 60\n", timeout: 2, fail_on_error: false });
console.log(`--- host timeout: ${JSON.stringify(slow.structuredContent ?? slow.content)}`);
if (!slow.structuredContent?.timed_out || slow.structuredContent?.signal !== "SIGKILL" || slow.structuredContent?.stdout !== "started\n") fail.push(`host timeout: ${JSON.stringify(slow.structuredContent ?? slow.content)}`);
const forged = await call({ target: "forged", script: "echo no", fail_on_error: false });
console.log(`--- forged host key: ${forged.content?.[0]?.text}`);
if (!forged.isError || !/its host key is not the one the preset pins/.test(forged.content?.[0]?.text ?? "")) fail.push(`a forged host key: ${JSON.stringify(forged.content)}`);
const far = await call({ target: "elsewhere", script: "echo no" });
if (!far.isError || !/not local nor a host of the preset/.test(far.content?.[0]?.text ?? "")) fail.push(`a host outside the preset: ${JSON.stringify(far.content)}`);

await c.close();
fileServer.close();
if (fail.length) {
  console.error("FAIL: " + fail.join("; "));
  process.exit(1);
}
console.log("ok: slots' users apart, no secrets in reach, limits held, toolchains, a repository, a host over SSH");
