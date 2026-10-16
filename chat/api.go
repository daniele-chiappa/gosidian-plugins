package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// The API of a bot, for the widget and for sites:
//
//	GET  /api/bots/<bot>              its title, welcome, scopes, handoff and dates
//	POST /api/bots/<bot>/messages     {message, session, scopes, as_of} → the answer
//	POST /api/bots/<bot>/ratings      {session, turn, rating, comment}
//	POST /api/bots/<bot>/handoff      {session, message, contact} → the bot's reply
//	GET  /api/bots/<bot>/images/<id>  an image of an answer
//
// A request carries a token (Authorization: Bearer), or a site's key
// (X-Chat-Key) from one of its origins, or nothing where the bot is open;
// an image's address is its own key.

const maxBody = 64 << 10

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (p *Plugin) serveAPI(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/bots/")
	name, action, _ := strings.Cut(rest, "/")
	b, ok := p.bot(name)
	if !ok {
		writeError(w, http.StatusNotFound, "no such bot (or gosidian did not configure it yet)")
		return
	}
	if id, ok := strings.CutPrefix(action, "images/"); ok {
		p.serveImage(w, r, b.Name, id)
		return
	}
	cors(w, b, r.Header.Get("Origin"))
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	now := p.now()
	ip := clientIP(r, p.set.TrustProxy)
	caller, err := authorize(b, r, ip, now)
	if err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	switch {
	case action == "" && r.Method == http.MethodGet:
		p.info(w, b)
	case action == "messages" && r.Method == http.MethodPost:
		p.message(w, r, b, caller, now)
	case action == "ratings" && r.Method == http.MethodPost:
		p.rating(w, r, b, caller, now)
	case action == "handoff" && r.Method == http.MethodPost:
		p.handoff(w, r, b, caller, now)
	default:
		writeError(w, http.StatusNotFound, "GET /api/bots/<bot>, POST /api/bots/<bot>/messages, /ratings or /handoff")
	}
}

func (p *Plugin) info(w http.ResponseWriter, b *Bot) {
	labels := b.ScopeLabels
	if labels == nil {
		labels = []string{}
	}
	var handoff any
	if b.Handoff != nil {
		handoff = map[string]any{"label": b.Handoff.Label, "contact": b.Handoff.Contact}
	}
	writeJSON(w, http.StatusOK, map[string]any{"bot": b.Name, "title": b.Title, "welcome": b.Welcome, "scopes": scopeInfo(b.Scopes),
		"scope_labels": labels, "max_message": b.limit("max_message", p.set.MaxMessage), "handoff": handoff, "dates": b.Dates})
}

// scopeInfo are scopes as a client sees them: names, labels and children,
// never the filters.
func scopeInfo(scopes []Scope) []map[string]any {
	out := make([]map[string]any, 0, len(scopes))
	for _, sc := range scopes {
		m := map[string]any{"name": sc.Name, "label": sc.Label}
		if len(sc.Children) > 0 {
			m["children"] = scopeInfo(sc.Children)
		}
		out = append(out, m)
	}
	return out
}

// owner is who a conversation belongs to: the token's subject, or the
// key and the address, or the address.
func (c Caller) owner() string {
	switch c.Via {
	case "users", "signed":
		return c.Via + ":" + c.User
	case "key":
		return "key:" + c.Key + ":" + c.IP
	}
	return "open:" + c.IP
}

func decodeBody(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, maxBody))
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("the body is not the JSON expected: %v", err)
	}
	return nil
}

