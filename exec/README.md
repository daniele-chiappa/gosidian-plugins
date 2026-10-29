# gosidian-exec

A gosidian plugin whose node runs a script or a command and gives back
what it did: its exit code, the end of its output, the files it wrote. It
runs in the plugin's own sandbox, a container with the toolchains (git,
Node, Go, Python, a C compiler), as a user of its own and in a folder
thrown away after the step; or on a host of its preset, over SSH. A step
may get files of the project and a repository of the preset at a branch,
a tag or a commit.

Two jobs:

- **the gate**: before a pipeline takes an agent's "done", it runs the
  tests and the build of the branch the agent pushed, a deterministic
  step, and decides on the exit code (`when:`);
- **the operations on a server**: a command on a host of a closed list,
  after an approval the pipeline asks for.

The node keeps `command-run/1`, the contract of gosidian's command nodes
(gosidian's `docs/plugins.md`, "Command nodes"): another executor (a CI
runner, another host) keeps the same settings and output, so a pipeline or
the coordinator of a team of agents picks one without learning it.

**One container is one executor.** Its preset names the shell, the limits
of a step, the variables of every step, the hosts its scripts reach, the
repositories a step may check out, the hosts a step may run on and the
cache of the dependencies. Who wants other toolchains adds a preset with
an image of their own, on the same server.

## A step in the sandbox

1. gosidian calls `run` with the node's settings. Each file comes by
   reference (`file_refs`), with the run's project and id in the call's
   `_meta`.
2. The plugin makes the step's folder. With `repo`, it clones the
   repository at the ref into `repo/`, detached; the files are fetched into
   `in/`, checked against their size and SHA-256; `out/` is empty.
3. It runs the script with the preset's shell (`bash -e`, so an error
   stops it), or the command with no shell, in the folder, as the user of
   the slot, within the limits:
   - `timeout`: then SIGTERM to its processes, SIGKILL 3 seconds later;
   - `processes`, `file_size`, `cpu_seconds`: the `ulimit` of its
     processes (`-u`, `-f` in MiB, `-t`), which it cannot raise.
4. It keeps the end of stdout and of stderr (`output_limit` bytes each).
5. When the script ends, every process of the slot's user is stopped,
   those it left in the background too. The files of `out/` go back to
   gosidian, which stores them as attachments; the folder is removed.

```
step-<hex>/            root's, the slot's group: no other slot enters
  script.sh            the script (root's: the step cannot change it)
  home/  tmp/          HOME and TMPDIR
  cache/               the tools' caches: the step's, or a link to its project's
  work/                the working folder (sticky)
    in/                the files, read-only
    out/               what goes back
    repo/              the repository; its git folder is the server's
```

Its environment is a list of the plugin's and nothing of the server's:
`PATH` (Go, then `/usr/local/bin:/usr/bin:/bin`), `HOME`, `TMPDIR`,
`LANG=C.UTF-8`, `CI=true`, `GOPATH` (in home), `GOCACHE`, `GOMODCACHE`,
`npm_config_cache`, `PIP_CACHE_DIR` (in cache), then the preset's `env`,
then the node's.

## A step on a host

The server (root) runs `ssh` with the host's key, its pinned host keys and
no agent or configuration (agent-kit's `ssh.ts`), in four connections:

1. it makes `<workdir>/step-<hex>` (the workdir must be a folder of the
   host's user, not a link: `/tmp` is everyone's) and unpacks there a tar
   of `in/`, `repo/` (without its `.git`), the script and the variables;
2. it runs the script with the host's `shell -e` (or the command, its
   arguments quoted), its output in files, within `timeout` (the host's
   `timeout -s KILL` when it has one; else the server stops ssh at the
   timeout);
