package main

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Settings are the plugin's own, from the environment (CHAT_*): the
// defaults a bot's limits replace, and the caps no bot goes over.
type Settings struct {
	// Name is the name gosidian registers the plugin with (CHAT_NAME).
	Name string
	// PublicURL is the plugin's address on the internet (CHAT_PUBLIC_URL):
	// the addresses of the widget and of the bots' pages start with it.
	PublicURL string
	// Token is gosidian's bearer token for /mcp (GOSIDIAN_PLUGIN_TOKEN).
	Token string
	// Wait is how long a message waits for its answer (CHAT_WAIT); gosidian
	// waits at most its [pipelines] max_sync_wait.
	Wait time.Duration
	// SessionTTL is how long a conversation is kept after its last message
	// (CHAT_SESSION_TTL); MaxSessions caps them (CHAT_MAX_SESSIONS).
	SessionTTL  time.Duration
	MaxSessions int
	// MaxHistory are the turns of a conversation handed to the pipeline
	// (CHAT_MAX_HISTORY).
	MaxHistory int
	// The defaults of a bot's limits: messages a minute and in all of one
	// conversation, characters of a message (CHAT_PER_MINUTE,
	// CHAT_PER_SESSION, CHAT_MAX_MESSAGE).
	PerMinute  int
	PerSession int
	MaxMessage int
	// IPPerMinute caps the messages of one address a minute, all bots
	// together (CHAT_IP_PER_MINUTE).
	IPPerMinute int
	// TrustProxy reads the client's address from X-Forwarded-For, behind a
	// proxy that sets it (CHAT_TRUST_PROXY).
	TrustProxy bool
	// WidgetDir holds chat.js (CHAT_WIDGET_DIR).
	WidgetDir string
	// FrameAncestors are origins besides gosidian's public address that may
	// show the bots' pages in a frame (CHAT_FRAME_ANCESTORS, comma-separated):
	// gosidian reached at another address, through a tunnel or a second
	// name.
	FrameAncestors []string
}

var pluginName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

// LoadSettings reads the environment.
func LoadSettings(getenv func(string) string) (Settings, error) {
	s := Settings{Name: getenv("CHAT_NAME"), PublicURL: strings.TrimRight(getenv("CHAT_PUBLIC_URL"), "/"),
		Token: getenv("GOSIDIAN_PLUGIN_TOKEN"), WidgetDir: getenv("CHAT_WIDGET_DIR")}
	if s.Name == "" {
		s.Name = "chat"
	}
	if !pluginName.MatchString(s.Name) || s.Name == "memory" {
		return s, fmt.Errorf("CHAT_NAME %q: the name gosidian registers the plugin with (lower-case letters, digits and -)", s.Name)
	}
	u, err := url.Parse(s.PublicURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.RawQuery != "" {
		return s, fmt.Errorf("CHAT_PUBLIC_URL %q: the plugin's address on the internet, https://chat.example.com", s.PublicURL)
	}
	if s.WidgetDir == "" {
		s.WidgetDir = "/usr/share/gosidian-chat"
	}
	for _, d := range []struct {
		name string
		dst  *time.Duration
		def  time.Duration
	}{{"CHAT_WAIT", &s.Wait, 60 * time.Second}, {"CHAT_SESSION_TTL", &s.SessionTTL, time.Hour}} {
		if *d.dst, err = envDuration(getenv, d.name, d.def); err != nil {
			return s, err
		}
	}
	for _, n := range []struct {
		name string
		dst  *int
		def  int
	}{{"CHAT_MAX_SESSIONS", &s.MaxSessions, 10000}, {"CHAT_MAX_HISTORY", &s.MaxHistory, 10},
		{"CHAT_PER_MINUTE", &s.PerMinute, 10}, {"CHAT_PER_SESSION", &s.PerSession, 200},
		{"CHAT_MAX_MESSAGE", &s.MaxMessage, 2000}, {"CHAT_IP_PER_MINUTE", &s.IPPerMinute, 60}} {
		if *n.dst, err = envInt(getenv, n.name, n.def); err != nil {
			return s, err
		}
	}
	for _, o := range strings.Split(getenv("CHAT_FRAME_ANCESTORS"), ",") {
		o = strings.TrimRight(strings.TrimSpace(o), "/")
		if o == "" {
			continue
		}
		u, err := url.Parse(o)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Path != "" || strings.ContainsAny(o, " ;'\"") {
			return s, fmt.Errorf("CHAT_FRAME_ANCESTORS: %q is no origin (https://vault.example.com)", o)
		}
		s.FrameAncestors = append(s.FrameAncestors, u.Scheme+"://"+u.Host)
	}
	switch strings.ToLower(getenv("CHAT_TRUST_PROXY")) {
	case "", "0", "false", "no":
	case "1", "true", "yes":
		s.TrustProxy = true
	default:
		return s, errors.New("CHAT_TRUST_PROXY: true or false")
	}
	return s, nil
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
		return 0, fmt.Errorf("%s %q: a duration such as 60s", name, v)
	}
	return d, nil
}

