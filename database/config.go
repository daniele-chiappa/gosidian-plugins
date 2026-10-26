package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

// Config is an archive's preset: the endpoint that computes the
// embeddings and its models, the rerankers that read a search's results
// again, the store that keeps the vectors, the limits of a call. The
// secrets are not in it: they come from the environment (Env).
type Config struct {
	Description     string      `yaml:"description"`
	Endpoint        Endpoint    `yaml:"endpoint"`
	Models          []Model     `yaml:"models"`
	DefaultModel    string      `yaml:"default_model"`
	Rerankers       []Reranker  `yaml:"rerankers"`
	DefaultReranker string      `yaml:"default_reranker"`
	Store           StoreConfig `yaml:"store"`
	Limits          Limits      `yaml:"limits"`
}

// Endpoint is an OpenAI-compatible API with /embeddings (Ollama, a
// llama-server, OpenRouter), or, a reranker's, one with /rerank.
type Endpoint struct {
	BaseURL string `yaml:"base_url"`
	// APIKeyEnv names the variable with the endpoint's key; empty for none.
	APIKeyEnv string `yaml:"api_key_env"`
	// Body is merged into every request (OpenRouter's provider routing, for
	// one); a model's body replaces it.
	Body    map[string]any `yaml:"body"`
	Timeout Duration       `yaml:"timeout"`
}

// Model is an embedding model of the endpoint.
type Model struct {
	ID string `yaml:"id"`
	// QueryID is the model asked for the questions, when not ID: the same
	// weights served with a shorter context (Ollama's num_ctx), which take
	// less memory and so stay loaded beside the model of an answer. It
	// must give the same vectors as ID; documents always go to ID.
	QueryID string `yaml:"query_id"`
	// Name is what a collection and a call name it by; default ID.
	Name string `yaml:"name"`
	// Dims is the size of the vectors the model gives.
	Dims int `yaml:"dims"`
	// Dimensions cuts them to that size and normalizes them again, for a
	// model trained to allow it (Matryoshka); 0 keeps Dims.
	Dimensions int `yaml:"dimensions"`
	// SendDimensions asks the endpoint for Dimensions instead of cutting
	// the vectors here.
	SendDimensions bool `yaml:"send_dimensions"`
	// QueryPrefix goes before a question; DocumentTemplate makes a
	// document's text, with {text} and {title} (default "{text}").
	QueryPrefix      string `yaml:"query_prefix"`
	DocumentTemplate string `yaml:"document_template"`
	// Batch is the texts of one request (default 32); MaxChars cuts a text
	// longer than that (0: the endpoint decides).
	Batch    int `yaml:"batch"`
	MaxChars int `yaml:"max_chars"`
	// Cost is in dollars per million input tokens.
	Cost struct {
		Input float64 `yaml:"input"`
	} `yaml:"cost"`
	Body map[string]any `yaml:"body"`
}

// Reranker is a model that reads a question together with each text and
// scores how well the text answers it (a cross-encoder), more slowly and
// better than the cosine of two vectors made apart. Its endpoint is an API
// with POST /rerank (model, query, documents → results of index and
// relevance_score): llama.cpp's server with --reranking, vLLM, Jina,
// Cohere.
type Reranker struct {
	ID string `yaml:"id"`
	// Name is what a call names it by; default ID.
	Name string `yaml:"name"`
	// Endpoint serves it; none, the preset's endpoint.
	Endpoint Endpoint `yaml:"endpoint"`
	// DocumentTemplate makes the text a document is read as, with {text}
	// and {title} (default "{text}").
	DocumentTemplate string `yaml:"document_template"`
	// MaxChars cuts a text longer than that (0: the endpoint decides): a
	// server reads the question and a text in one pass of its context, and
	// a character of a table or a code can be a token, so under the
	// context in tokens less the question's.
	MaxChars int `yaml:"max_chars"`
	// Batch is the texts of one request (default 32).
	Batch int `yaml:"batch"`
	// Sigmoid maps the scores to 0..1, for an endpoint that gives the
	// model's logits (llama.cpp's server): a threshold then reads as with
	// an endpoint that maps them itself (vLLM, Cohere).
	Sigmoid bool `yaml:"sigmoid"`
	// Cost is in dollars per million tokens read.
	Cost struct {
		Input float64 `yaml:"input"`
	} `yaml:"cost"`
	Body map[string]any `yaml:"body"`
}

