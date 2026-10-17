// Claude Code's event stream (-p --output-format stream-json --verbose):
// records split on LF only (a JSON string may hold U+2028, which readline
// would split on), and what a session adds up to: the init event (the
// resolved model, the tools it has), the turns, and the result event with
// the answer, the usage, the cost and the denied tool calls.

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
}

export const noUsage = (): Usage => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0 });

export interface Denial {
  tool: string;
  // input is the call's input as JSON, cut at 300 characters.
  input: string;
}

// Outcome is what a session's result event says, in the plugin's terms.
export interface Outcome {
  subtype: string;
  isError: boolean;
  text: string;
  structured?: unknown;
  turns: number;
  cost: number;
  usage: Usage;
  // model is the model the session ran on, as the API names it: the alias
  // resolved by this version of Claude Code.
  model: string;
  models: string[];
  denials: Denial[];
  errors: string[];
  terminal: string;
  apiError: number | null;
}

// StreamState follows one Claude Code process.
export class StreamState {
  init: { model: string; tools: string[]; version: string; effortActive?: boolean } | undefined;
  result: any;
  // turns counts the assistant messages (each a call of the model).
  turns = 0;
  private ids = new Set<string>();
  // text is the text of the last assistant message that had some.
  text = "";

  feed(ev: any): void {
    switch (ev?.type) {
      case "system":
        if (ev.subtype === "init") {
          this.init = {
            model: String(ev.model ?? ""),
            tools: Array.isArray(ev.tools) ? ev.tools.map(String) : [],
            version: String(ev.claude_code_version ?? ""),
            ...(typeof ev.per_turn_effort_active === "boolean" ? { effortActive: ev.per_turn_effort_active } : {}),
          };
        }
        break;
      case "assistant": {
        const m = ev.message;
        if (ev.parent_tool_use_id) break; // a subagent's
        const id = String(m?.id ?? "");
        if (id && !this.ids.has(id)) {
          this.ids.add(id);
          this.turns++;
        }
        const text = (Array.isArray(m?.content) ? m.content : [])
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text)
          .join("");
        if (text) this.text = text;
        break;
      }
      case "result":
        this.result = ev;
        break;
    }
  }

  // outcome reads the result event; undefined when the process gave none.
  outcome(): Outcome | undefined {
    const r = this.result;
    if (!r) return undefined;
    const usage = noUsage();
    const mu: Record<string, any> = r.modelUsage && typeof r.modelUsage === "object" ? r.modelUsage : {};
    const models = Object.keys(mu);
    if (models.length) {
      for (const m of Object.values(mu)) {
        usage.input += num(m.inputTokens);
        usage.output += num(m.outputTokens);
        usage.cache_read += num(m.cacheReadInputTokens);
        usage.cache_write += num(m.cacheCreationInputTokens);
      }
    } else if (r.usage) {
      usage.input = num(r.usage.input_tokens);
      usage.output = num(r.usage.output_tokens);
      usage.cache_read = num(r.usage.cache_read_input_tokens);
      usage.cache_write = num(r.usage.cache_creation_input_tokens);
    }
    usage.total_tokens = usage.input + usage.output + usage.cache_read + usage.cache_write;
    return {
      subtype: String(r.subtype ?? ""),
      isError: Boolean(r.is_error),
      text: typeof r.result === "string" ? r.result : this.text,
      ...(r.structured_output !== undefined ? { structured: r.structured_output } : {}),
      turns: Number.isInteger(r.num_turns) ? r.num_turns : this.turns,
      cost: num(r.total_cost_usd),
      usage,
      model: mainModel(mu, this.init?.model ?? ""),
      models,
      denials: (Array.isArray(r.permission_denials) ? r.permission_denials : []).map((d: any) => ({
        tool: String(d?.tool_name ?? ""),
        input: JSON.stringify(d?.tool_input ?? {}).slice(0, 300),
      })),
      errors: Array.isArray(r.errors) ? r.errors.map(String) : [],
      terminal: String(r.terminal_reason ?? ""),
      apiError: typeof r.api_error_status === "number" ? r.api_error_status : null,
    };
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// mainModel is the model of the session: the init event's when it was used,
// else the one that wrote the most.
export function mainModel(modelUsage: Record<string, any>, initModel: string): string {
  const names = Object.keys(modelUsage);
  if (initModel && names.includes(initModel)) return initModel;
  let best = "";
  let most = -1;
  for (const n of names) {
    const out = num(modelUsage[n]?.outputTokens);
    if (out > most) {
      most = out;
      best = n;
    }
  }
  return best || initModel;
}
