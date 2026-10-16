# gosidian-database

An archive of vectors for [gosidian](https://github.com/daniele-chiappa/gosidian):
it keeps chunks of documents with their embeddings in **PostgreSQL with
pgvector**, **Qdrant** or **SQLite with sqlite-vec**, and searches them. Its
operations are nodes of gosidian's pipelines and, from gosidian 2.86,
tools of its MCP server for the agents of the projects the owner exposes
it in. Each project's data stay apart.

The plugin does not cut documents: the caller hands it chunks, cut however
it likes (by headings, on several levels, by a model or an agent), with
where they come from (`doc`), the chunk they are part of (`parent`) and
their `level`.

One container is one archive: one store, and a **preset** of the endpoint
that computes the embeddings (any OpenAI-compatible `/embeddings`: Ollama,
llama-server, OpenRouter…) with its models, and of the
[rerankers](#reranking) that read a search's first results again. Register
several containers to compare stores or models.

## Operations

| Node / tool | Access | What it does |
|---|---|---|
| `upsert` | write | chunks → embeddings → store; it creates the collection with the model on first use (`model`, default the preset's). A chunk whose `id` is stored replaces it, and keeps its embedding when its text and title are the same, and so is the [definition of its model](#a-models-definition) (`reembed: true` embeds it again). A chunk with a `vector` (its embedding, made already, with the `fingerprint` that came with it) is stored with it, without the model ([copying a collection](#copying-a-collection)). Reports `embedded`, `kept`, `given` and `usage: {embedding_tokens, cost}` |
| `search` | read | the chunks most similar to `query` (or several `queries`, up to `limits.max_queries`, 32), `k` each, with a [`filter`](#filters) and `min_score`; scores are cosine similarities. `ms` gives the time of the model (`embed`) and of the store (`search`) apart. `ef` (1 to 1000) sets the breadth of the HNSW search, more finding more and slower (PostgreSQL `hnsw.ef_search`, by default max(40, 2k), at most 1000; Qdrant `hnsw_ef`, max(64, 2k)). `exact: true` compares the text with every chunk the filter keeps instead of going through the index (PostgreSQL turns its index scans off, Qdrant searches exactly, SQLite always does): slower, the reference an index's results are measured against. `rerank` [reads the first candidates again](#reranking) with a reranker |
| `rerank` | read | orders `texts`, `items` (objects with a `text`, given back whole) or the chunks of `collection` by `ids`, by how well they answer `query`, with a [reranker](#reranking) (`model`); `k` and `min_score` keep the first and the best. Only with rerankers in the preset |
| `get` | read | chunks by `ids` |
| `list` | read | the chunks of a [`filter`](#filters), `limit` at a time (100 by default, at most `max_list`, 5000), without their text unless `with_text`, and with only the `fields` named (`id`, `meta.<key>`…) when given; with `vectors: true` their embeddings too (`vector`, as stored, and the `fingerprint` of the model's definition that made it, at most `max_items` chunks a page), and the collection's `model` and `dims`. A page holds the chunks that fit in one result gosidian takes (1 MB): with vectors or long texts, fewer than `limit`. `cursor` is the `next` of the page before, empty after the last. The first page, without `cursor`, gives `total`, the chunks of the filter: a count is a pass over the filter, which the later pages do not repeat. In order of id; in Qdrant, of point |
| `update` | write | changes keys of the `meta` of chunks, by `ids`, by [`filter`](#filters), or both: each key is set to its value, `null` removes it, up to `limits.max_update_keys` (64) keys. The text and the embeddings stay. An update that would make a chunk's meta larger than `limits.max_meta` changes nothing; one that makes it smaller passes ([all or in part](#all-or-in-part)) |
| `delete` | write | chunks by `ids`, by [`filter`](#filters), or both |
| `collections` | read | the project's collections, with model, size and chunks; with `name`, one |
| `drop` | write | a collection and its chunks |
| `copy` | write | the chunks of `collection`, or those of a [`filter`](#filters), with their embeddings as stored, into the collection `to` of this archive, made with the same model and size (or one that has them): no model is called. A part of a collection becomes a collection of its own, the paragraphs of a cut on several levels say. It goes a page at a time ([all or in part](#all-or-in-part)). Between two archives, `list` with `vectors` and `upsert` ([copying a collection](#copying-a-collection)) |
| `query` | read or write | a direct query, only with `DB_QUERY` on ([below](#direct-queries)) |

A collection has one model and one size: a call with another model is
refused. The project comes from the call's `_meta` (`gosidian/project`),
which gosidian sets on every node and tool call; a call without it is
refused.

In a pipeline:

```yaml
nodes:
  - id: store
    use: vec-pg.upsert
    with: {collection: procedure, chunks: "{{ trigger.chunks }}"}
  - id: find
    use: vec-pg.search
    with: {collection: procedure, query: "{{ trigger.question }}", k: 5}
```

For an agent, once the owner ran `gosidian plugin expose vec-pg rag`:
`vec-pg_search({collection: "procedure", query: "…"})`.

### All or in part

An `update` on PostgreSQL or SQLite is one statement: it changes all the
chunks it finds, or none. On Qdrant it goes 1000 points at a time: one
that fails leaves the pages before it changed, and its error says how
many; the same `update` again finishes it, as setting a key twice sets it
once. An update that would make a meta too large is refused before it
changes anything, on the three stores.

A `copy` goes `limits.max_items` chunks at a time, on the three stores:
one that fails leaves in `to` the chunks it copied before, and its error
says how many. Copy again, the same `collection` and `filter`, to finish
it (a chunk with an id `to` has is replaced), or `drop` `to` and copy
again.

## Filters

`search`, `list`, `update` and `delete` take a `filter`, every field of
which must hold: `doc` and `parent` (a string or a list), `level` (a number
or a list), and `meta`, the top-level keys of the chunks' meta. A key holds
a value, which it must equal, or an object of operators:

| Operator | Holds when the key |
|---|---|
| `eq` | equals the value |
| `ne` | does not equal it, or the chunk has no such key |
| `in` | equals one of a list of values (at most `limits.max_in`, 1000) |
| `gt`, `gte`, `lt`, `lte` | is a number greater, at least, less, at most the value; a key that is no number fails it |

```json
{"doc": "guide/pane.md", "meta": {"status": "active", "since": {"lte": 1791970000}, "kind": {"in": ["text", "table"]}}}
```

A key with operators, and a key `update` sets, are letters, digits, `_`
and `-`.

### Versions of the chunks

The plugin keeps no history of its own, but the meta can: a caller that
cuts its documents again keeps the old chunks, closed, beside the new ones.

- Each chunk's id holds its version (`<part>@<version>`), so a new one
  does not replace the old.
- Its meta holds `status` (`active`, `superseded`), and the dates in
  seconds from (`since`) and until (`until`, a far date while active)
  which it holds.
- A new cut upserts the chunks whose text changed (`list` with
  `with_text`, or a hash in the meta, tells which), and `update` closes
  the old ones: `{"status": "superseded", "until": <date>}`.
- The current state is `{"meta": {"status": "active"}}`; the state at a
  date `d` is `{"meta": {"since": {"lte": d}, "until": {"gt": d}}}`, for a
  search or a list. A test asked at two dates compares two states of the
  archive.

### Copying a collection

Two archives with the same model hold the same vectors, and compare their
stores: copying a collection costs no model. A model run again gives about
the same numbers (Qwen3-Embedding-8B on Ollama, twice on 74,367 chunks:
differences of 2.5e-8 at most), so the copy saves time, not precision. It
also gives a smaller size of a Matryoshka model without the model: the
first numbers of the larger vectors, which upsert makes length 1 again.

- `list` with `vectors: true` and `with_text: true` on the archive that
  has it gives the chunks with their `vector` and `fingerprint`, and the
  collection's `model` and `dims`: as many as fit in a result, about 70 of
  1024 numbers with their text;
- `upsert` of that page, as it is, on the other archive, with `model` set
  to the same model of its preset: each chunk with a `vector` is stored
  with it and its `fingerprint`, and counted in `given`. The vector must
  have the collection's `dims` numbers; one of length 1, as an archive's
  are, is kept number for number, another is made length 1. A vector that
  cannot be made length 1 (zeros, or numbers too small or too large to
  square) is refused.

The fingerprint tells a later upsert of the same text whether the vector
is one the preset's model would make ([below](#a-models-definition)): the
same definition in the two presets keeps it, another embeds it again. A
vector given without one is embedded again on its next upsert.

Postgres gives its vectors in their shortest exact form and SQLite and
Qdrant as float32, so a copy among the three searches as the original:
the same chunks with the same scores. A collection kept as `halfvec` (over
2000 numbers) gives its rounded numbers.

## Reranking

The cosine of two vectors made apart finds texts **similar** to a
question; a reranker (a cross-encoder) reads the question together with
each text and scores how well the text **answers** it. It is slower, so it
reads only the first candidates of a search:

```json
{"collection": "procedure", "query": "…", "k": 5, "rerank": true, "candidates": 50, "min_rerank_score": 0.3}
```

- `rerank`: `true` for the preset's `default_reranker`, or a reranker's
  name;
- `candidates`: the chunks the cosine finds first, per question, which the
  reranker reads (50 by default, at least `k`, at most `limits.max_rerank`,
  200); it keeps the first `k`;
- `min_rerank_score` leaves out what it scores below: a threshold under
  which an answer would say it does not know;
- each hit keeps its cosine in `score`, and has the reranker's in
  `rerank_score`; equal scores keep the cosine's order. `ms.rerank` is the
  reranker's time, `usage.rerank_tokens` what it read;
- the reranker reads each chunk's text even when the result leaves it out
  (`with_text: false`).

`rerank` orders texts from anywhere, the results of another search (a
full-text one, say) among them: `items` come back whole, with
`rerank_score`.

A reranker's endpoint is any API with `POST /rerank` taking `model`,
`query` and `documents` and giving `results` of `index` and
`relevance_score`: llama.cpp's server started with `--reranking`, vLLM,
Jina, Cohere (Hugging Face's TEI has another format). Some give the
model's logits, llama.cpp's among them: `sigmoid: true` maps them to 0..1,
so a threshold reads the same with another endpoint. llama.cpp's server
reads a question and a text in one pass of its context, and fails a request
with a longer one: `max_chars` cuts the texts. A character can be a token
(in a table or a code: a paragraph of 8000 characters made 4149 tokens),
so keep it under the context in tokens less the question's, 4000 for
`-c 4096`.

On an RTX 4060 Ti, bge-reranker-v2-m3 (Q8_0, in 576 MiB of llama.cpp's
server, beside Ollama) read 30,000-35,000 tokens a second: 50 candidates of
some 600 characters in 0.3 s, 100 in 0.6 s.

## Graphs

From gosidian 2.87 the plugin offers two graphs to the Graph window and
the ```` ```graph ```` blocks of the projects it is exposed in:

| Graph | Arguments | What it shows |
|---|---|---|
| `chunks` | `collection`, `k` (6), `sample` (2000, at most 5000), `color` (`doc`, `level`, `parent`, `meta.<key>`), `layout` (`force`, `pca`) | a sample of the chunks, each linked to its `k` most similar; a click shows the chunk's text and opens its document when it is a note |
| `docs` | `collection`, `k` (4), `color` (`folder`, `doc`), `layout` | a node per document, the mean of its chunks, linked to the most similar documents |

````markdown
```graph
source: vec-pg/chunks
with: {collection: procedure, k: 8}
color: doc
mode: 3d
```
````

The neighbours are computed in the plugin, from the sample's vectors.
The force of the graph places the nodes, and keeps neighbours together;
`layout: pca` fixes them at the first principal components, which keep far
fewer of the nearest neighbours.

## The preset

`/etc/gosidian-database/preset.yaml` (`DB_PRESET`). Three examples in
[`presets/`](presets/): Ollama with PostgreSQL, llama.cpp with SQLite,
OpenRouter with Qdrant.

```yaml
description: Chunks in PostgreSQL, embeddings from Ollama
endpoint:
  base_url: http://ollama:11434/v1
  api_key_env: ""          # the variable with the endpoint's key, if any
  body: {}                 # merged into every request (OpenRouter's provider…)
models:
  - id: embeddinggemma:300m
    name: embeddinggemma   # what a collection calls it (default: id)
    dims: 768              # the size of its vectors
    dimensions: 0          # cut them to this size (Matryoshka), normalized again
    query_prefix: "task: search result | query: "
    # query_id: embeddinggemma:300m-short   # the questions to another id of the same weights
    document_template: "title: {title} | text: {text}"
    batch: 32
    cost: {input: 0}       # dollars per million tokens
default_model: embeddinggemma
rerankers:                 # none: no reranking
  - id: bge-reranker-v2-m3
    name: bge-reranker     # what a call names it by (default: id)
    endpoint:              # an API with /rerank; none, the preset's endpoint
      base_url: http://llama-rerank:8081/v1
      api_key_env: RERANK_API_KEY
      timeout: 60s
    document_template: "{title}\n{text}"   # default "{text}"; a missing title is empty
    max_chars: 4000        # cut longer texts (0: whole): under the context in tokens
    batch: 32              # texts per request
    sigmoid: true          # the endpoint gives logits: map them to 0..1
    cost: {input: 0}       # dollars per million tokens read
default_reranker: bge-reranker
store:
  kind: postgres           # postgres, qdrant or sqlite
  url: postgres://gosidian@postgres:5432/vectors
  # meta_index: {status: keyword, since: integer}   # Qdrant: the meta keys its filters use
limits: {max_items: 500, max_list: 5000, max_text: 32768, max_k: 100, max_queries: 32, max_result: 1024000,
         max_in: 1000, max_meta: 16384, max_update_keys: 64, max_graph: 5000, max_graph_k: 20, max_rerank: 200}
```

**The limits** are the installer's to set. `max_items` chunks per write
or get, `max_list` per page of `list`, `max_text` characters of a chunk,
`max_k` results and `max_queries` texts per search; `max_result` bytes of
one result, which follows gosidian's `[pipelines] max_output_bytes` (1 MiB
by default): raise the two together for larger steps. `max_in` values of
an `in` of a [filter](#filters); `max_meta` bytes of a chunk's meta as
JSON, an upsert's and what an `update` makes of it (PostgreSQL measures
an update's as it writes jsonb, a space after each `:` and `,`);
`max_update_keys` keys one `update` sets or removes. `max_graph` chunks or
documents of a [graph](#graphs), `max_graph_k` neighbours of each: gosidian
draws up to its `[web] graph_max_nodes` (5000 by default), so raise the two
together. `max_rerank` texts one `rerank` reads, and candidates per
question of a search with `rerank`. The lengths of an id (256), a doc and a title (1024), a parent
(256) and a cursor (256) are formats, not limits, and stay as they are.

**Prefixes matter.** No endpoint adds them. On a bench of Italian
documents (2026-10-12), EmbeddingGemma without its prefix lost 5 points
of MRR, and Qwen3-Embedding with an instruction other than its own lost
8. The example presets carry the prefixes measured there.

### A model's definition

A collection names its model, and the preset defines it. Each chunk
keeps, with its vector, a fingerprint of the definition that made it: the
model's `id`, the size of its vectors and where they are cut (`dims`,
`dimensions`, `send_dimensions`), `document_template`, `max_chars`, and
the `body` of its requests (the model's, else the endpoint's). An upsert
keeps a stored chunk's embedding only when its text, its title and that
fingerprint are the same.

Change one of them in the preset, a better template say, and upsert the
documents again: every chunk is embedded again, those whose text is the
same too, so a collection does not hold vectors of two definitions side by
side. `query_prefix` is not in it: it makes the questions, not what is
stored; nor is `query_id`.

**`query_id`** sends the questions to another id of the same model: the
same weights served with a shorter context, say an Ollama model made
with a smaller `num_ctx`. A model that embeds long chunks needs a long
context, and its memory with it; a question is short, and the short one
takes less, enough to stay loaded beside the model that writes an answer
(a chat that would otherwise load one and unload the other at every
message). The two must give the same vectors: check a few before using
it. Nor is `endpoint.base_url`: the same model served elsewhere in
another way (another quantization) wants `reembed: true`.

Chunks stored before 0.3.0 have no fingerprint: what made them is
unknown, and they are embedded again on their next upsert, once, as every
upsert did before. A collection made before gets the column on its first
use (PostgreSQL), or when its project's file opens (SQLite).

## The stores

| Store | Where a project lives | Search | Size of the vectors |
|---|---|---|---|
| PostgreSQL + pgvector | a schema `p_<project>_<hash>`: a table per collection, a view by its name | HNSW | `vector` up to 2000; `halfvec` up to 4000; above, an HNSW index on the binary quantization and an exact reranking of 10 candidates per result |
| Qdrant | a collection `<project>_<hash>__<name>` per collection, `gosidian_meta` lists them | HNSW | up to 65,535 |
| SQLite + sqlite-vec | a file `<project>_<hash>.db` per project in `store.path` (a volume) | exact | any; fine up to some tens of thousands of chunks |

A bench of 100,000 vectors (1024 numbers) found a search in 1.7 ms with
Qdrant, 4.3 ms with pgvector and 205 ms with sqlite-vec.

**Filters in Qdrant.** Qdrant follows a filter inside its HNSW graph, and
plans a search from the filter's size, for the payload keys it has an
index of. The plugin indexes `chunk_id`, `doc`, `parent` and `level`; the
keys of the meta a caller filters on, the dates of [versions](#versions-of-the-chunks)
say, it indexes when the preset names them, with their type (`keyword`,
`integer`, `float`, `bool`):

```yaml
store:
  kind: qdrant
  url: http://qdrant:6333
  meta_index: {status: keyword, since: integer, until: integer}
  ef: 128          # the breadth of a search that asks for none
```

`store.ef` (Postgres and Qdrant) is the breadth of an HNSW search when
`search` gives no `ef`: more finds more, slower. Without it Postgres
searches with max(40, 2k), at most 1000, the widest pgvector takes, and
Qdrant with max(64, 2k). On 62,357 paragraphs of a manual (1024 and 2048
numbers), Qdrant found 98% of what the exact search finds at 64 and 99%
at 128, for a tenth of a millisecond more; Postgres 96-97% at 40 and
98-99% at 100. Postgres at 400 read the whole table, as an exact search.

A new collection gets them when it is made; one made before, on its first
use after the plugin starts. PostgreSQL and SQLite read the meta without
an index, so the setting is Qdrant's only.

The PostgreSQL role of `store.url` (password `DB_PASSWORD`) owns the
schemas it makes. It creates the extension `vector`, unless whoever runs
the database made it already. Qdrant's key, if any, is `DB_PASSWORD`.

## Direct queries

With `DB_QUERY=read` (or `write`), the tool and node `query` run queries in
the store's own language, on the project's data only:

- **PostgreSQL**: one SQL statement, as the role of `DB_QUERY_USER`
  (`DB_QUERY_PASSWORD`), with `search_path` set to the project's schema,
  where each collection is a view by its name (`id, doc, parent, level,
  title, text, meta, updated, embedding`) and `collections` lists them.
  `params` are named parameters (`@name`); `embed: {q: "a text"}` makes
  `@q` the text's embedding, as text to cast: `ORDER BY embedding <=>
  @q::vector`.
- **SQLite**: one statement on the project's file, opened read-only
  (`mode=ro`, `query_only`) with `read`, and an authorizer that allows
  reading (and changing rows, with `write`) and nothing else: no `ATTACH`,
  no `PRAGMA`, no schema change. `:name` parameters; `embed`'s vectors are
  BLOBs for `vec_distance_cosine`.
- **Qdrant**: an operation of its API on a collection of the project
  (`query`, `query_groups`, `scroll`, `count`, `facet`, `retrieve`,
  `matrix_pairs`, `matrix_offsets`, `info`; with `write` also
  `set_payload`, `overwrite_payload`, `delete_payload`, `delete_points`)
  with its `body`. A `"$q"` in the body is `embed`'s vector. Every
  collection the body names must be the project's. The key is
  `DB_QUERY_KEY` when set (a JWT you make, `r` or `rw`), else the plugin's.

Whoever runs the database decides what the role of the direct queries may
do: the plugin grants it only the reading of the project's views. With
`{project}` in `DB_QUERY_USER` (`q_{project}`), each project has its role.
Without it, the direct queries belong to one project only, the first that
runs one. The plugin enforces, whatever the role:

- `read` runs in a `READ ONLY` transaction;
- one statement per call, in a session cleaned after (`DISCARD ALL`);
- `DB_QUERY_TIMEOUT` (10s), `DB_QUERY_ROWS` (1000), `DB_QUERY_BYTES` (1 MiB)
  and `DB_QUERY_CONCURRENCY` (2), which a query cannot change;
- a role that is a superuser, bypasses row security, or is the plugin's own
  is refused;
- vectors show as their size, unless `vectors: true`;
- every query is in the plugin's log, with its project and caller.

Use a database of the plugin's own, not one shared with other
applications.

```sql
-- PostgreSQL: the role of a project's direct queries
CREATE ROLE "q_rag" LOGIN PASSWORD '…';
-- more than reading the views is your GRANT, for instance
-- GRANT UPDATE ON "p_rag_1a2b3c4d"."procedure" TO "q_rag";
```

## Running it

```yaml
services:
  vec-pg:
    image: ghcr.io/daniele-chiappa/gosidian-database:0.5.0
    environment:
      DB_NAME: vec-pg                 # the name gosidian registers it with
      GOSIDIAN_PLUGIN_TOKEN: ${VEC_PG_TOKEN}
      DB_PASSWORD: ${PG_PASSWORD}
      DB_QUERY: read                  # off (default), read, write
      DB_QUERY_USER: "q_{project}"
      DB_QUERY_PASSWORD: ${PG_QUERY_PASSWORD}
    volumes:
      - ./preset.yaml:/etc/gosidian-database/preset.yaml:ro
      # - ./data:/data                # SQLite's files
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
```

```toml
[[pipelines.plugins]]
name = "vec-pg"
url = "http://vec-pg:8000/mcp"
token_secret = "vec-pg-token"
```

```bash
gosidian plugin show vec-pg && gosidian plugin accept vec-pg <sha>
gosidian plugin expose vec-pg rag      # its tools, for the agents of rag
```

| Variable | |
|---|---|
| `DB_NAME` | the plugin's name in gosidian (required) |
| `DB_PRESET` | the preset (default `/etc/gosidian-database/preset.yaml`) |
| `GOSIDIAN_PLUGIN_TOKEN` | the bearer gosidian calls it with |
| `DB_PASSWORD` | PostgreSQL's password, or Qdrant's key |
| `DB_QUERY`, `DB_QUERY_USER`, `DB_QUERY_PASSWORD`, `DB_QUERY_KEY` | the direct queries |
| `DB_QUERY_TIMEOUT`, `DB_QUERY_ROWS`, `DB_QUERY_BYTES`, `DB_QUERY_CONCURRENCY` | their limits |
| the preset's `api_key_env` | the endpoint's key |
| `PORT` | default 8000 |

## Building and testing

```bash
docker build -t gosidian-database database/
sh database/scripts/test.sh      # PostgreSQL 18 + pgvector 0.8.6, Qdrant 1.19.1, SQLite + sqlite-vec 0.1.9
```

The tests run the same suite on the three stores, the direct queries'
protections among them (a superuser refused, `READ ONLY` against a granted
`DELETE`, a timeout against `pg_sleep`, a project that does not read
another's, `ATTACH` refused, a Qdrant body naming another project's
collection refused).

## Licenses

MIT. The image holds sqlite-vec (MIT or Apache-2.0), built from its
release's amalgamation, and the Go modules the binary links: see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `/licenses` in the
image.