// Size is the size of the vectors a collection of the model keeps.
func (m Model) Size() int {
	if m.Dimensions > 0 {
		return m.Dimensions
	}
	return m.Dims
}

// fingerprint is a digest of what makes the model's vector of a document:
// the model asked (id), the size and where it is cut, the template, the
// cut of the text and the body of the request (the model's, else the
// endpoint's). A collection names its model only by name, which the
// installer may define again: a stored chunk keeps its embedding only
// under the same fingerprint, so a changed definition embeds it again
// instead of mixing two spaces of vectors in a collection. The query
// prefix is not in it: it changes the questions, not what is stored.
func (m Model) fingerprint(ep Endpoint) string {
	body := ep.Body
	if m.Body != nil {
		body = m.Body
	}
	// A body JSON cannot write fails the requests too: any digest will do.
	b, _ := json.Marshal(struct {
		ID       string         `json:"id"`
		Size     int            `json:"size"`
		Send     bool           `json:"send_dimensions"`
		Template string         `json:"document_template"`
		MaxChars int            `json:"max_chars"`
		Body     map[string]any `json:"body"`
	}{m.ID, m.Size(), m.SendDimensions && m.Dimensions > 0, m.DocumentTemplate, m.MaxChars, body})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:8])
}

// fingerprintFormat is a fingerprint as list gives it.
var fingerprintFormat = regexp.MustCompile(`^[0-9a-f]{16}$`)

// StoreConfig is the database.
type StoreConfig struct {
	// Kind is postgres, qdrant or sqlite.
	Kind string `yaml:"kind"`
	// URL: postgres://user@host:5432/db, or Qdrant's http://qdrant:6333.
	// The password, or Qdrant's key, is DB_PASSWORD.
	URL string `yaml:"url"`
	// Path is the folder of SQLite's files, one per project.
	Path string `yaml:"path"`
	// Extension is sqlite-vec's loadable extension.
	Extension string `yaml:"extension"`
	// MetaIndex (Qdrant) names keys of the chunks' meta the filters use,
	// with their type (keyword, integer, float, bool): Qdrant indexes them,
	// and a search with a filter on them then follows the filter inside its
	// HNSW graph and plans its search from the index.
	MetaIndex map[string]string `yaml:"meta_index"`
	// EF is the breadth of an HNSW search that asks for none (Postgres
	// hnsw.ef_search, Qdrant hnsw_ef), 1 to 1000; 0 keeps the built-in
	// max(40, 2k) and max(64, 2k).
	EF int `yaml:"ef"`
}

// metaIndexTypes are the payload indexes a key of the meta may have.
var metaIndexTypes = map[string]bool{"keyword": true, "integer": true, "float": true, "bool": true}

// Limits cap a call.
type Limits struct {
	MaxItems int `yaml:"max_items"` // chunks per upsert, get, update or delete (by id)
	MaxList  int `yaml:"max_list"`  // chunks per page of list
	MaxText  int `yaml:"max_text"`  // characters of a chunk's text
	MaxK     int `yaml:"max_k"`     // results per question
	// MaxQueries are the texts one search takes (queries).
	MaxQueries int `yaml:"max_queries"`
	// MaxResult caps the bytes of one result: gosidian takes up to its
	// [pipelines] max_output_bytes of a node's output (1 MiB by default),
	// so the two go up together.
	MaxResult int `yaml:"max_result"`
	// MaxIn are the values of one in of a filter.
	MaxIn int `yaml:"max_in"`
	// MaxMeta caps the bytes of a chunk's meta as JSON: an upsert's, and
	// what an update makes of it.
	MaxMeta int `yaml:"max_meta"`
	// MaxUpdateKeys are the keys one update sets or removes.
	MaxUpdateKeys int `yaml:"max_update_keys"`
	// MaxGraph caps the chunks or documents of a graph, MaxGraphK the
	// neighbours of each: gosidian draws up to its [web] graph_max_nodes,
	// so the two go up together.
	MaxGraph  int `yaml:"max_graph"`
	MaxGraphK int `yaml:"max_graph_k"`
	// MaxRerank caps the texts one rerank reads, and the candidates of a
	// search with rerank, per question.
	MaxRerank int `yaml:"max_rerank"`
}

// Duration is a time.Duration written as "30s".
type Duration time.Duration

