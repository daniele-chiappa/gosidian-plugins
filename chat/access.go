package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

// Caller is who sends a request: how they got in, and who they are.
type Caller struct {
	// Via is users (a token gosidian signed), signed (a token the site
	// signed), key (a site's key, from its origin) or open.
	Via string
	// User is the token's subject; empty for a key or open.
	User string
	// Key is the name of the site's key.
	Key string
	// Origin is the page's origin, when the browser sent one.
	Origin string
	IP     string
}

// errDenied is a request the bot does not take; its message says why, in
// terms a site's developer can act on.
type errDenied struct{ msg string }

func (e errDenied) Error() string { return e.msg }

// authorize says who calls the bot, from the request: a bearer token, a
// key from its origin, or nothing where the bot is open.
func authorize(b *Bot, r *http.Request, ip string, now time.Time) (Caller, error) {
	c := Caller{Origin: r.Header.Get("Origin"), IP: ip}
	if tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok && tok != "" {
		claims, via, err := checkToken(b, tok, now)
		if err != nil {
			return c, err
		}
		c.Via, c.User = via, claims.Sub
		return c, nil
	}
	if key := r.Header.Get("X-Chat-Key"); key != "" {
		for _, k := range b.Access.Keys {
			if subtle.ConstantTimeCompare([]byte(key), []byte(k.Key)) != 1 {
				continue
			}
			if !originAllowed(k.Origins, c.Origin) {
				return c, errDenied{fmt.Sprintf("the key %s does not work from %q", k.Name, c.Origin)}
			}
			c.Via, c.Key = "key", k.Name
			return c, nil
		}
		return c, errDenied{"no such key"}
	}
	if b.Access.Open {
		c.Via = "open"
		return c, nil
	}
	return c, errDenied{"the bot wants a token or a key"}
}

func originAllowed(origins []string, origin string) bool {
	if origin == "" {
		return false
	}
	for _, o := range origins {
		if strings.EqualFold(strings.TrimRight(o, "/"), origin) {
			return true
		}
	}
	return false
}

// claims are those of a chat token (gosidian's docs/chat.md).
type claims struct {
	Iss string `json:"iss"`
	Sub string `json:"sub"`
	Bot string `json:"bot"`
	Exp int64  `json:"exp"`
	Iat int64  `json:"iat"`
}

// checkToken checks a JWT (HS256) against the bot's secrets: gosidian's
// users secret for iss gosidian, the site's otherwise. It must name the
// bot and not be expired.
func checkToken(b *Bot, tok string, now time.Time) (claims, string, error) {
	var c claims
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return c, "", errDenied{"the token is no JWT"}
	}
	head, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return c, "", errDenied{"the token's header does not read"}
	}
	var h struct {
		Alg string `json:"alg"`
	}
	if json.Unmarshal(head, &h) != nil || h.Alg != "HS256" {
		return c, "", errDenied{"the token is not signed with HS256"}
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || json.Unmarshal(body, &c) != nil {
		return c, "", errDenied{"the token's claims do not read"}
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return c, "", errDenied{"the token's signature does not read"}
	}
	secret, via := b.Access.SignedSecret, "signed"
	if c.Iss == "gosidian" {
		secret, via = b.Access.UsersSecret, "users"
		if !b.Access.Users {
			return c, "", errDenied{"the bot does not take gosidian's users"}
		}
	}
	if secret == "" {
		return c, "", errDenied{"the bot takes no signed tokens"}
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return c, "", errDenied{"the token's signature does not check"}
	}
	switch {
	case c.Bot != b.Name:
		return c, "", errDenied{"the token is for another bot"}
	case c.Exp == 0 || now.Unix() >= c.Exp:
		return c, "", errDenied{"the token expired"}
	case len(c.Sub) > 200:
		return c, "", errDenied{"the token's subject is too long"}
	}
	return c, via, nil
}

// clientIP is the address a request comes from: the last hop's, or the
// first of X-Forwarded-For behind a proxy the settings trust.
func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			first, _, _ := strings.Cut(xff, ",")
			if ip := net.ParseIP(strings.TrimSpace(first)); ip != nil {
				return ip.String()
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// cors answers the cross-origin headers of a bot's API: the origin of a
// key, any origin with a token (the token is the proof) or where the bot
// is open. A page of the plugin itself needs none.
func cors(w http.ResponseWriter, b *Bot, origin string) {
	if origin == "" {
		return
	}
	allowed := b.Access.Open || b.Access.Users || b.Access.SignedSecret != ""
	for _, k := range b.Access.Keys {
		if originAllowed(k.Origins, origin) {
			allowed = true
		}
	}
	if !allowed {
		return
	}
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", origin)
	h.Add("Vary", "Origin")
	h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Chat-Key")
	h.Set("Access-Control-Max-Age", "600")
}

var errNoBot = errors.New("no such bot")
