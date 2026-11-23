package main

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// Settings are the plugin's, from its environment.
type Settings struct {
	// Name is the one gosidian registers the plugin with (OFFICE_NAME,
	// default office).
	Name string
	// PublicURL is the address the browsers reach the plugin at
	// (OFFICE_PUBLIC_URL): gosidian's windows open the page from it.
	PublicURL string
	// AltURLs are other addresses of the plugin (OFFICE_ALT_URLS,
	// comma-separated), for browsers that reach gosidian another way, a
	// tunnel say: the window opens the one on the host gosidian was opened at.
	AltURLs []string
	// Token is the one gosidian calls /mcp with (GOSIDIAN_PLUGIN_TOKEN).
	Token string
	// SiteDir holds the page's build (OFFICE_SITE_DIR, default
	// /usr/share/gosidian-office/site).
	SiteDir string
	// LicensesDir holds the licenses the image keeps, which the
	// references' page reads (OFFICE_LICENSES_DIR, default /licenses).
	LicensesDir string
	// FrameAncestors are gosidian's origins, the only pages that may show
	// the office in a frame (OFFICE_FRAME_ANCESTORS, comma-separated).
	FrameAncestors []string
}

var pluginName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

// address reads an address the browsers reach the plugin at: http or
// https, a host, no query, no fragment, no credentials.
func address(v string) (string, bool) {
	v = strings.TrimRight(strings.TrimSpace(v), "/")
	u, err := url.Parse(v)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil ||
		u.RawQuery != "" || u.Fragment != "" || strings.HasSuffix(v, "?") || strings.HasSuffix(v, "#") {
		return v, false
	}
	return v, true
}

// LoadSettings reads the environment.
func LoadSettings(getenv func(string) string) (Settings, error) {
	s := Settings{Name: getenv("OFFICE_NAME"), Token: getenv("GOSIDIAN_PLUGIN_TOKEN"),
		SiteDir: getenv("OFFICE_SITE_DIR"), LicensesDir: getenv("OFFICE_LICENSES_DIR")}
	if s.Name == "" {
		s.Name = "office"
	}
	if !pluginName.MatchString(s.Name) || s.Name == "memory" {
		return s, fmt.Errorf("OFFICE_NAME %q: the name gosidian registers the plugin with (lower-case letters, digits and -)", s.Name)
	}
	pub, ok := address(getenv("OFFICE_PUBLIC_URL"))
	if !ok {
		return s, fmt.Errorf("OFFICE_PUBLIC_URL %q: the address the browsers reach the plugin at, https://office.example.com", pub)
	}
	s.PublicURL = pub
	for _, o := range strings.Split(getenv("OFFICE_ALT_URLS"), ",") {
		if strings.TrimSpace(o) == "" {
			continue
		}
		alt, ok := address(o)
		if !ok {
			return s, fmt.Errorf("OFFICE_ALT_URLS: %q is no address (https://office.example.com)", alt)
		}
		s.AltURLs = append(s.AltURLs, alt)
	}
	if len(s.AltURLs) > 4 {
		return s, errors.New("OFFICE_ALT_URLS: at most 4 other addresses, as gosidian takes them")
	}
	if s.SiteDir == "" {
		s.SiteDir = "/usr/share/gosidian-office/site"
	}
	if s.LicensesDir == "" {
		s.LicensesDir = "/licenses"
	}
	for _, o := range strings.Split(getenv("OFFICE_FRAME_ANCESTORS"), ",") {
		o = strings.TrimRight(strings.TrimSpace(o), "/")
		if o == "" {
			continue
		}
		u, err := url.Parse(o)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Path != "" || u.User != nil ||
			u.RawQuery != "" || strings.ContainsAny(o, " ;,'\"?#") {
			return s, fmt.Errorf("OFFICE_FRAME_ANCESTORS: %q is no origin (https://vault.example.com)", o)
		}
		s.FrameAncestors = append(s.FrameAncestors, u.Scheme+"://"+u.Host)
	}
	if len(s.FrameAncestors) == 0 {
		return s, errors.New("OFFICE_FRAME_ANCESTORS: gosidian's address, the only page that may show the office in a frame")
	}
	return s, nil
}
