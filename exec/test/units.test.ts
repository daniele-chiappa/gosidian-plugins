// The pieces without a run: the preset, the manifest, the node's settings,
// the end of an output, the limits, the commands of a host.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parsePreset, envError } from "../src/preset.ts";
import { hardLimits, projectOf, settingsOf, ulimits } from "../src/run.ts";
import { manifest } from "../src/server.ts";
import { checkNames, cleanupCommand, envFile, fetchCommand, prepCommand, runCommand, sshArgs } from "../src/remote.ts";
import { endOf, lastLines, Tail } from "../src/step.ts";
import { preset, tmp } from "./helpers.ts";

const HOST = `
hosts:
  - name: web1
    host: web1.example.com
    user: deploy
    key_file: /run/secrets/web1
    known_hosts: "web1.example.com ssh-ed25519 AAAA"
`;

test("preset: the defaults", () => {
  const p = parsePreset("name: exec");
  assert.equal(p.shell, "bash");
  assert.equal(p.cache, "none");
  assert.equal(p.cache_dir, "/var/cache/gosidian-exec");
  assert.deepEqual(p.limits.default, { timeout: 600, output_limit: 65536, processes: 512, file_size: 2048 });
  assert.deepEqual(p.limits.max, { timeout: 1800, output_limit: 4 << 20, processes: 512, file_size: 2048, cpu_seconds: 1800 });
  assert.deepEqual(p.env, {});
  assert.deepEqual(p.network, []);
  assert.deepEqual(p.hosts, []);
  assert.deepEqual(p.repos, []);
  const h = parsePreset(`name: exec\n${HOST}`).hosts[0];
  assert.deepEqual(h, {
    name: "web1", host: "web1.example.com", port: 22, user: "deploy", key_file: "/run/secrets/web1",
    known_hosts: "web1.example.com ssh-ed25519 AAAA\n", workdir: "/tmp/gosidian-exec", shell: "sh", env: {},
  });
});

test("preset: durations, limits, variables, a known hosts' file", () => {
  const dir = tmp("exec-preset-");
  const known = path.join(dir, "known_hosts");
  fs.writeFileSync(known, "[box]:2222 ssh-ed25519 BBBB\n");
  const p = parsePreset(`
name: exec
shell: sh
limits:
  default: {timeout: 2m, output_limit: 1000, processes: 256, file_size: 100, cpu_seconds: 90s}
  max: {timeout: 1h, processes: 2048}
env: {GOPROXY: https://proxy.golang.org, CGO_ENABLED: 0, npm_config_registry: https://registry.example}
network: [registry.npmjs.org, proxy.golang.org]
cache: project
cache_dir: /cache/
hosts:
  - {name: box, host: box, port: 2222, user: ops, key_file: /k, known_hosts_file: ${known}, workdir: /srv/steps/, shell: bash, env: {A: 1}}
`);
  assert.equal(p.shell, "sh");
  assert.deepEqual(p.limits.default, { timeout: 120, output_limit: 1000, processes: 256, file_size: 100, cpu_seconds: 90 });
  assert.deepEqual(p.limits.max, { timeout: 3600, output_limit: 4 << 20, processes: 2048, file_size: 100, cpu_seconds: 3600 });
  assert.deepEqual(p.env, { GOPROXY: "https://proxy.golang.org", CGO_ENABLED: "0", npm_config_registry: "https://registry.example" });
  assert.equal(p.cache, "project");
  assert.equal(p.cache_dir, "/cache");
  assert.equal(p.hosts[0].known_hosts, "[box]:2222 ssh-ed25519 BBBB\n");
  assert.equal(p.hosts[0].workdir, "/srv/steps");
  assert.deepEqual(p.hosts[0].env, { A: "1" });
  fs.rmSync(dir, { recursive: true });
});

