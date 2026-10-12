# Changelog: gosidian-pi

The changes of the `pi` plugin, newest first. A tag `pi/vX.Y.Z` publishes
`ghcr.io/daniele-chiappa/gosidian-pi:X.Y.Z`, and its release notes are its
section here.

## [0.1.0] — unreleased

The first release: a pi agent (pi.dev 1.0.4) as a node of gosidian's
pipelines. Needs gosidian 2.81 or later, and 2.85 for a list of files and
the run's token budget.

### Added
- **The run node**: a prompt, a system prompt (added or in place of pi's),
  a model of the preset, the thinking level, the temperature, the files of
  the project (by reference, a list too), the tools within the preset's;
  the answer as text or JSON, the files the agent writes in `out/` given
  back as attachments, the usage and cost.
- **One container, one agent**: a preset names the endpoint (any
  OpenAI-compatible API) and its key, the models with their prices,
  sampling and request body, the tools it may use, and the limits of a
  step. Two examples: `pi-locale` (llama.cpp, Qwen3.8-27B at 3 bits) and
  `pi-openrouter`.
- **Limits**: turns, seconds, tokens (and the run's `max_llm_tokens`),
  dollars; pi is stopped at the first one reached.
- **JSON answers**: checked against a JSON Schema, with turns that ask the
  agent to fix them.
- **`inline_files`**: the text files in the prompt too, for a model that
  does not read them with its tools.
- **Security**: the endpoint's key stays in a proxy of the plugin; pi runs
  as another user, who reads neither the key nor the server's
  environment; the processes a step leaves are stopped; only regular files
  come back. `scripts/separation-test.sh` checks it on the image.