3. it stops what the step left running (the processes that carry the
   step's variable, on Linux), and brings back the end of the output and
   `out/` as a tar: its members are checked (nothing outside `out/`, no
   absolute paths, no `..`), unpacked without owners or modes, and links
   are skipped;
4. it removes the folder, whatever happened before.

The host needs a POSIX `sh` as the user's shell, `tar`, `tail` and `du`.
A host key that is not the pinned one, a host that cannot be reached, a
workdir that is not the user's fail the node whatever `fail_on_error`
says. A process that clears its environment, or any on a host without
Linux's `/proc`, may outlive the step: the host's limits are the host's.

## The node

`<plugin>.run`, for example `exec.run`. It keeps `command-run/1`, and adds
the sandbox's limits:

| Setting | Default | |
|---|---|---|
| `script` | | a script, run by the preset's shell (or the host's) with `-e` |
| `command` | | a command and its arguments, as a list, with no shell. One of `script` and `command` |
| `target` | `local` | `local`, the sandbox, or a host of the preset |
| `files` | | a vault path or a list of them (`{{ trigger.files }}`), in `in/` |
| `repo` | | a repository of the preset: `name`, `ref` (a branch, a tag or a commit; default its base), in `repo/`. Never committed |
| `env` | | variables, at most 64 of 8 KiB; not `PATH`, `HOME`, `TMPDIR`, `SHELL`, `USER`, `LOGNAME`, `IFS`, `ENV`, `BASH_ENV`, `SHELLOPTS`, `BASHOPTS`, `PS4`, `POSIXLY_CORRECT`, `NODE_OPTIONS`, nor `LD_*`, `GIT_*`, `PYTHON*` |
| `timeout` | the preset's | seconds, at most the preset's max |
| `output_limit` | the preset's | bytes of stdout and of stderr kept, their end |
| `fail_on_error` | true | an exit code other than 0, a signal or the timeout fails the node; `false` gives them, and the pipeline decides |
| `processes`, `file_size`, `cpu_seconds` | the preset's | in the sandbox: the `ulimit`s, at most the preset's max |

Output: `exit_code` (null after a signal or the timeout), `signal`,
`timed_out`, `stdout`, `stderr`, `truncated`, `seconds`, `repo` (`name`,
`ref`, `commit`: the commit it ran on), `target`, `executor` (`plugin`:
`gosidian-exec`, `version`, `image`), `skipped` (the files of `out/` not
given back, and why), and from gosidian `files`. A failed node's error is
the exit code (or the signal, or the timeout) and the last lines of
stderr. A target, a repository or a ref that is not there fails the node
whatever `fail_on_error` says.

The node's `timeout` (5 minutes by default, at most the server's step
timeout) must cover the step's, the clone and the files. Keep
`output_limit` under gosidian's `max_output_bytes` (1 MiB).

The gate: the tests of the branch an agent pushed, and the verdict on the
exit code (gosidian's expressions have no operators: a `starlark` node
computes it):

```yaml
- id: tests
  use: exec.run
  with:
    repo: {name: sandbox, ref: "{{ agent.repo.branch }}"}
    script: |
      cd repo
      npm ci
      npm test
    fail_on_error: false
    timeout: 900
  timeout: 16m

- id: verdict
  use: starlark
  with:
    input: "{{ tests }}"
    code: |
      output = {"passed": input["exit_code"] == 0, "failed": input["exit_code"] != 0}

- id: done
  use: note.write
  after: [verdict]
  when: "{{ verdict.passed }}"
  with: {path: "tasks/{{ run.id }}.md", body: "Tests passed on {{ tests.repo.commit }}."}

- id: review
  use: note.write
  after: [verdict]              # not after done: a node after a skipped one is skipped
  when: "{{ verdict.failed }}"
  with: {path: "tasks/{{ run.id }}.md", body: "Tests failed (exit {{ tests.exit_code }})."}
```

