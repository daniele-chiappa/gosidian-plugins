package main

import (
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
// embeddings and its models, the store that keeps the vectors, the
// limits of a call. The secrets are not in it: they come from the
// environment (Env).
type Config struct {
	Description  string      `yaml:"description"`
	Endpoint     Endpoint    `yaml:"endpoint"`
	Models       []Model     `yaml:"models"`
	DefaultModel string      `yaml:"default_model"`
	Store        StoreConfig `yaml:"store"`
	Limits       Limits      `yaml:"limits"`
}

// Endpoint is an OpenAI-compatible API with /embeddings: Ollama, a
// llama-server, OpenRouter.
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

// Size is the size of the vectors a collection of the model keeps.
func (m Model) Size() int {
	if m.Dimensions > 0 {
		return m.Dimensions
	}
	return m.Dims
}

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
}

// Limits cap a call.
type Limits struct {
	MaxItems int `yaml:"max_items"` // chunks per upsert, get or delete
	MaxText  int `yaml:"max_text"`  // characters of a chunk's text
	MaxK     int `yaml:"max_k"`     // results per question
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

// LoadConfig reads a preset and checks it.
func LoadConfig(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	dec := yaml.NewDecoder(strings.NewReader(string(b)))
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
	if c.Limits.MaxText <= 0 {
		c.Limits.MaxText = 32 << 10
	}
	if c.Limits.MaxK <= 0 {
		c.Limits.MaxK = 100
	}
	if c.Endpoint.Timeout <= 0 {
		c.Endpoint.Timeout = Duration(2 * time.Minute)
	}
	return nil
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

// Hosts are the hosts the plugin calls: the endpoint's and the store's.
func (c *Config) Hosts() []string {
	var out []string
	for _, raw := range []string{c.Endpoint.BaseURL, c.Store.URL} {
		if u, err := url.Parse(raw); err == nil && u.Hostname() != "" {
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
