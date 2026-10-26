# Changelog: gosidian-database

The changes of the `database` plugin, newest first. A tag
`database/vX.Y.Z` publishes `ghcr.io/daniele-chiappa/gosidian-database:X.Y.Z`,
and its release notes are its section here.

## [0.6.0] — 2026-10-22

The preset from the environment, for gosidian's compose presets.

### Added
- **Variables in the preset**: `${NAME}` and `${NAME:-default}` are
  filled from the environment before the preset is read, so `.env` sets
  the endpoint, the models and their sizes. A `$` without braces stays as
  written, and so does a comment line; an unset variable with no default
  stops the plugin at start, naming it.

## [0.5.0] — 2026-10-16

Rerankers: a search reads its first candidates again with a model that
scores how well each answers the question.

### Added
- **`rerankers`** in the preset, with `default_reranker`: each an endpoint
  with `POST /rerank` (llama.cpp's server with `--reranking`, vLLM, Jina,
  Cohere; none, the preset's endpoint), `document_template`, `max_chars`,
  `batch`, `sigmoid` (for an endpoint that gives logits) and `cost`.
- **`search` with `rerank`** (`true` or a reranker's name): the reranker
  reads the cosine's first `candidates` per question (50 by default) and
  keeps its first `k`, each hit with `rerank_score` beside its cosine;
  `min_rerank_score` leaves out the weaker. `ms.rerank` and
  `usage.rerank_tokens` say what it cost.
- **`rerank`** (node and tool, read): orders `texts`, `items` (objects with
  a text, given back whole) or the chunks of a collection by `ids` for a
  question. Offered only with rerankers in the preset.
- `limits.max_rerank` (200): the texts of one `rerank`, and the candidates
  per question of a search with `rerank`.
- `query_id` on a model of the preset: the questions go to another id of
  the same weights, with a shorter context, which stays loaded beside the
  model of an answer. The documents and their fingerprint keep `id`.

### Changed
- `permissions.network` of the manifest names each host once (the
  endpoint, the store and the rerankers'), as gosidian shows it.

### Fixed
- A call to Qdrant, or to an endpoint, on a kept connection the server
  closed as it came in failed with `EOF`: a search with a reranker, whose
  pauses outlast Qdrant's keep-alive, met it in one batch out of twenty.
  Every call of the plugin can be repeated, and Go now sends it again on a
  new connection.

## [0.4.0] — 2026-10-15

### Added
- `limits.max_graph` and `limits.max_graph_k` in the preset: the chunks or
  documents of a graph (5000) and the neighbours of each (20), which were
  constants. gosidian draws up to its `[web] graph_max_nodes`: raise the
  two together. The README says which lengths are formats and stay.

## [0.3.0] — 2026-10-15

Versions of the chunks, kept in their meta: the operators to find the
state at a date, a page at a time, and changes of the meta in place.

### Added
- **Operators in the filters** on `meta`: `eq`, `ne` (a chunk without the
  key holds it too), `in` (a list), and `gt`, `gte`, `lt`, `lte` for
  numbers, `{"since": {"lte": 1791970000}}`, in `search`, `delete` and the
  new operations. A value alone is still the value a key must have.
- **`list`** (read): the chunks of a filter, a page at a time with a
  cursor, with `total` on the first page (a count is a pass over the
  filter, which the later pages do not repeat), without their text unless
  `with_text`; a page holds up to `limits.max_list` (5000), so a
  document's chunks fit in one, and `fields` keeps only the fields named
  (`id`, `meta.<key>`), so they fit in the result.
- **`update`** (write): sets or removes (`null`) keys of the meta of
  chunks by id or filter, keeping their text and embeddings. One that
  would make a chunk's meta larger than `limits.max_meta` changes
  nothing. On PostgreSQL and SQLite it is one statement; on Qdrant it goes
  1000 points at a time, and one that fails says how many it changed.
- **Copying a collection without the model**: `list` with `vectors: true`
  gives the chunks' embeddings as stored (at most `limits.max_items` a
  page) with the collection's `model` and `dims` and each chunk's
  `fingerprint`, and `upsert` stores a chunk that has a `vector` with it
  and its `fingerprint`, counted in `given`. A vector given that is not
  finite numbers, or cannot be made length 1 (zeros, or numbers whose
  squares overflow or underflow), is refused. A collection then goes to
  another archive without the model, and a smaller size of a Matryoshka
  model is the first numbers of the larger vectors.
- **More limits of the preset**, the installer's to set: `limits.max_queries`
  (32, the texts of one search), `limits.max_result` (1,024,000 bytes, a
  result), which follows gosidian's `[pipelines] max_output_bytes`,
  `limits.max_in` (1000, the values of an `in`), `limits.max_update_keys`
  (64, the keys of one `update`) and `limits.max_meta` (16,384 bytes of
  JSON, a chunk's meta, the 16 KiB fixed before, which an `update` now
  checks too).
- **`copy`** (write): the chunks of a collection, or of a filter, with their
  embeddings and fingerprints into another collection of the same archive,
  made with the same model and size; no model is called. It goes a page at
  a time: one that fails leaves the chunks copied before, and says how
  many; a copy again completes it.
- **`store.ef`**: the breadth of a search that asks for no `ef`, the
  installer's to set (Postgres and Qdrant; 0 keeps the built-in one).
- **`search` with `ef`**: the breadth of the HNSW search, to trade time
  for what an index finds (PostgreSQL `hnsw.ef_search`, Qdrant `hnsw_ef`).
- **`search` gives its times**: `ms` with the model's (`embed`) and the
  store's (`search`), so a comparison of archives or indexes reads the
  second alone.
- **`search` with `exact: true`**: the text against every chunk the filter
  keeps, not through the index, as the reference an index's results are
  measured against: PostgreSQL turns its index scans off (and skips the
  binary quantization of the vectors over 4000 numbers), Qdrant searches
  exactly, SQLite always did.
- **`store.meta_index`** (Qdrant): the keys of the meta the filters use,
  with their type (`keyword`, `integer`, `float`, `bool`), get a payload
  index, so Qdrant follows a filter on them inside its HNSW graph: a new
  collection when it is made, an older one on its first use.
- **A page of `list` fits in a result**: chunks with their vectors or
  long texts that would pass 1 MB make a shorter page, whose `next` goes
  on from the first left out.
- **The README** tells how to keep versions of the chunks with these, and
  how to copy a collection.

### Fixed
- **A search in PostgreSQL goes through the HNSW index every time**: after
  five runs of the search's statement Postgres could keep a generic plan,
  which, not knowing a filter's value on the meta, read every chunk it
  kept through the meta's index and sorted them all, an exact search of
  the collection. Each search is planned with its own values
  (`plan_cache_mode = force_custom_plan`).
- **SQLite keeps its temporary files in memory**: a sort of large rows,
  chunks with their vectors and texts, spilled to a file, which the
  read-only image cannot write ("disk I/O error: permission denied").
- **A search in PostgreSQL with `k` over 500**, under a `limits.max_k`
  raised, failed: its breadth, 2k, passed the 1000 pgvector takes. It
  stays within 1000 now. The breadth is a parameter of one statement, no
  longer a statement prepared again for each value.
- **An endpoint's vector of zeros is refused**, with the batch it came in,
  instead of stored: its cosine, NaN, spoiled the searches that met it.

### Changed
- **`upsert` keeps the embedding** of a stored chunk whose text and title
  are the same, and whose model the preset defines as when it was
  embedded: only the others go to the model, and the result counts
  `embedded` and `kept`. `reembed: true` embeds them all again. Each chunk
  keeps a fingerprint of the model's definition (its `id`, size and cut,
  `document_template`, `max_chars` and the `body` of its requests), so a
  definition changed under the same name embeds the chunks again instead
  of leaving vectors of two definitions in a collection. A collection made
  before gets the fingerprint's column on its first use; its chunks have
  none, and are embedded again on their next upsert, once.

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


## [0.1.1] — 2026-10-13

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