An operation on a host, after an approval (the pipeline's, not the
plugin's):

```yaml
- id: approve
  use: wait.call
  with: {timeout: 24h}

- id: restart
  use: exec.run
  with:
    target: lab
    command: [systemctl, --user, restart, app]
```

## The preset

`/etc/gosidian-exec/preset.yaml` (`EXEC_PRESET`). An example with every
field is [presets/exec.yaml](presets/exec.yaml).

```yaml
name: exec                       # the plugin's name in gosidian
description: Tests and builds of the agents' projects
shell: bash                      # a local script's shell, with -e
limits:
  default: {timeout: 10m, output_limit: 65536, processes: 512, file_size: 2048}
  max: {timeout: 30m, output_limit: 4194304}
env: {GOPROXY: "https://proxy.golang.org,direct", GOTOOLCHAIN: local}
network: [registry.npmjs.org, proxy.golang.org, sum.golang.org, pypi.org, files.pythonhosted.org]
cache: none                      # or project
repos:                           # agent-kit's repositories: read-only here
  - name: sandbox
    url: git@git.example.com:agents/sandbox.git
    key_file: /run/secrets/sandbox_deploy_key
    known_hosts: "git.example.com ssh-ed25519 AAAA…"
hosts:
  - name: lab                    # not local
    host: lab.example.com
    port: 22
    user: gosidian
    key_file: /run/secrets/lab_key
    known_hosts: "lab.example.com ssh-ed25519 AAAA…"   # or known_hosts_file
    workdir: /home/gosidian/steps    # default /tmp/gosidian-exec
    shell: sh
    env: {LANG: C.UTF-8}         # the host's steps' variables, before the node's
```

- **`limits`**: `default` is a step's, `max` what a node may ask.
  `timeout` is seconds or `90s`, `10m`, `1h` (default 10m, max 30m);
  `output_limit` bytes (64 KiB, max 4 MiB); `processes` the processes
  *and threads* of the step's user (512); `file_size` MiB (2048);
  `cpu_seconds` the CPU of each process, its threads together (default
  the step's timeout: a build on many cores may reach it first). A
  `ulimit` without a max in the preset may be lowered by a node, not
  raised.
- **`env`**: the variables of every local step, before the node's. The
  preset's `PATH` replaces the plugin's (an image with other toolchains);
  `HOME` and `TMPDIR` are the step's.
- **`network`**: the hosts the scripts reach (registries, proxies),
  declared in the manifest's `permissions.network` with gosidian, the
  hosts and the repositories' servers. The container's network enforces
  it, not the plugin.
- **`repos`**: the repositories a step may check out ([agent-kit](../agent-kit)):
  a deploy key (read-only is enough) and pinned host keys over SSH, the
  base branch. The server clones; the step never reads the key.
- **`hosts`**: the hosts a step may run on. The key file belongs to root
  (uid 0) with mode 600; a port other than 22 names the host as
  `[host]:port` in `known_hosts`.
- **`cache`**: `none` (the default): every step downloads its
  dependencies again. `project`: a folder of the project's in `cache_dir`
  (a volume) keeps Go's, npm's and pip's caches between its steps. Its
  name is a MAC of the project's, under a key only root reads, in folders
  a step cannot list: a step reaches its own project's cache and no other.
  **The risk**: a script may poison its project's cache (a module, a
  compiled package) for the project's next steps; not another project's.
  For the repositories the agents write, `none` keeps every step clean.

A change of the preset changes the manifest: `gosidian plugin show`, then
`gosidian plugin accept`.

## Security

**A script is arbitrary code.** Whoever may write the project's pipelines
writes it; gosidian runs the pipelines of a project for those who have the
project. And a gate runs the code of the repository, which is its point:
a repository an agent wrote may hold what the agent was steered to write.
The plugin keeps what matters out of reach:

- **The step runs as another user.** The server runs as root with only the
  `SETUID` and `SETGID` capabilities, `no-new-privileges`, a read-only
  root. It runs each step as the user of its slot (`exec1` to `exec8`, uid
  and group 10101 up), in a folder of root's that only that slot's group
  may enter: a step cannot read the server's environment (the plugin's
  token), the hosts' keys, the cache's key, nor another slot's folder,
  whatever it learns of its name. When the step ends, every process of
  that user is stopped.
- **No capabilities in the step**, and no way to raise its `ulimit`s.
- **The network is the container's.** The plugin calls gosidian, the
  repositories' servers and the hosts; the scripts reach what the
  container's network lets them. Two ways, below: open to the registries,
  or closed. A closed network is the safer one for the repositories the
  agents write.
- **The memory is the container's.** A step that eats it fails the other
  slots' too: keep `EXEC_WORKERS` low (2 by default), give the container a
  `mem_limit` and a `pids_limit`, and for a real isolation run a container
  per preset.
