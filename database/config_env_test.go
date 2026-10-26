package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A preset takes its endpoint and models from the environment, for an
// install configured from a .env: ${NAME} and
// ${NAME:-default}; a $ without braces stays; an unset variable without a
// default is refused, by name.
func TestLoadConfig_ExpandsVariables(t *testing.T) {
	preset := `# A comment may show ${NAME}, which stays as written.
description: from the environment
endpoint:
  base_url: ${EMBED_URL}
  api_key_env: EMBED_API_KEY
models:
  - id: ${EMBED_MODEL}
    name: ${EMBED_NAME:-embed}
    dims: ${EMBED_DIMS:-768}
    query_prefix: "costs $5: "
default_model: ${EMBED_NAME:-embed}
store:
  kind: sqlite
  url: ${SQLITE_PATH:-/data/vectors.db}
`
	path := filepath.Join(t.TempDir(), "preset.yaml")
	if err := os.WriteFile(path, []byte(preset), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("EMBED_URL", "http://llm:8080/v1")
	t.Setenv("EMBED_MODEL", "qwen3-embedding:8b")
	t.Setenv("EMBED_DIMS", "4096")
	c, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	m := c.Models[0]
	if c.Endpoint.BaseURL != "http://llm:8080/v1" || m.ID != "qwen3-embedding:8b" || m.Name != "embed" || m.Dims != 4096 ||
		c.DefaultModel != "embed" || m.QueryPrefix != "costs $5: " || c.Store.URL != "/data/vectors.db" {
		t.Errorf("config = %+v, model %+v", c, m)
	}
	t.Setenv("EMBED_URL", "")
	if _, err := LoadConfig(path); err == nil || !strings.Contains(err.Error(), "${EMBED_URL}") {
		t.Errorf("an unset variable: %v", err)
	}
}