test("preset: what it refuses", () => {
  const bad = (extra: string, re: RegExp) => assert.throws(() => parsePreset(`name: exec\n${extra}`), re);
  bad("limits: {default: {timeout: 40m}, max: {timeout: 30m}}", /limits.default.timeout 2400 is over limits.max.timeout 1800/);
  assert.equal(parsePreset("name: exec\nlimits: {default: {timeout: 40m}}").limits.max.timeout, 2400);
  bad("limits: {default: {processes: 1024}, max: {processes: 600}}", /limits.default.processes 1024 is over limits.max.processes 600/);
  bad("limits: {default: {timeout: soon}}", /is not a duration/);
  bad("limits: {default: {processes: 4}}", /must be >= 16/);
  bad("shell: '-c'", /must match pattern/);
  bad("env: {HOME: /x}", /env.HOME: the plugin sets it/);
  bad("env: {BASH_ENV: /x}", /env.BASH_ENV: the plugin sets it/);
  bad("env: {'A-B': x}", /property name must be valid/);
  bad("cache: always", /must be equal to one of the allowed values/);
  bad("unknown: 1", /must NOT have additional properties/);
  bad("hosts: [{name: local, host: h, user: u, key_file: /k, known_hosts: k}]", /local is the plugin's own sandbox/);
  bad("hosts: [{name: Web, host: h, user: u, key_file: /k, known_hosts: k}]", /must match pattern/);
  bad("hosts: [{name: a, host: h, user: u, key_file: /k}]", /needs its host keys/);
  bad("hosts: [{name: a, host: h, user: u, key_file: /k, known_hosts: k, known_hosts_file: /f}]", /not both/);
  bad("hosts: [{name: a, host: h, user: u, known_hosts: k}]", /must have required property 'key_file'/);
  bad("hosts: [{name: a, host: -oProxyCommand=x, user: u, key_file: /k, known_hosts: k}]", /must match pattern/);
  bad("hosts: [{name: a, host: h, user: -x, key_file: /k, known_hosts: k}]", /must match pattern/);
  bad("hosts: [{name: a, host: h, user: u, key_file: /k, known_hosts: k, workdir: rel}]", /must match pattern/);
  bad("hosts: [{name: a, host: h, user: u, key_file: /k, known_hosts: k}, {name: a, host: g, user: u, key_file: /k, known_hosts: k}]", /hosts a twice/);
  bad("repos: [{name: app, url: 'git@h:app.git'}]", /deploy key/);
});

test("the manifest: command-run/1, the targets, the repositories, the network", () => {
  const p = preset(`network: [registry.npmjs.org]
repos:
  - {name: app, url: "git@git.example.com:team/app.git", key_file: /k, known_hosts: "git.example.com ssh-ed25519 AAAA"}
hosts:
  - {name: web1, host: web1.example.com, port: 2222, user: deploy, key_file: /k, known_hosts: k}
  - {name: v6, host: "fd00::5", user: deploy, key_file: /k, known_hosts: k}
`);
  const m: any = manifest(p);
  assert.equal(m.name, "exec-test");
  assert.equal(m.gosidian, 1);
  const n = m.nodes[0];
  assert.equal(n.name, "run");
  assert.equal(n.tool, "run");
  assert.equal(n.contract, "command-run/1");
  assert.deepEqual(n.files, ["files"]);
  assert.equal(n.file_refs, true);
  assert.deepEqual(m.permissions, { files: true, network: ["gosidian", "web1.example.com:2222", "[fd00::5]:22", "git.example.com", "registry.npmjs.org"] });
  const props = n.input_schema.properties;
  assert.deepEqual(props.target.enum, ["local", "web1", "v6"]);
  assert.equal(props.target.default, "local");
  assert.deepEqual(props.repo.properties.name.enum, ["app"]);
  assert.equal(props.timeout.maximum, 120);
  assert.equal(props.timeout.default, 60);
  assert.equal(props.output_limit.maximum, 4 << 20);
  assert.equal(props.fail_on_error.default, true);
  assert.deepEqual(n.input_schema.oneOf, [{ required: ["script"] }, { required: ["command"] }]);
  assert.ok(n.output_schema.properties.exit_code);
  assert.equal((manifest(preset()) as any).nodes[0].input_schema.properties.repo, undefined);
});

test("settings: the defaults, script or command, the targets, the variables", () => {
  const p = preset(`repos:
  - {name: app, url: /srv/app.git}
hosts:
  - {name: web1, host: web1, user: deploy, key_file: /k, known_hosts: k}
`);
  const s = settingsOf(p, { script: "echo hi" });
  assert.deepEqual(s, { script: "echo hi", target: "local", env: {}, timeout: 60, output_limit: 65536, processes: 512, file_size: 2048, cpu_seconds: 60, fail_on_error: true });
  assert.equal(settingsOf(p, { command: ["ls"], timeout: 100 }).cpu_seconds, 100);
  assert.equal(settingsOf(p, { command: ["ls"], target: "web1", repo: { name: "app", ref: "v1" } }).target, "web1");
  const bad = (args: Record<string, unknown>, re: RegExp, q = p) => assert.throws(() => settingsOf(q, args), re);
  bad({ script: "x", command: ["y"] }, /script or command, not both/);
  bad({}, /a script or a command/);
  bad({ script: "" }, /must NOT have fewer than 1 characters/);
  bad({ command: [] }, /must NOT have fewer than 1 items/);
  bad({ script: "x", target: "web2" }, /with.target web2: not local nor a host of the preset \(web1\)/);
  bad({ script: "x", target: "web1" }, /has none/, preset());
  bad({ script: "x", repo: { name: "app" } }, /the preset has no repositories/, preset());
  bad({ script: "x", repo: { name: "other" } }, /must be equal to one of the allowed values/);
  bad({ script: "x", timeout: 121 }, /must be <= 120/);
  bad({ script: "x", output_limit: (4 << 20) + 1 }, /must be <=/);
  bad({ script: "x", processes: 1025 }, /must be <= 1024/);
  bad({ script: "x", file_size: 4096 }, /must be <= 2048/);
  bad({ script: "x", fail_on_error: "no" }, /must be boolean/);
  bad({ script: "x", other: 1 }, /must NOT have additional properties/);
  for (const name of ["PATH", "HOME", "TMPDIR", "SHELL", "USER", "LOGNAME", "IFS", "ENV", "BASH_ENV", "LD_PRELOAD", "LD_LIBRARY_PATH", "GIT_DIR", "GIT_SSH_COMMAND", "NODE_OPTIONS", "PYTHONPATH", "PYTHONSTARTUP", "SHELLOPTS", "PS4"]) {
    bad({ script: "x", env: { [name]: "v" } }, /the plugin's/);
  }
  bad({ script: "x", env: { lower: "v" } }, /is not a variable's name/);
  bad({ script: "x", env: { "A-B": "v" } }, /is not a variable's name/);
  bad({ script: "x", env: { A: 1 } }, /must be string/);
  bad({ script: "x", env: { A: "x".repeat(8193) } }, /must NOT have more than 8192 characters/);
  bad({ script: "x", env: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`V${i}`, "x"])) }, /65 variables, at most 64/);
  assert.equal(envError("GOFLAGS"), "");
  assert.equal(envError("NPM_TOKEN"), "");
  // The preset's cpu_seconds, within its max.
  const q = parsePreset("name: q\nlimits: {default: {timeout: 60, cpu_seconds: 30}, max: {timeout: 120, cpu_seconds: 45}}");
  assert.equal(settingsOf(q, { script: "x", timeout: 100 }).cpu_seconds, 30);
  assert.equal(settingsOf(q, { script: "x", cpu_seconds: 40 }).cpu_seconds, 40);
  assert.throws(() => settingsOf(q, { script: "x", cpu_seconds: 46 }), /must be <= 45/);
});

test("the project's name as a folder's", () => {
  assert.equal(projectOf({ "gosidian/project": "Agenti" }), "agenti");
  assert.equal(projectOf({ "gosidian/project": "a/../b c" }), "a-..-b-c");
  assert.equal(projectOf({ "gosidian/project": "../.." }), undefined);
  assert.equal(projectOf({ "gosidian/project": "" }), undefined);
  assert.equal(projectOf({}), undefined);
  assert.equal(projectOf(undefined), undefined);
});

test("the end of an output: its last bytes, a character never cut in two", () => {
  const t = new Tail(5);
  for (let i = 0; i < 10000; i++) t.push(Buffer.from(`line ${i}\n`));
  assert.equal(t.text(), "9999\n");
  assert.equal(t.truncated, true);
  const u = new Tail(100);
  u.push(Buffer.from("short"));
  assert.equal(u.text(), "short");
  assert.equal(u.truncated, false);
  // "è" is two bytes: the cut leaves its second, which goes.
  assert.equal(endOf(Buffer.from("aèbc"), 3), "bc");
  assert.equal(endOf(Buffer.from("aèbc"), 4), "èbc");
  const z = new Tail(0);
  z.push(Buffer.from("x"));
  assert.equal(z.text(), "");
  assert.equal(z.truncated, true);
  assert.equal(lastLines("a\n\nb\nc\n", 2), "b | c");
});

test("the limits: within the server's hard limits", () => {
  const text = [
    "Limit                     Soft Limit           Hard Limit           Units",
    "Max cpu time              unlimited            unlimited            seconds",
    "Max file size             unlimited            1048576              bytes",
    "Max processes             100                  200                  processes",
  ].join("\n");
  assert.deepEqual(hardLimits(text), { processes: 200, fileSize: 1048576, cpu: Infinity });
  const s = settingsOf(preset(), { script: "x" });
  assert.deepEqual(ulimits(s, hardLimits(text)), { processes: 200, fileKiB: 1024, cpu: 60 });
  assert.deepEqual(ulimits(s, hardLimits("")), { processes: 512, fileKiB: 2048 * 1024, cpu: 60 });
});

test("the commands of a host: quoted, the members it gives back checked", () => {
  const p = preset(`hosts:
  - {name: web1, host: web1.example.com, port: 2222, user: deploy, key_file: /run/k, known_hosts: k, workdir: "/srv/it's", env: {A: "x y"}}
`);
  const h = p.hosts[0];
  const args = sshArgs(h, "/step/private/known_hosts", "true");
  assert.deepEqual(args.slice(-4), ["2222", "--", "deploy@web1.example.com", "true"]);
  for (const o of ["StrictHostKeyChecking=yes", "UserKnownHostsFile=/step/private/known_hosts", "BatchMode=yes", "IdentitiesOnly=yes"]) assert.ok(args.includes(o), o);
  assert.ok(args.includes("-F") && args.includes("/run/k"));
  assert.match(prepCommand(h, "ab12"), /w='\/srv\/it'\\''s'/);
  const s = settingsOf(p, { command: ["printf", "%s", "it's $HOME"], target: "web1", env: { B: "$(id)" } });
  const run = runCommand(h, s, "ab12", "/srv/x/step-ab12", true);
  assert.match(run, /timeout -s KILL 60 'printf' '%s' 'it'\\''s \$HOME'/);
  assert.match(run, /export GOSIDIAN_EXEC_STEP=ab12/);
  assert.doesNotMatch(runCommand(h, s, "ab12", "/d", false), /timeout/);
  assert.match(runCommand(h, settingsOf(p, { script: "x", target: "web1" }), "ab12", "/d", false), /\{ 'sh' '-e' '\.\/script\.sh'; \}/);
  assert.equal(envFile(h, s), "export A='x y'\nexport B='$(id)'\n");
  assert.match(fetchCommand("ab12", "/d", 100, 1024), /tail -c 101/);
  assert.match(cleanupCommand("ab12", "/srv/x/step-ab12"), /rm -rf -- "\$d"/);
  checkNames([".exit", ".stdout.tail", ".stderr.tail", ".out-skipped", "out/", "out/a/b.txt", "./out/c"]);
  assert.throws(() => checkNames(["/etc/passwd"]), /not a file of the step/);
  assert.throws(() => checkNames(["out/../../x"]), /not a file of the step/);
  assert.throws(() => checkNames(["script.sh"]), /not a file of out/);
  assert.throws(() => checkNames(["outside"]), /not a file of out/);
});

test("the example preset parses", () => {
  const p = parsePreset(fs.readFileSync(new URL("../presets/exec.yaml", import.meta.url), "utf8"), "presets/exec.yaml");
  assert.equal(p.name, "exec");
  assert.deepEqual(p.hosts.map((h) => h.name), ["lab"]);
  assert.deepEqual(p.repos.map((r) => r.name), ["sandbox"]);
  assert.equal(p.cache, "project");
  assert.equal(p.limits.max.processes, 2048);
});
