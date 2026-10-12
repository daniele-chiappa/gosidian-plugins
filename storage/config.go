package main

import (
	"bytes"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"

	"go.yaml.in/yaml/v3"
)

// Config is storage.yaml: the sources the plugin offers.
type Config struct {
	Sources []SourceConfig `yaml:"sources"`
}

// SourceConfig is a source: an archive the plugin reads, with its
// credentials in a file of their own, which never leave the plugin.
type SourceConfig struct {
	// Name is the source's name in the manifest, as gosidian binds it.
	Name        string `yaml:"name"`
	Kind        string `yaml:"kind"`
	Description string `yaml:"description"`
	// URL is a WebDAV source's folder, Vendor its server (nextcloud,
	// owncloud, sharepoint, fastmail, other).
	URL    string `yaml:"url"`
	Vendor string `yaml:"vendor"`
	// Credentials is a file: for WebDAV, two lines, the user then the
	// password; for S3, the access key then the secret; for Drive, the
	// JSON key of a service account.
	Credentials string `yaml:"credentials"`
	// Path is a local source's folder, on the plugin's disk.
	Path string `yaml:"path"`
	// S3: the provider (AWS, Cloudflare, Wasabi, Ceph, Other…), the
	// endpoint (empty for AWS), the region, the bucket and the prefix
	// inside it (the source's root), path-style addressing, and whether
	// open gives a presigned URL of S3 (the default) or one of the plugin.
	Provider  string `yaml:"provider"`
	Endpoint  string `yaml:"endpoint"`
	Region    string `yaml:"region"`
	Bucket    string `yaml:"bucket"`
	Prefix    string `yaml:"prefix"`
	PathStyle bool   `yaml:"path_style"`
	Presign   *bool  `yaml:"presign"`
	// Drive: the folder shared with the service account, or a shared
	// drive's ID.
	RootFolderID string `yaml:"root_folder_id"`
	TeamDrive    string `yaml:"team_drive"`
	// Move lets gosidian move the source's files inside it.
	Move bool `yaml:"move"`
}

// Presigned says whether a file of an S3 source is read from a presigned
// URL of S3, not through the plugin.
func (s SourceConfig) Presigned() bool {
	return s.Kind == KindS3 && (s.Presign == nil || *s.Presign)
}

// The kinds of source.
const (
	KindWebDAV = "webdav"
	KindLocal  = "local"
	KindS3     = "s3"
	KindDrive  = "drive"
)

var (
	sourceName = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
	vendors    = []string{"nextcloud", "owncloud", "sharepoint", "sharepoint-ntlm", "fastmail", "rclone", "infinitescale", "other"}
)

// LoadConfig reads and checks storage.yaml.
func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	var c Config
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if err := c.check(); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &c, nil
}