// Bot is a bot as gosidian configures it (chat_configure, gosidian's
// docs/chat.md).
type Bot struct {
	Name    string  `json:"bot"`
	Note    string  `json:"note"`
	Project string  `json:"project"`
	Title   string  `json:"title"`
	Welcome string  `json:"welcome"`
	Scopes  []Scope `json:"scopes"`
	Access  Access  `json:"access"`
	Run     Run     `json:"run"`
	Sources struct {
		BaseURL     string `json:"base_url"`
		GosidianURL string `json:"gosidian_url"`
	} `json:"sources"`
	Limits      map[string]int `json:"limits"`
	GosidianURL string         `json:"gosidian_url"`
}

// Scope is a part of the archive the bot opens.
type Scope struct {
	Name   string         `json:"name"`
	Label  string         `json:"label"`
	Filter map[string]any `json:"filter,omitempty"`
}

// Access says who may chat: gosidian's users with the tokens it signs
// (UsersSecret), the sites' keys from their origins, the users of a site
// with the tokens it signs (SignedSecret), anyone.
type Access struct {
	Users        bool   `json:"users"`
	UsersSecret  string `json:"users_secret"`
	Keys         []Key  `json:"keys"`
	SignedSecret string `json:"signed_secret"`
	Open         bool   `json:"open"`
}

// Key is a site's public key, good from its origins only.
type Key struct {
	Name    string   `json:"name"`
	Key     string   `json:"key"`
	Origins []string `json:"origins"`
}

// Run is where the bot's pipeline starts: the address and the run token.
type Run struct {
	URL      string `json:"url"`
	Token    string `json:"token"`
	Pipeline string `json:"pipeline"`
}

var botName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,47}$`)

// check checks a bot gosidian hands over.
func (b *Bot) check() error {
	switch {
	case !botName.MatchString(b.Name):
		return fmt.Errorf("bot %q: lower-case letters, digits and -", b.Name)
	case b.Run.URL == "" || b.Run.Token == "":
		return errors.New("run: the address and the token that start the bot's pipeline")
	case b.Access.Users && b.Access.UsersSecret == "":
		return errors.New("access.users without users_secret")
	case !b.Access.Users && !b.Access.Open && len(b.Access.Keys) == 0 && b.Access.SignedSecret == "":
		return errors.New("access: nobody may chat")
	}
	if u, err := url.Parse(b.Run.URL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("run.url %q is not an http(s) address", b.Run.URL)
	}
	seen := map[string]bool{}
	for _, sc := range b.Scopes {
		if !botName.MatchString(sc.Name) || seen[sc.Name] {
			return fmt.Errorf("scope %q: a name, once", sc.Name)
		}
		seen[sc.Name] = true
	}
	for _, k := range b.Access.Keys {
		if k.Key == "" || len(k.Origins) == 0 {
			return fmt.Errorf("key %q: its value and its origins", k.Name)
		}
	}
	for k, v := range b.Limits {
		if v < 0 {
			return fmt.Errorf("limits.%s: 0 or more", k)
		}
	}
	return nil
}

// limit is a bot's limit, else the plugin's default; 0 in the note keeps
// the default.
func (b *Bot) limit(name string, def int) int {
	if v, ok := b.Limits[name]; ok && v > 0 {
		return v
	}
	return def
}

// scope finds a scope the bot opens.
func (b *Bot) scope(name string) (Scope, bool) {
	for _, sc := range b.Scopes {
		if sc.Name == name {
			return sc, true
		}
	}
	return Scope{}, false
}
