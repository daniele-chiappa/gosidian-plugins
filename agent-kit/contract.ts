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
