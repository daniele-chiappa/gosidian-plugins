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
llama-server, OpenRouter…) with its models. Register several containers to
compare stores or models.

## Operations

| Node / tool | Access | What it does |
|---|---|---|
| `upsert` | write | chunks → embeddings → store; it creates the collection with the model on first use (`model`, default the preset's). A chunk whose `id` is stored replaces it. Reports `usage: {embedding_tokens, cost}` |
| `search` | read | the chunks most similar to `query` (or up to 32 `queries`), `k` each, with a `filter` on `doc`, `parent`, `level` and `meta`, and `min_score`; scores are cosine similarities |
| `get` | read | chunks by `ids` |
| `delete` | write | chunks by `ids`, by `filter`, or both |
| `collections` | read | the project's collections, with model, size and chunks; with `name`, one |
| `drop` | write | a collection and its chunks |
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
    document_template: "title: {title} | text: {text}"
    batch: 32
    cost: {input: 0}       # dollars per million tokens
default_model: embeddinggemma
store:
  kind: postgres           # postgres, qdrant or sqlite
  url: postgres://gosidian@postgres:5432/vectors
limits: {max_items: 500, max_text: 32768, max_k: 100}
```

**Prefixes matter.** No endpoint adds them. On a bench of Italian
documents (2026-10-12), EmbeddingGemma without its prefix lost 5 points
of MRR, and Qwen3-Embedding with an instruction other than its own lost
8. The example presets carry the prefixes measured there.

## The stores

| Store | Where a project lives | Search | Size of the vectors |
|---|---|---|---|
| PostgreSQL + pgvector | a schema `p_<project>_<hash>`: a table per collection, a view by its name | HNSW | `vector` up to 2000; `halfvec` up to 4000; above, an HNSW index on the binary quantization and an exact reranking of 10 candidates per result |
| Qdrant | a collection `<project>_<hash>__<name>` per collection, `gosidian_meta` lists them | HNSW | up to 65,535 |
| SQLite + sqlite-vec | a file `<project>_<hash>.db` per project in `store.path` (a volume) | exact | any; fine up to some tens of thousands of chunks |

A bench of 100,000 vectors (1024 numbers) found a search in 1.7 ms with
Qdrant, 4.3 ms with pgvector and 205 ms with sqlite-vec.

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
    image: ghcr.io/daniele-chiappa/gosidian-database:0.1.0
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
