// The agent's answer as JSON: taken from its last message (bare, or in a
// fenced block), and checked against the node's schema.
import { Ajv } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

// extractJSON finds the JSON value of an answer: the whole text, else the
// last ```json (or bare ```) block, else the outermost {…} or […].
export function extractJSON(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const tries: string[] = [text.trim()];
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  tries.push(...blocks.reverse());
  for (const [open, close] of [["{", "}"], ["[", "]"]]) {
    const a = text.indexOf(open);
    const b = text.lastIndexOf(close);
    if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  }
  for (const t of tries) {
    if (!t) continue;
    try {
      return { ok: true, value: JSON.parse(t) };
    } catch {
      // the next try
    }
  }
  return { ok: false, error: "the answer holds no JSON value" };
}

// check validates a value against a schema; the errors are short lines.
export function check(schema: object, value: unknown): string[] {
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (e) {
    return [`the schema is not valid: ${(e as Error).message}`];
  }
  if (validate(value)) return [];
  return (validate.errors ?? []).slice(0, 20).map((e) => `${e.instancePath || "(root)"} ${e.message}`);
}

// checkSchema says whether a node's schema compiles, before running.
export function schemaError(schema: object): string {
  try {
    ajv.compile(schema);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

// instructions are the lines that ask for JSON in the system prompt.
export function instructions(schema: object | undefined): string {
  if (!schema) return "Answer with a single JSON value and nothing else: no prose, no code fence.";
  return [
    "Answer with a single JSON value and nothing else: no prose, no code fence.",
    "It must follow this JSON Schema:",
    JSON.stringify(schema),
  ].join("\n");
}

// correction is the prompt of a turn that asks the agent to fix its answer.
export function correction(errors: string[]): string {
  return [
    "Your answer is not the JSON the task asks for:",
    ...errors.map((e) => `- ${e}`),
    "Answer again with only the corrected JSON value.",
  ].join("\n");
}