func (d *Duration) UnmarshalYAML(n *yaml.Node) error {
	v, err := time.ParseDuration(n.Value)
	if err != nil {
		return fmt.Errorf("%q is no duration: %w", n.Value, err)
	}
	*d = Duration(v)
	return nil
}

var (
	modelName      = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,63}$`)
	collectionName = regexp.MustCompile(`^[a-z][a-z0-9_]{0,47}$`)
	pluginName     = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
)

// presetVar is a variable a preset names: ${NAME}, or ${NAME:-default}.
var presetVar = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}`)

// expandPreset fills the variables a preset names from the environment,
// so that an install configured from a .env sets the endpoint and the
// models there. Only the braced form counts, so a $ in
// a prompt stays as written, and a comment line is left alone, so it may
// show the syntax; a variable that is unset or empty takes its default,
// and without one the preset is refused, naming it.
func expandPreset(s string) (string, error) {
	var missing []string
	lines := strings.SplitAfter(s, "\n")
	for i, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		lines[i] = presetVar.ReplaceAllStringFunc(line, func(m string) string {
			g := presetVar.FindStringSubmatch(m)
			if v := os.Getenv(g[1]); v != "" {
				return v
			}
			if g[2] != "" {
				return g[3]
			}
			missing = append(missing, g[1])
			return m
		})
	}
	if len(missing) > 0 {
		return "", fmt.Errorf("the preset names ${%s}, which is not set", strings.Join(missing, "}, ${"))
	}
	return strings.Join(lines, ""), nil
}

// LoadConfig reads a preset, fills its variables and checks it.
func LoadConfig(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	text, err := expandPreset(string(b))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	var c Config
	dec := yaml.NewDecoder(strings.NewReader(text))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if err := c.check(); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &c, nil
}

