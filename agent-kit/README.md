# agent-kit

The code the agent plugins and the command plugin share ([claude](../claude),
[pi](../pi), [exec](../exec)): no package of its own, no image. Each plugin links it as `src/kit`
(`src/kit -> ../../agent-kit`) and its image copies it from the build
context `kit`:

```bash
docker build --build-context kit=agent-kit -t gosidian-claude claude/
```

- `contract.ts`: agent-run/1, the contract of the agents' nodes in
  gosidian (`docs/plugins.md`, "Agent nodes"): the access levels, the MCP
  levels, the fields of the call's `_meta`.
- `repos.ts`: the repositories of a preset, the closed list a step may
  work on: URL, deploy key and pinned host keys for SSH, base branch,
  the prefix of the steps' branches, the protected ones, the author, the
  limits, the pull requests (Gitea).
- `git.ts`: the repository of a step. The plugin's server clones it on a
  branch of the step's own, the agent edits the files, the server commits
  what changed (the output names the files), pushes the branch and opens
  the pull request. The agent
  never holds the credentials, and the server runs nothing of the
  repository's: the git folder lies outside the work tree, readable by
  the agent and not writable; git runs without hooks, without the
  system's or a user's configuration, without filters; a hard link, a
  file that is not a plain one, or more files or bytes than the preset
  allows, commit nothing.
- `pulls.ts`: the pull requests of a preset's repositories, on their
  server's API (Gitea) with the plugin's token: a step opens one for its
  branch, and the node `pr` merges or closes one a step opened, then
  deletes its branch. `pr` acts only on a pull request of the repository
  itself, from a branch under the preset's prefix, and never deletes a
  protected branch.
- `ssh.ts`: ssh from the server to a host of its preset: one key, the
  host keys pinned, no agent, no configuration of a file, no prompt; the
  repositories over SSH and the hosts of exec use it.
- `Workspace.checkout` (git.ts): a repository at a branch, a tag or a
  commit, detached, for a step that runs on its files and commits nothing.
- `exec.ts`: a command of the server: arguments as a list, no shell, an
  environment of its own, a time limit.
- `signal.ts`: the signals to a step's processes. The server runs as root
  with only `CAP_SETUID` and `CAP_SETGID`: without `CAP_KILL` it may not
  signal the slot's user, so a shell it starts as that user sends the
  signal. `signalGroup` signals the process group of the agent (the stop
  at a limit, SIGTERM then SIGKILL), `killUser` every process of the
  slot's user (the end of a step). Without a slot's user (a server that
  is not root, as in the tests) the server signals the group itself.

Tests: `npm ci && npm run check && npm test` (they need `git`). The test
of `signal.ts` as a slot's user runs only as root; that root without
`CAP_KILL` stops the agent, the plugins' separation tests check.