- **`processes` counts by user ID across the whole host.** Containers
  without user namespaces share the IDs, so the slots' users are 10101 up,
  apart from the agent plugins' (pi, claude: 10001 up). Another container
  with the same IDs would take from the same count: keep the defaults
  generous.
- **A host is real access to a machine.** Give the plugin a key of its own
  and a user of its own on the host, with the least rights the work needs;
  pin the host key; list only the hosts the pipelines need. The approvals
  belong in the pipeline (`wait.call` before the node). The plugin does
  not filter the commands: it cannot be done well, and it does not try.

Open to the registries (a gate that runs `npm ci`, `go mod download`,
`pip install`):

```yaml
services:
  exec:
    image: ghcr.io/daniele-chiappa/gosidian-exec:0.1.1
    restart: unless-stopped
    environment:
      GOSIDIAN_PLUGIN_TOKEN: ${EXEC_TOKEN:?}
      EXEC_WORKERS: "2"
    volumes:
      - ./exec.yaml:/etc/gosidian-exec/preset.yaml:ro
      - ./secrets/lab_key:/run/secrets/lab_key:ro      # root's, mode 600
      - exec-cache:/var/cache/gosidian-exec             # with cache: project
    read_only: true
    tmpfs: ["/tmp:size=4g,exec"]  # the steps' folders: exec, they run what they build
    cap_drop: [ALL]
    cap_add: [SETUID, SETGID]      # to run a step as its slot's user
    security_opt: ["no-new-privileges:true"]
    mem_limit: 4g
    pids_limit: 4096
    networks: [default]
volumes:
  exec-cache:
```

Closed (gosidian, the hosts and the repositories' servers only):

```yaml
services:
  exec:
    # … as above
    networks: [gosidian-internal]
networks:
  gosidian-internal:
    internal: true                 # gosidian is on it too, and what the plugin calls
```

Without root, the plugin still works, and says so at startup: the steps
then run as the server's user, and could read the hosts' keys and the
server's environment.

## Environment

| Variable | Default | |
|---|---|---|
| `GOSIDIAN_PLUGIN_TOKEN` | empty | the bearer token gosidian sends; empty: none |
| `EXEC_PRESET` | `/etc/gosidian-exec/preset.yaml` | the preset |
| `EXEC_WORKERS` | 2 | steps at once, at most 8 (a user each); the others wait |
| `EXEC_RUNS_DIR` | `/tmp/gosidian-exec` | the steps' folders: a file system that may execute |
| `EXEC_MAX_FILES_BYTES` | 256 MiB | the files of one step together |
| `EXEC_MAX_OUT_FILES`, `EXEC_MAX_OUT_BYTES` | 50, 50 MiB | the files given back |
| `EXEC_UID`, `EXEC_GID` | 10101 | the first slot's user and group, as root |
| `EXEC_SSH` | `ssh` | the ssh the server runs (for the tests) |
| `EXEC_IMAGE` | the image's name | the output's `executor.image` |
| `PORT` | 8000 | MCP at `/mcp`, `GET /health` without a token |

## Building and testing

```bash
docker build --build-arg VERSION=0.1.1 --build-context kit=agent-kit -t gosidian-exec:0.1.1 exec/
exec/scripts/test.sh              # types and tests in node:24-alpine, as a user of their own
exec/scripts/separation-test.sh   # the image as in production: users, secrets, limits, toolchains, a repository, a host over SSH
```

`src/kit` links [agent-kit](../agent-kit), the code the plugins share; the
image copies it from the build context `kit`. The tests run real scripts,
repositories on disk, a fake ssh that runs the host's commands here, and,
when `sshd` is installed, a real one. They run as a user without other
processes: a step's `ulimit -u` counts its user's processes in the whole
user namespace, and root inside a container is not exempt from it. The
separation test also starts a throwaway sshd. The image (about 1.1 GB) is
built for amd64; its Go comes from `golang:1.27-alpine`.

## Licenses

MIT, like gosidian. The toolchains and packages in the image are under
their own licenses: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