func (c *Config) check() error {
	if len(c.Sources) == 0 {
		return errors.New("no sources")
	}
	if len(c.Sources) > 32 {
		return fmt.Errorf("%d sources, at most 32", len(c.Sources))
	}
	seen := map[string]bool{}
	for i := range c.Sources {
		s := &c.Sources[i]
		if !sourceName.MatchString(s.Name) {
			return fmt.Errorf("source %q: a name of lower-case letters, digits and _, starting with a letter", s.Name)
		}
		if seen[s.Name] {
			return fmt.Errorf("source %q twice", s.Name)
		}
		seen[s.Name] = true
		switch s.Kind {
		case KindWebDAV:
			u, err := url.Parse(s.URL)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
				return fmt.Errorf("source %s: url %q is not an http(s) address", s.Name, s.URL)
			}
			if u.User != nil {
				return fmt.Errorf("source %s: the url carries credentials; they go in the credentials file", s.Name)
			}
			if s.Vendor == "" {
				s.Vendor = "other"
			}
			if !slices.Contains(vendors, s.Vendor) {
				return fmt.Errorf("source %s: vendor %q: one of %s", s.Name, s.Vendor, strings.Join(vendors, ", "))
			}
			if s.Credentials == "" {
				return fmt.Errorf("source %s: credentials names the file of its user and password", s.Name)
			}
		case KindLocal:
			if s.Path == "" || !strings.HasPrefix(s.Path, "/") {
				return fmt.Errorf("source %s: path is the folder, an absolute path", s.Name)
			}
		case KindS3:
			if s.Bucket == "" || strings.ContainsAny(s.Bucket, "/ ") {
				return fmt.Errorf("source %s: bucket names the bucket", s.Name)
			}
			if s.Endpoint != "" {
				u, err := url.Parse(s.Endpoint)
				if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
					return fmt.Errorf("source %s: endpoint %q is not an http(s) address", s.Name, s.Endpoint)
				}
			} else if s.Region == "" {
				return fmt.Errorf("source %s: an S3 of AWS wants its region (or an endpoint for another S3)", s.Name)
			}
			s.Prefix = strings.Trim(s.Prefix, "/")
			if s.Provider == "" {
				s.Provider = "Other"
				if s.Endpoint == "" {
					s.Provider = "AWS"
				}
			}
			if s.Credentials == "" {
				return fmt.Errorf("source %s: credentials names the file of its access key and secret", s.Name)
			}
		case KindDrive:
			if s.Credentials == "" {
				return fmt.Errorf("source %s: credentials names the JSON key of its service account", s.Name)
			}
			if (s.RootFolderID == "") == (s.TeamDrive == "") {
				return fmt.Errorf("source %s: root_folder_id (a folder shared with the service account) or team_drive (a shared drive), one of them", s.Name)
			}
		default:
			return fmt.Errorf("source %s: kind %q: webdav, s3, drive or local", s.Name, s.Kind)
		}
	}
	return nil
}

// Hosts are the hosts the plugin itself calls, for the manifest's
// permissions.network: those of its WebDAV and S3 sources, and Google's
// for Drive.
func (c *Config) Hosts() []string {
	var out []string
	add := func(h string) {
		if h != "" && !slices.Contains(out, h) {
			out = append(out, h)
		}
	}
	for _, s := range c.Sources {
		switch s.Kind {
		case KindWebDAV:
			if u, err := url.Parse(s.URL); err == nil {
				add(u.Host)
			}
		case KindS3:
			add(s.s3Host(false))
		case KindDrive:
			add("www.googleapis.com")
			add("oauth2.googleapis.com")
			add("docs.google.com")
		}
	}
	return out
}

// FileHosts are the hosts the URLs of the sources' files point at besides
// the plugin itself, for the manifest's permissions.source_hosts: S3's,
// for the presigned URLs.
func (c *Config) FileHosts() []string {
	var out []string
	for _, s := range c.Sources {
		if h := s.s3Host(true); s.Presigned() && h != "" && !slices.Contains(out, h) {
			out = append(out, h)
		}
	}
	return out
}

// s3Host is the host an S3 source is reached at; for a file, with the
// bucket in the host when the addressing is virtual-hosted.
func (s SourceConfig) s3Host(file bool) string {
	if s.Kind != KindS3 {
		return ""
	}
	host := "s3." + s.Region + ".amazonaws.com"
	if s.Endpoint != "" {
		u, err := url.Parse(s.Endpoint)
		if err != nil {
			return ""
		}
		host = u.Host
	}
	if file && !s.PathStyle {
		return s.Bucket + "." + host
	}
	return host
}

// readCredentials reads a credentials file of two lines: the user (or the
// access key) on the first, the password (or the secret) on the second.
func readCredentials(path string) (user, pass string, err error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", fmt.Errorf("the credentials file: %w", err)
	}
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	if len(lines) < 2 || strings.TrimSpace(lines[0]) == "" || lines[1] == "" {
		return "", "", errors.New("the credentials file has not the user and the password on two lines")
	}
	return strings.TrimSpace(lines[0]), strings.TrimRight(lines[1], " \t"), nil
}