func (c *Config) check() error {
	u, err := url.Parse(c.Endpoint.BaseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("endpoint.base_url %q is not an http(s) address", c.Endpoint.BaseURL)
	}
	if len(c.Models) == 0 {
		return errors.New("no models")
	}
	seen := map[string]bool{}
	for i := range c.Models {
		m := &c.Models[i]
		if m.Name == "" {
			m.Name = m.ID
		}
		switch {
		case m.ID == "":
			return fmt.Errorf("model %d has no id", i+1)
		case !modelName.MatchString(m.Name):
			return fmt.Errorf("model %q: a name of letters, digits and . _ : / -", m.Name)
		case seen[m.Name]:
			return fmt.Errorf("model %q twice", m.Name)
		case m.Dims <= 0 || m.Dims > 16000:
			return fmt.Errorf("model %q: dims is the size of its vectors, 1 to 16000", m.Name)
		case m.Dimensions < 0 || m.Dimensions > m.Dims:
			return fmt.Errorf("model %q: dimensions cuts the vectors, 1 to dims (%d)", m.Name, m.Dims)
		case m.QueryID != "" && !modelName.MatchString(m.QueryID):
			return fmt.Errorf("model %q: query_id, a model of letters, digits and . _ : / -", m.Name)
		}
		seen[m.Name] = true
		if m.DocumentTemplate == "" {
			m.DocumentTemplate = "{text}"
		}
		if !strings.Contains(m.DocumentTemplate, "{text}") {
			return fmt.Errorf("model %q: document_template has no {text}", m.Name)
		}
		if m.Batch <= 0 {
			m.Batch = 32
		}
	}
	if c.DefaultModel == "" {
		c.DefaultModel = c.Models[0].Name
	}
	if _, ok := c.Model(c.DefaultModel); !ok {
		return fmt.Errorf("default_model %q is no model of the preset", c.DefaultModel)
	}
	if err := c.checkRerankers(); err != nil {
		return err
	}
	switch {
	case c.Store.EF < 0 || c.Store.EF > 1000:
		return fmt.Errorf("store.ef: %d, 1 to 1000 (0 the built-in breadth)", c.Store.EF)
	case c.Store.EF > 0 && c.Store.Kind == "sqlite":
		return errors.New("store.ef: SQLite compares every chunk, it has no index to widen")
	}
	if len(c.Store.MetaIndex) > 0 && c.Store.Kind != "qdrant" {
		return errors.New("store.meta_index: only Qdrant indexes keys of the meta")
	}
	for k, typ := range c.Store.MetaIndex {
		switch {
		case !metaKey.MatchString(k):
			return fmt.Errorf("store.meta_index: %q is no key of the meta (letters, digits, _ and -)", k)
		case !metaIndexTypes[typ]:
			return fmt.Errorf("store.meta_index.%s: %q; keyword, integer, float or bool", k, typ)
		}
	}
	switch c.Store.Kind {
	case "postgres":
		if u, err := url.Parse(c.Store.URL); err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
			return fmt.Errorf("store.url %q is no postgres:// address", c.Store.URL)
		}
	case "qdrant":
		if u, err := url.Parse(c.Store.URL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return fmt.Errorf("store.url %q is not Qdrant's http(s) address", c.Store.URL)
		}
	case "sqlite":
		if c.Store.Path == "" {
			c.Store.Path = "/data"
		}
		if c.Store.Extension == "" {
			c.Store.Extension = "/usr/local/lib/sqlite-vec/vec0"
		}
	default:
		return fmt.Errorf("store.kind %q: postgres, qdrant or sqlite", c.Store.Kind)
	}
	if c.Limits.MaxItems <= 0 {
		c.Limits.MaxItems = 500
	}
	if c.Limits.MaxList <= 0 {
		c.Limits.MaxList = 5000
	}
	if c.Limits.MaxText <= 0 {
		c.Limits.MaxText = 32 << 10
	}
	if c.Limits.MaxK <= 0 {
		c.Limits.MaxK = 100
	}
	if c.Limits.MaxQueries <= 0 {
		c.Limits.MaxQueries = 32
	}
	if c.Limits.MaxIn <= 0 {
		c.Limits.MaxIn = 1000
	}
	if c.Limits.MaxMeta <= 0 {
		c.Limits.MaxMeta = 16 << 10
	}
	if c.Limits.MaxUpdateKeys <= 0 {
		c.Limits.MaxUpdateKeys = 64
	}
	if c.Limits.MaxGraph <= 0 {
		c.Limits.MaxGraph = 5000
	}
	if c.Limits.MaxGraphK <= 0 {
		c.Limits.MaxGraphK = 20
	}
	if c.Limits.MaxRerank <= 0 {
		c.Limits.MaxRerank = 200
	}
	switch {
	case c.Limits.MaxResult == 0:
		c.Limits.MaxResult = 1000 << 10
	case c.Limits.MaxResult < 64<<10 || c.Limits.MaxResult > 256<<20:
		return fmt.Errorf("limits.max_result: %d bytes, from 65536 to 268435456", c.Limits.MaxResult)
	}
	if c.Endpoint.Timeout <= 0 {
		c.Endpoint.Timeout = Duration(2 * time.Minute)
	}
	return nil
}

func (c *Config) checkRerankers() error {
	seen := map[string]bool{}
	for i := range c.Rerankers {
		r := &c.Rerankers[i]
		if r.Name == "" {
			r.Name = r.ID
		}
		switch {
		case r.ID == "":
			return fmt.Errorf("reranker %d has no id", i+1)
		case !modelName.MatchString(r.Name):
			return fmt.Errorf("reranker %q: a name of letters, digits and . _ : / -", r.Name)
		case seen[r.Name]:
			return fmt.Errorf("reranker %q twice", r.Name)
		case r.MaxChars < 0:
			return fmt.Errorf("reranker %q: max_chars, 0 or more", r.Name)
		}
		seen[r.Name] = true
		if r.Endpoint.BaseURL == "" {
			r.Endpoint = c.Endpoint
		}
		if u, err := url.Parse(r.Endpoint.BaseURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return fmt.Errorf("reranker %q: endpoint.base_url %q is not an http(s) address", r.Name, r.Endpoint.BaseURL)
		}
		if r.Endpoint.Timeout <= 0 {
			r.Endpoint.Timeout = Duration(2 * time.Minute)
		}
		if r.DocumentTemplate == "" {
			r.DocumentTemplate = "{text}"
		}
		if !strings.Contains(r.DocumentTemplate, "{text}") {
			return fmt.Errorf("reranker %q: document_template has no {text}", r.Name)
		}
		if r.Batch <= 0 {
			r.Batch = 32
		}
	}
	switch {
	case c.DefaultReranker == "" && len(c.Rerankers) > 0:
		c.DefaultReranker = c.Rerankers[0].Name
	case c.DefaultReranker != "":
		if _, ok := c.Reranker(c.DefaultReranker); !ok {
			return fmt.Errorf("default_reranker %q is no reranker of the preset", c.DefaultReranker)
		}
	}
	return nil
}

