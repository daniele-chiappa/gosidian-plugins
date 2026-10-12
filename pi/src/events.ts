// pi's JSON event stream (--mode json): records split on LF only (a JSON
// string may hold U+2028, which readline would split on), and what a run
// adds up to: turns, tool calls, usage and cost, the last answer.

// Lines splits a byte stream into its LF-terminated records.
export class Lines {
  private buf = "";
  private decoder = new TextDecoder();

  push(chunk: Uint8Array, out: (line: string) => void): void {
    this.buf += this.decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (line.trim()) out(line);
    }
  }

  end(out: (line: string) => void): void {
    this.buf += this.decoder.decode();
    if (this.buf.trim()) out(this.buf.replace(/\r$/, ""));
    this.buf = "";
  }
}

export interface Usage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  cost: number;
}

export const noUsage = (): Usage => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, cost: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cache_read: a.cache_read + b.cache_read,
    cache_write: a.cache_write + b.cache_write,
    total_tokens: a.total_tokens + b.total_tokens,
    cost: a.cost + b.cost,
  };
}

// RunState follows one pi process.
export class RunState {
  turns = 0;
  usage = noUsage();
  tools: Record<string, number> = {};
  toolErrors = 0;
  // text is the last assistant message's text; stop its stop reason.
  text = "";
  stop = "";
  error = "";
  model = "";
  settled = false;

  feed(ev: any): void {
    switch (ev?.type) {
      case "turn_start":
        this.turns++;
        break;
      case "message_end": {
        const m = ev.message;
        if (m?.role !== "assistant") break;
        const u = m.usage ?? {};
        this.usage = addUsage(this.usage, {
          input: u.input ?? 0,
          output: u.output ?? 0,
          cache_read: u.cacheRead ?? 0,
          cache_write: u.cacheWrite ?? 0,
          total_tokens: u.totalTokens ?? 0,
          cost: u.cost?.total ?? 0,
        });
        const text = (Array.isArray(m.content) ? m.content : [])
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text)
          .join("");
        // A turn that only calls tools keeps the text of the one before.
        if (text || m.stopReason !== "toolUse") this.text = text;
        this.stop = m.stopReason ?? "";
        this.error = m.errorMessage ?? "";
        this.model = m.model ?? this.model;
        break;
      }
      case "tool_execution_end":
        this.tools[ev.toolName] = (this.tools[ev.toolName] ?? 0) + 1;
        if (ev.isError) this.toolErrors++;
        break;
      case "agent_settled":
        this.settled = true;
        break;
    }
  }
}
