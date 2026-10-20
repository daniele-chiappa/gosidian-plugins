# Changelog: gosidian-exec

The changes of the `exec` plugin, newest first. A tag `exec/vX.Y.Z`
publishes `ghcr.io/daniele-chiappa/gosidian-exec:X.Y.Z`, and its release
notes are its section here.

## [0.1.0] — 2026-10-20

The first release: a node `run` that runs a script or a command and keeps
`command-run/1`, the contract of gosidian's command nodes (gosidian 2.100.1,
`docs/plugins.md`, "Command nodes"), for the gate of a team of agents (the
tests and the build of a branch an agent pushed) and the operations on a
server.

### Added
- **The node `run`**: `script` (the preset's shell, `-e`) or `command` (a
  list, no shell); `target`; `files` by reference, in `in/`, checked by
  size and SHA-256; `repo`, a repository of the preset at a branch, a tag
  or a commit, in `repo/`, never committed; `env`, the node's variables
  (not `PATH`, `HOME`, `LD_*`, `GIT_*`, `PYTHON*` and the others the
  plugin or a shell's start reads); `timeout`; `output_limit`;
  `fail_on_error` (default true: an exit code other than 0, a signal or
  the timeout fails the node; false: the pipeline reads `exit_code`); and
  in the sandbox `processes`, `file_size`, `cpu_seconds`. The output:
  `exit_code`, `signal`, `timed_out`, the end of `stdout` and `stderr`,
  `truncated`, `seconds`, `repo` with the commit it ran on, `target`,
  `executor`, and the files of `out/` as attachments.
- **The sandbox** (`target: local`): an image with git, Node 24, Go 1.27,
  Python 3 with pip, make and a C/C++ compiler. A step runs as the user of
  its slot (`exec1` to `exec8`), in a folder only its slot's group may
  enter, with an environment of the plugin's (no variable of the
  server's), within `ulimit -u`, `-f` and `-t` it cannot raise, and the
  timeout: SIGTERM to its processes, SIGKILL 3 seconds later, sent as the
  slot's user. When it ends, every process of that user is stopped and its
  folder removed.
- **The hosts** (`target: <host>`): a closed list in the preset, reached
  over SSH with a key of the plugin's (a file only root reads) and pinned
  host keys. A step's folder is made in the host's workdir (a folder of
  the user's, not a link), its files sent and brought back as tars (the
  members checked, links skipped), the script run with the host's shell
  within `timeout -s KILL` when the host has it, else within the server's
  time; what it left running is stopped, and its folder removed. A host
  key that is not the pinned one fails the node.
- **The preset**: `shell`, `limits` (`default`, `max`), `env`, `network`
  (declared in the manifest, enforced by the container), `repos`
  (agent-kit's), `hosts`, and `cache`: `none` (the default) or `project`,
  a folder per project in a volume, whose name a step of another project
  cannot know.
- **The image** `ghcr.io/daniele-chiappa/gosidian-exec`, amd64, and a
  separation test of it as in production: the slots' users apart, no
  secret in a step's reach, a fork bomb and a file beyond its size
  stopped, the toolchains as a slot's user, a repository at a tag, and a
  host over SSH against a throwaway sshd.
