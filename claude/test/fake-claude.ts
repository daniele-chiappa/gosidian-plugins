// A fake Claude Code for the tests: --version, --help, and -p, which plays
// a scenario the prompt names (FAKE:{…}) the way Claude Code does: the init
// event, a request through ANTHROPIC_BASE_URL with the step's key, the
// files it writes, and the result event. Its version comes from the
// wrapper the fake installer writes (--fake-version): a version 1.x
// resolves the aliases to models of the 4.5 generation, which take no
// effort, a newer one to the 5.5; a version with "broken" fails.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
let version = "0.0.0";
if (args[0] === "--fake-version") {
  version = args[1];
  args.splice(0, 2);
}
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

if (args.includes("--version")) {
  console.log(`${version} (Claude Code)`);
  process.exit(0);
}
if (args.includes("--help")) {
  console.log(`Usage: claude [options] [command] [prompt]

Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --json-schema <schema>                JSON Schema for structured output`);
  process.exit(0);
}

const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const prompt = fs.readFileSync(0, "utf8");
const sc: any = prompt.startsWith("FAKE:") ? JSON.parse(prompt.slice(5)) : {};
const old = version.startsWith("1.");
const alias = opt("--model") ?? "sonnet";
const model = alias.startsWith("claude-") ? alias : old ? `claude-${alias}-4-5-20251001` : `claude-${alias}-5-5`;
const hasEffort = !model.includes("4-5");
const effort = opt("--effort");

out({ type: "system", subtype: "init", cwd: process.cwd(), tools: (opt("--tools") ?? "").split(",").filter(Boolean), model, claude_code_version: version, per_turn_effort_active: hasEffort });

if (version.includes("broken")) {
  process.stderr.write("Error: this version is broken\n");
  process.exit(1);
}

const body = {
  model,
  max_tokens: 1000,
  stream: true,
  messages: [{ role: "user", content: prompt }],
  ...(hasEffort ? { output_config: { effort: effort ?? "medium" } } : { thinking: { type: "enabled", budget_tokens: 100 } }),
};
const r = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, {
  method: "POST",
  headers: { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01", "anthropic-beta": "claude-code-20250219", "content-type": "application/json" },
  body: JSON.stringify(body),
});
const answer = await r.text();
const result = (o: Record<string, unknown>) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: sc.turns ?? 1,
  result: sc.text ?? "ok",
  total_cost_usd: 0.0123,
  usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 },
  modelUsage: { [model]: { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 1000, cacheCreationInputTokens: 50, costUSD: 0.0123 } },
  permission_denials: sc.denials ?? [],
  terminal_reason: "completed",
  ...o,
});
if (!r.ok) {
  out(result({ is_error: true, result: `API Error: ${r.status} ${answer}`, api_error_status: r.status }));
  process.exit(1);
}
for (const [name, content] of Object.entries(sc.write ?? {})) fs.writeFileSync(path.join("out", name), String(content));
if (sc.env) {
  fs.writeFileSync("out/env.json", JSON.stringify({
    env: process.env,
    argv: args,
    cwd: process.cwd(),
    system: fs.readFileSync(opt("--append-system-prompt-file")!, "utf8"),
    in: fs.readdirSync("in"),
  }));
}
// sh runs a command the way the Bash tool would (separation-test.sh), and
// keeps what it printed in out/sh.txt.
if (sc.sh) {
  const r = spawnSync("/bin/sh", ["-c", sc.sh], { encoding: "utf8", timeout: 20_000 });
  fs.writeFileSync("out/sh.txt", (r.stdout ?? "") + (r.stderr ?? ""));
}
if (sc.sleep) await new Promise((ok) => setTimeout(ok, sc.sleep * 1000));
out({ type: "assistant", message: { id: "msg_1", type: "message", role: "assistant", model, content: [{ type: "text", text: sc.text ?? "ok" }] }, parent_tool_use_id: null });
if (sc.noresult) {
  process.stderr.write("Error: something went wrong\n");
  process.exit(1);
}
const schema = opt("--json-schema");
out(result({
  ...(sc.subtype ? { subtype: sc.subtype, is_error: sc.subtype !== "success", errors: sc.errors ?? [] } : {}),
  ...(schema && sc.structured !== undefined ? { structured_output: sc.structured } : {}),
}));
process.exit(sc.subtype && sc.subtype !== "success" ? 1 : 0);
