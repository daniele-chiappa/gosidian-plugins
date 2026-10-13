# Changelog: gosidian-database

The changes of the `database` plugin, newest first. A tag
`database/vX.Y.Z` publishes `ghcr.io/daniele-chiappa/gosidian-database:X.Y.Z`,
and its release notes are its section here.

## [0.2.0] — 2026-10-13

Maps of an archive, for gosidian's graph views. Needs gosidian 2.87 or
later for them; the rest works from 2.86.

### Added
- **Two graphs** (`graphs` in the manifest, read with `gosidian_graph`):
  - `chunks`: a sample of a collection's chunks (`sample`, 2000 by
    default, at most 5000, the same ones each time), each linked to its
    `k` most similar (6 by default), coloured by `doc`, `level`, `parent`
    or `meta.<key>`; a node carries the chunk's text and its document;
  - `docs`: a node per document, the mean of its chunks, linked to the
    most similar documents, coloured by folder.

  The force of gosidian's graph places them, so neighbours stay together;
  `layout: pca` fixes their places at the first principal components
  instead, for a small set. The neighbours are computed in the plugin,
  the same on the three stores.



The first public release: 0.1.0, with the tests' script fit for a runner
of 4 CPUs. An archive of vectors on PostgreSQL with pgvector, Qdrant or
SQLite with sqlite-vec, with the embeddings from a preset, for the
pipelines and the agents: what it does is in 0.1.0 below and in the
README. Needs gosidian 2.86 or later, which names the project of every
call and offers a plugin's tools to the agents.

### Fixed
- **scripts/test.sh** asks for the host's CPUs, at most 8, not 8 always:
  a runner of GitHub has 4, and Docker refused the tests' container.

## [0.1.0] — 2026-10-13

An archive of vectors for the pipelines and the agents; not published.

### Added
- **Three stores**: PostgreSQL with pgvector (`vector` up to 2000
  numbers, `halfvec` up to 4000, a binary index with reranking above),
  Qdrant (through its REST API), SQLite with sqlite-vec (a file per
  project, exact search). Each project's data apart.
- **Embeddings from a preset**: any OpenAI-compatible `/embeddings`
  (Ollama, llama-server, OpenRouter), its models with their size, a cut
  (Matryoshka, normalized again), the prefix of the questions and the
  template of the documents, the batch and the price. A collection keeps
  one model. Three example presets: Ollama with PostgreSQL, llama.cpp with
  SQLite, OpenRouter with Qdrant, with the prefixes a bench of Italian
  documents measured.
- **Operations**, each a node and a tool: `upsert`, `search` (with filters
  on `doc`, `parent`, `level`, `meta`, and several questions at once),
  `get`, `delete`, `collections`, `drop`. The chunks come cut by the
  caller, on one level or several.
- **Direct queries** (`DB_QUERY=off|read|write`, off by default): SQL on
  PostgreSQL and SQLite, the API's operations on Qdrant, on the project's
  data, with the texts of `embed` as vectors. The permissions are the
  role's whoever runs the database gives (`DB_QUERY_USER`, a role per
  project with `{project}`); the plugin enforces `READ ONLY` for `read`, one
  statement in a cleaned session, a timeout, rows, bytes and concurrency,
  and refuses a superuser, a role that bypasses row security, or its own.