func (p *Plugin) message(w http.ResponseWriter, r *http.Request, b *Bot, c Caller, now time.Time) {
	var in struct {
		Message string   `json:"message"`
		Session string   `json:"session"`
		Scopes  []string `json:"scopes"`
		AsOf    string   `json:"as_of"`
	}
	if err := decodeBody(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	in.Message = strings.TrimSpace(in.Message)
	max := b.limit("max_message", p.set.MaxMessage)
	switch {
	case in.Message == "":
		writeError(w, http.StatusBadRequest, "message: the question")
		return
	case len([]rune(in.Message)) > max:
		writeError(w, http.StatusBadRequest, fmt.Sprintf("message: at most %d characters", max))
		return
	}
	if in.AsOf != "" {
		if _, err := time.Parse("2006-01-02", in.AsOf); err != nil || !b.Dates {
			writeError(w, http.StatusBadRequest, "as_of: a day, YYYY-MM-DD, for a bot that answers at a date")
			return
		}
	}
	// The scopes chosen among those the bot opens, at any depth; none
	// chosen, all of them (the first level, which holds the rest).
	chosen := in.Scopes
	if len(chosen) == 0 {
		for _, sc := range b.Scopes {
			chosen = append(chosen, sc.Name)
		}
	}
	scopes, filters := []string{}, []any{}
	seen := map[string]bool{}
	for _, name := range chosen {
		sc, ok := b.scope(name)
		if !ok {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("scope %q is not one the bot opens", name))
			return
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		scopes = append(scopes, sc.Name)
		if sc.Filter != nil {
			filters = append(filters, sc.Filter)
		} else {
			filters = append(filters, map[string]any{})
		}
	}
	if !p.limits.allow("ip:"+c.IP, p.set.IPPerMinute, now) {
		w.Header().Set("Retry-After", "60")
		writeError(w, http.StatusTooManyRequests, "too many messages from this address: wait a minute")
		return
	}
	se := p.sessions.Get(b.Name, in.Session, c.owner(), now)
	se.mu.Lock()
	defer se.mu.Unlock()
	if se.messages >= b.limit("per_session", p.set.PerSession) {
		writeError(w, http.StatusTooManyRequests, "this conversation reached its most messages: start another")
		return
	}
	if !p.limits.allow("session:"+se.ID, b.limit("per_minute", p.set.PerMinute), now) {
		w.Header().Set("Retry-After", "60")
		writeError(w, http.StatusTooManyRequests, "too many messages: wait a minute")
		return
	}
	history := append([]Turn{}, se.turns...)
	if n := 2 * p.set.MaxHistory; len(history) > n {
		history = history[len(history)-n:]
	}
	input := map[string]any{"kind": "message", "message": in.Message, "history": history, "scopes": scopes, "filters": filters,
		"session": se.ID, "user": c.User, "bot": b.Name, "note": b.Note}
	if t := b.limit("max_tokens", 0); t > 0 {
		input["max_tokens"] = t
	}
	if in.AsOf != "" {
		input["as_of"] = in.AsOf
	}
	answer, run, err := p.start(r.Context(), b, input, p.set.Wait)
	if err != nil {
		var se2 statusError
		if errors.As(err, &se2) {
			writeError(w, se2.status, se2.msg)
		} else {
			writeError(w, http.StatusBadGateway, "the bot could not answer")
		}
		p.log.Warn("message", "bot", b.Name, "run", run, "via", c.Via, "err", err)
		return
	}
	ans, _ := answer.(map[string]any)
	if ans == nil {
		ans = map[string]any{"text": fmt.Sprint(answer)}
	}
	turn, _ := ans["turn"].(string)
	if turn == "" {
		turn = run
	}
	ans["turn"] = turn
	p.sourceLinks(b, ans)
	text, _ := ans["text"].(string)
	se.turns = append(se.turns, Turn{Role: "user", Content: in.Message}, Turn{Role: "assistant", Content: text})
	if n := 2 * p.set.MaxHistory; len(se.turns) > n {
		se.turns = append([]Turn(nil), se.turns[len(se.turns)-n:]...)
	}
	se.answers[turn] = true
	se.messages++
	se.last.Store(now.UnixNano())
	writeJSON(w, http.StatusOK, map[string]any{"session": se.ID, "turn": turn, "answer": ans})
}

// sourceLinks gives each source of an answer with a doc the address of
// the document: under the bot's base_url, else the note in gosidian.
func (p *Plugin) sourceLinks(b *Bot, ans map[string]any) {
	list, _ := ans["sources"].([]any)
	for _, s := range list {
		m, _ := s.(map[string]any)
		doc, _ := m["doc"].(string)
		if m == nil || doc == "" || m["url"] != nil {
			continue
		}
		switch {
		case b.Sources.BaseURL != "":
			rel := strings.TrimSuffix(strings.TrimPrefix(doc, b.Project+"/"), ".md")
			m["url"] = strings.TrimRight(b.Sources.BaseURL, "/") + "/" + (&url.URL{Path: rel}).EscapedPath()
		case b.GosidianURL != "":
			m["url"] = b.GosidianURL + "/?w=note:" + url.QueryEscape(doc)
		}
	}
}

func (p *Plugin) rating(w http.ResponseWriter, r *http.Request, b *Bot, c Caller, now time.Time) {
	var in struct {
		Session string  `json:"session"`
		Turn    string  `json:"turn"`
		Rating  float64 `json:"rating"`
		Comment string  `json:"comment"`
	}
	if err := decodeBody(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if in.Rating != math.Trunc(in.Rating) || in.Rating < -10 || in.Rating > 10 {
		writeError(w, http.StatusBadRequest, "rating: a whole number from -10 to 10")
		return
	}
	if len([]rune(in.Comment)) > b.limit("max_message", p.set.MaxMessage) {
		writeError(w, http.StatusBadRequest, "comment: too long")
		return
	}
	se, ok := p.sessions.Find(b.Name, in.Session, c.owner(), now)
	if !ok {
		writeError(w, http.StatusNotFound, "no such conversation (or it expired)")
		return
	}
	se.mu.Lock()
	known := se.answers[in.Turn]
	se.mu.Unlock()
	if !known {
		writeError(w, http.StatusBadRequest, "turn: an answer of this conversation")
		return
	}
	if !p.limits.allow("session:"+se.ID, b.limit("per_minute", p.set.PerMinute), now) {
		w.Header().Set("Retry-After", "60")
		writeError(w, http.StatusTooManyRequests, "too many messages: wait a minute")
		return
	}
	input := map[string]any{"kind": "rating", "turn": in.Turn, "rating": int(in.Rating), "comment": strings.TrimSpace(in.Comment),
		"session": se.ID, "user": c.User, "bot": b.Name, "note": b.Note}
	if _, run, err := p.start(r.Context(), b, input, min(p.set.Wait, 15*time.Second)); err != nil {
		p.log.Warn("rating", "bot", b.Name, "run", run, "err", err)
		writeError(w, http.StatusBadGateway, "the rating did not reach the bot")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// maxContact caps how a person may be answered: an address, a number.
const maxContact = 200

// handoff asks for a person: the bot's pipeline gets the conversation
// (kind handoff), hands it on, and says what happens next.
func (p *Plugin) handoff(w http.ResponseWriter, r *http.Request, b *Bot, c Caller, now time.Time) {
	if b.Handoff == nil {
		writeError(w, http.StatusNotFound, "this bot hands no conversation to a person")
		return
	}
	var in struct {
		Session string `json:"session"`
		Message string `json:"message"`
		Contact string `json:"contact"`
	}
	if err := decodeBody(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	in.Message, in.Contact = strings.TrimSpace(in.Message), strings.TrimSpace(in.Contact)
	switch {
	case len([]rune(in.Message)) > b.limit("max_message", p.set.MaxMessage):
		writeError(w, http.StatusBadRequest, "message: too long")
		return
	case len([]rune(in.Contact)) > maxContact:
		writeError(w, http.StatusBadRequest, fmt.Sprintf("contact: at most %d characters", maxContact))
		return
	case !b.Handoff.Contact:
		in.Contact = ""
	}
	if !p.limits.allow("ip:"+c.IP, p.set.IPPerMinute, now) {
		w.Header().Set("Retry-After", "60")
		writeError(w, http.StatusTooManyRequests, "too many messages from this address: wait a minute")
		return
	}
	se := p.sessions.Get(b.Name, in.Session, c.owner(), now)
	se.mu.Lock()
	defer se.mu.Unlock()
	// One request a minute per conversation: a person, not a loop.
	if !p.limits.allow("handoff:"+se.ID, 1, now) {
		w.Header().Set("Retry-After", "60")
		writeError(w, http.StatusTooManyRequests, "the request is already on its way: wait a minute")
		return
	}
	history := append([]Turn{}, se.turns...)
	input := map[string]any{"kind": "handoff", "message": in.Message, "contact": in.Contact, "history": history,
		"session": se.ID, "user": c.User, "bot": b.Name, "note": b.Note}
	answer, run, err := p.start(r.Context(), b, input, p.set.Wait)
	if err != nil {
		p.log.Warn("handoff", "bot", b.Name, "run", run, "err", err)
		writeError(w, http.StatusBadGateway, "the request did not reach the bot")
		return
	}
	ans, _ := answer.(map[string]any)
	if ans == nil {
		ans = map[string]any{"text": fmt.Sprint(answer)}
	}
	se.last.Store(now.UnixNano())
	writeJSON(w, http.StatusOK, map[string]any{"session": se.ID, "answer": ans})
}

// statusError is a failure the client is told as it is, with its status.
type statusError struct {
	status int
	msg    string
}

func (e statusError) Error() string { return strconv.Itoa(e.status) + " " + e.msg }

// start starts the bot's pipeline with its run token and waits for its
// answer: the output of the node the pipeline names as its answer.
func (p *Plugin) start(ctx context.Context, b *Bot, input map[string]any, wait time.Duration) (any, string, error) {
	body, err := json.Marshal(map[string]any{"input": input, "wait": int(wait / time.Second)})
	if err != nil {
		return nil, "", err
	}
	cctx, cancel := context.WithTimeout(ctx, wait+15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodPost, b.Run.URL, bytes.NewReader(body))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+b.Run.Token)
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, "", err
	}
	var out struct {
		Run struct {
			ID     string `json:"id"`
			Status string `json:"status"`
			Error  string `json:"error"`
		} `json:"run"`
		Answer any `json:"answer"`
		Error  struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &out)
	switch {
	case resp.StatusCode == http.StatusTooManyRequests:
		return nil, "", statusError{http.StatusTooManyRequests, "the bot is busy: try again in a minute"}
	case resp.StatusCode == http.StatusAccepted:
		return nil, out.Run.ID, statusError{http.StatusGatewayTimeout, "the answer takes too long: try again"}
	case resp.StatusCode != http.StatusOK:
		return nil, out.Run.ID, fmt.Errorf("gosidian answered %s: %s", resp.Status, out.Error.Message)
	case out.Run.Status != "done":
		return nil, out.Run.ID, fmt.Errorf("the run ended %s: %s", out.Run.Status, out.Run.Error)
	}
	return out.Answer, out.Run.ID, nil
}
