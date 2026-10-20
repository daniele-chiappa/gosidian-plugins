# agent-kit

The code the agent plugins share ([claude](../claude), [pi](../pi)): no
package of its own, no image. Each plugin links it as `src/kit`
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
  what changed, pushes the branch and opens the pull request. The agent
  never holds the credentials, and the server runs nothing of the
  repository's: the git folder lies outside the work tree, readable by
  the agent and not writable; git runs without hooks, without the
  system's or a user's configuration, without filters; a hard link, a
  file that is not a plain one, or more files or bytes than the preset
  allows, commit nothing.
- `exec.ts`: a command of the server: arguments as a list, no shell, an
  environment of its own, a time limit.

Tests: `npm ci && npm run check && npm test` (they need `git`).
