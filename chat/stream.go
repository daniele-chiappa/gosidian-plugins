package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// The answer as it comes: a widget that asks for
// text/event-stream gets the text of the bot's pipeline as the model
// writes it (delta, and reset when it starts over), then the answer as the
// JSON answer has it (answer), or an error (error). gosidian streams the
// text of its llm.chat nodes with stream: true; a pipeline without one
// gives the answer only, and a gosidian that answers JSON as well.

func wantsEvents(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept"), "text/event-stream")
}

// eventWriter sends a widget the events of its message.
type eventWriter struct {
	w  http.ResponseWriter
	rc *http.ResponseController
}

func newEventWriter(w http.ResponseWriter) *eventWriter {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	// No buffering on the way, nginx's own switch.
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	e := &eventWriter{w: w, rc: http.NewResponseController(w)}
	e.comment("open")
	return e
}

func (e *eventWriter) send(event string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(e.w, "event: %s\ndata: %s\n\n", event, b)
	_ = e.rc.Flush()
}

func (e *eventWriter) comment(text string) {
	_, _ = io.WriteString(e.w, ": "+text+"\n\n")
	_ = e.rc.Flush()
}

// relay passes the text of the run on: only the text, nothing of the
// pipeline's nodes or runs.
func (e *eventWriter) relay(kind, text string) {
	switch kind {
	case "delta":
		e.send("delta", map[string]string{"text": text})
	case "reset":
		e.send("reset", map[string]any{})
	default:
		e.comment("heartbeat")
	}
}

// startStream starts the bot's pipeline as start does, asking for its
// events: relay gets each piece of text (delta), a start over (reset) and
// the heartbeats (""), and the answer comes back as start gives it.
func (p *Plugin) startStream(ctx context.Context, b *Bot, input map[string]any, wait time.Duration, relay func(kind, text string)) (any, string, error) {
	cctx, cancel := context.WithTimeout(ctx, wait+15*time.Second)
	defer cancel()
	resp, err := p.post(cctx, b, input, wait, "text/event-stream")
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		// An error before the run started, or a gosidian with no streams.
		return readReply(resp)
	}
	run, part := "", ""
	var event string
	var data strings.Builder
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 8<<20)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
		case strings.HasPrefix(line, ":"):
			relay("", "")
			continue
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			continue
		case strings.HasPrefix(line, "data:"):
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			continue
		default:
			continue
		}
		kind, raw := event, data.String()
		event = ""
		data.Reset()
		switch kind {
		case "run":
			var ev runReply
			_ = json.Unmarshal([]byte(raw), &ev)
			run = ev.Run.ID
		case "delta", "reset":
			var ev struct {
				Run   string `json:"run"`
				Node  string `json:"node"`
				Index *int   `json:"index"`
				Text  string `json:"text"`
			}
			if json.Unmarshal([]byte(raw), &ev) != nil {
				continue
			}
			key := ev.Run + "/" + ev.Node
			if ev.Index != nil {
				key += "/" + strconv.Itoa(*ev.Index)
			}
			switch {
			case kind == "reset":
				if key == part {
					relay("reset", "")
				}
				continue
			case key != part:
				// Another node writes: its text takes the place of the
				// one before.
				if part != "" {
					relay("reset", "")
				}
				part = key
			}
			relay("delta", ev.Text)
		case "answer":
			var out runReply
			if err := json.Unmarshal([]byte(raw), &out); err != nil {
				return nil, run, fmt.Errorf("the answer is not JSON: %w", err)
			}
			if out.Status == 0 {
				out.Status = http.StatusOK
			}
			return out.outcome(out.Status)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, run, fmt.Errorf("reading gosidian's events: %w", err)
	}
	return nil, run, errors.New("gosidian's events ended before the answer")
}
