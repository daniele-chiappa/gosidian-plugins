package main

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"sync/atomic"
	"time"
)

// Turn is one exchange of a conversation, as the pipeline gets it.
type Turn struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Session is a conversation with a bot: its turns, the answers it may
// rate, and how much it chatted. The plugin keeps it, not the page: a
// client cannot write the bot's turns.
type Session struct {
	ID    string
	Bot   string
	Owner string // who opened it: the token's subject, the key, or the address
	// mu is held while a message waits for its answer: one at a time.
	mu    sync.Mutex
	turns []Turn
	// answers are the ids of the answers given, which a rating names.
	answers  map[string]bool
	messages int
	// last is the time of the last message, in nanoseconds: read without
	// mu, which a message holds while it waits.
	last atomic.Int64
}

// Sessions are the open conversations, at most max, each dropped ttl
// after its last message.
type Sessions struct {
	mu  sync.Mutex
	m   map[string]*Session
	ttl time.Duration
	max int
}

func NewSessions(ttl time.Duration, max int) *Sessions {
	return &Sessions{m: map[string]*Session{}, ttl: ttl, max: max}
}

func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// Get finds the conversation id of the bot for its owner, or opens a new
// one (id empty, unknown, expired, or someone else's).
func (s *Sessions) Get(bot, id, owner string, now time.Time) *Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id != "" {
		if se, ok := s.m[id]; ok && se.Bot == bot && se.Owner == owner && now.Sub(se.lastSeen()) < s.ttl {
			return se
		}
	}
	s.prune(now)
	se := &Session{ID: newID(), Bot: bot, Owner: owner, answers: map[string]bool{}}
	se.last.Store(now.UnixNano())
	s.m[se.ID] = se
	return se
}

// Find is an open conversation of the bot for its owner, without opening
// one.
func (s *Sessions) Find(bot, id, owner string, now time.Time) (*Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	se, ok := s.m[id]
	if !ok || se.Bot != bot || se.Owner != owner || now.Sub(se.lastSeen()) >= s.ttl {
		return nil, false
	}
	return se, true
}

// DropBot forgets the conversations of a bot taken out.
func (s *Sessions) DropBot(bot string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, se := range s.m {
		if se.Bot == bot {
			delete(s.m, id)
		}
	}
}

// prune drops the expired conversations, and the oldest over max. Called
// with s.mu held.
func (s *Sessions) prune(now time.Time) {
	for id, se := range s.m {
		if now.Sub(se.lastSeen()) >= s.ttl {
			delete(s.m, id)
		}
	}
	for len(s.m) >= s.max {
		var oldest *Session
		for _, se := range s.m {
			if oldest == nil || se.lastSeen().Before(oldest.lastSeen()) {
				oldest = se
			}
		}
		delete(s.m, oldest.ID)
	}
}

func (se *Session) lastSeen() time.Time { return time.Unix(0, se.last.Load()) }

// window counts events in the last minute, per key.
type window struct {
	mu sync.Mutex
	m  map[string][]time.Time
}

func newWindow() *window { return &window{m: map[string][]time.Time{}} }

// allow records an event of key at now when fewer than max happened in
// the minute before.
func (w *window) allow(key string, max int, now time.Time) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	cut := now.Add(-time.Minute)
	ts := w.m[key][:0]
	for _, t := range w.m[key] {
		if t.After(cut) {
			ts = append(ts, t)
		}
	}
	if len(ts) >= max {
		w.m[key] = ts
		return false
	}
	w.m[key] = append(ts, now)
	if len(w.m) > 100000 {
		// Many addresses: forget those quiet for a minute.
		for k, v := range w.m {
			if len(v) == 0 || !v[len(v)-1].After(cut) {
				delete(w.m, k)
			}
		}
	}
	return true
}