// Reranker finds a reranker by name.
func (c *Config) Reranker(name string) (Reranker, bool) {
	for _, r := range c.Rerankers {
		if r.Name == name {
			return r, true
		}
	}
	return Reranker{}, false
}

// Model finds a model by name.
func (c *Config) Model(name string) (Model, bool) {
	for _, m := range c.Models {
		if m.Name == name {
			return m, true
		}
	}
	return Model{}, false
}

// Hosts are the hosts the plugin calls: the endpoint's, the store's and
// the rerankers'.
func (c *Config) Hosts() []string {
	var out []string
	seen := map[string]bool{}
	raws := []string{c.Endpoint.BaseURL, c.Store.URL}
	for _, r := range c.Rerankers {
		raws = append(raws, r.Endpoint.BaseURL)
	}
	for _, raw := range raws {
		if u, err := url.Parse(raw); err == nil && u.Hostname() != "" && !seen[u.Hostname()] {
			seen[u.Hostname()] = true
			out = append(out, u.Hostname())
		}
	}
	return out
}

// The direct queries: off, read or write.
const (
	QueryOff   = "off"
	QueryRead  = "read"
	QueryWrite = "write"
)

// Env is what the environment sets: the plugin's name and token, the
// store's secret, and the direct queries, which whoever runs the database
// opens and locks with the role they give them.
type Env struct {
	Name     string // DB_NAME: the name gosidian registers the plugin with
	Token    string // GOSIDIAN_PLUGIN_TOKEN
	Password string // DB_PASSWORD: the store's password, or Qdrant's key

	Query            string        // DB_QUERY
	QueryUser        string        // DB_QUERY_USER, with {project} for a role per project
	QueryPassword    string        // DB_QUERY_PASSWORD
	QueryKey         string        // DB_QUERY_KEY: Qdrant's key for the direct queries
	QueryTimeout     time.Duration // DB_QUERY_TIMEOUT
	QueryRows        int           // DB_QUERY_ROWS
	QueryBytes       int           // DB_QUERY_BYTES
	QueryConcurrency int           // DB_QUERY_CONCURRENCY
}

// LoadEnv reads the environment.
func LoadEnv(getenv func(string) string) (Env, error) {
	e := Env{Name: getenv("DB_NAME"), Token: getenv("GOSIDIAN_PLUGIN_TOKEN"), Password: getenv("DB_PASSWORD"),
		Query: strings.ToLower(strings.TrimSpace(getenv("DB_QUERY"))), QueryUser: getenv("DB_QUERY_USER"),
		QueryPassword: getenv("DB_QUERY_PASSWORD"), QueryKey: getenv("DB_QUERY_KEY")}
	if !pluginName.MatchString(e.Name) || e.Name == "memory" {
		return e, fmt.Errorf("DB_NAME %q: the name gosidian registers the plugin with (lower-case letters, digits and -, not memory)", e.Name)
	}
	switch e.Query {
	case "":
		e.Query = QueryOff
	case QueryOff, QueryRead, QueryWrite:
	default:
		return e, fmt.Errorf("DB_QUERY %q: off, read or write", e.Query)
	}
	var err error
	if e.QueryTimeout, err = envDuration(getenv, "DB_QUERY_TIMEOUT", 10*time.Second); err != nil {
		return e, err
	}
	if e.QueryRows, err = envInt(getenv, "DB_QUERY_ROWS", 1000); err != nil {
		return e, err
	}
	if e.QueryBytes, err = envInt(getenv, "DB_QUERY_BYTES", 1<<20); err != nil {
		return e, err
	}
	if e.QueryConcurrency, err = envInt(getenv, "DB_QUERY_CONCURRENCY", 2); err != nil {
		return e, err
	}
	return e, nil
}

func envInt(getenv func(string) string, name string, def int) (int, error) {
	v := strings.TrimSpace(getenv(name))
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s %q: a positive number", name, v)
	}
	return n, nil
}

func envDuration(getenv func(string) string, name string, def time.Duration) (time.Duration, error) {
	v := strings.TrimSpace(getenv(name))
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("%s %q: a duration such as 10s", name, v)
	}
	return d, nil
}
