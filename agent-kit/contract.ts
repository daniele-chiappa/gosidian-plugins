// agent-run/1, the contract of the agents' nodes (gosidian docs/plugins.md,
// "Agent nodes"): the names every agent plugin reads and writes the same
// way, so a pipeline or a coordinator picks an executor without learning it.

export const CONTRACT = "agent-run/1";

// What an agent may do with the files of its step: read and search them,
// also write them, also run commands. Each plugin maps a level to its own
// tools, within its preset's.
export const ACCESS = ["read", "edit", "exec"] as const;
export type Access = (typeof ACCESS)[number];

// gosidian's MCP for a call: none, or a token of the run's project that
// reads, or reads and writes, and lasts the call.
export const MCP_LEVELS = ["none", "read", "write"] as const;
export type MCPLevel = (typeof MCP_LEVELS)[number];

// The fields of the call's _meta gosidian fills.
export const META = {
  project: "gosidian/project",
  run: "gosidian/run",
  tokensLeft: "gosidian/llm_tokens_left",
  mcpURL: "gosidian/mcp_url",
  mcpToken: "gosidian/mcp_token",
} as const;

// toolsFor gives the tools of a level, from the plugin's map of each level's
// own tools (read's are in edit's, edit's in exec's), within allowed. A
// level whose tools the preset does not allow at all is an error that names
// them.
export function toolsFor(level: Access, byLevel: Record<Access, string[]>, allowed: string[]): string[] {
  const want: string[] = [];
  for (const l of ACCESS) {
    want.push(...byLevel[l]);
    if (l === level) break;
  }
  const missing = byLevel[level].filter((t) => !allowed.includes(t));
  if (missing.length === byLevel[level].length && missing.length > 0) {
    throw new Error(`access ${level} needs ${missing.join(", ")}, which the preset does not allow`);
  }
  return want.filter((t) => allowed.includes(t));
}

// A step that could not work for a limit outside it and its settings (the
// provider's key reached its limit, the subscription has no quota left)
// says so in its error's structured content, as wait: gosidian holds the
// step of a team's task and tries again, where it would fail it. until,
// when known, is when the limit ends (RFC 3339).
export interface Wait {
  reason: string;
  until?: string;
}

const LIMIT_WORDS = /key limit exceeded|rate.?limit|too many requests|quota|insufficient (credits?|balance|funds)|usage limit|credit balance|overloaded/i;

// waitOf reads a provider's error (its text, and its HTTP status when the
// caller has it apart): a Wait when it is a limit that ends by itself or
// by its owner's hand, undefined for any other failure. 402, 429 and 529
// are limits; 403 and 503 only when the text says so.
export function waitOf(text: string, status?: number | null): Wait | undefined {
  const m = /^\s*(\d{3})\b/.exec(text) ?? /"code"\s*:\s*(\d{3})\b/.exec(text);
  const code = status ?? (m ? Number(m[1]) : 0);
  const words = LIMIT_WORDS.test(text);
  const limit = code === 402 || code === 429 || code === 529 || ((code === 403 || code === 503 || !code) && words);
  if (!limit) return undefined;
  const reason = code ? `the provider answered ${code}` : "the provider's limit";
  const r = /resets?(?: at)?:? (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))/.exec(text);
  const at = r ? new Date(r[1]) : undefined;
  return at && !Number.isNaN(at.getTime()) ? { reason, until: at.toISOString() } : { reason };
}
