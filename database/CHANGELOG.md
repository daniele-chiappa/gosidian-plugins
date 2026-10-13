# Changelog: gosidian-database

The changes of the `database` plugin, newest first. A tag
`database/vX.Y.Z` publishes `ghcr.io/daniele-chiappa/gosidian-database:X.Y.Z`,
and its release notes are its section here.

## [0.1.0] — 2026-10-13

The first release: an archive of vectors for the pipelines and the agents.
Needs gosidian 2.86 or later, which names the project of every call and
offers a plugin's tools to the agents.

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
