import { lineIndent, type AstNode } from "./ast.js";
import type { Edit } from "./types.js";

const PLACEHOLDER = /\{([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\}/g;
const escapeTemplate = (text: string) => text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

export function placeholders(pattern: string): string[] {
  return [...pattern.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/** `{procedure.name} in Malaysia` → `` `${procedure.name} in Malaysia` ``; no placeholders → `"…"`. */
export function toCode(pattern: string): string {
  const parts: string[] = [];
  let last = 0;
  let dynamic = false;
  for (const match of pattern.matchAll(PLACEHOLDER)) {
    parts.push(escapeTemplate(pattern.slice(last, match.index)), "${" + match[1] + "}");
    last = match.index! + match[0].length;
    dynamic = true;
  }
  parts.push(escapeTemplate(pattern.slice(last)));
  return dynamic ? "`" + parts.join("") + "`" : JSON.stringify(pattern);
}

export function propertyNamed(object: AstNode, name: string): AstNode | undefined {
  return (object.properties as AstNode[]).find((p) => {
    if (p.type !== "ObjectProperty" || p.computed) return false;
    const key = p.key as AstNode;
    return (key.type === "Identifier" && key.name === name) || (key.type === "StringLiteral" && key.value === name);
  });
}

/** Replaces existing properties' values and adds the rest after the last property, matching its indentation and comma style. */
export function setProperties(source: string, object: AstNode, entries: Array<[string, string]>): Edit[] {
  const edits: Edit[] = [];
  const added: Array<[string, string]> = [];
  for (const [name, code] of entries) {
    const existing = propertyNamed(object, name);
    if (existing) edits.push({ start: (existing.value as AstNode).start, end: (existing.value as AstNode).end, text: code });
    else added.push([name, code]);
  }
  if (!added.length) return edits;
  const props = object.properties as AstNode[];
  if (!props.length) {
    edits.push({ start: object.start, end: object.end, text: `{ ${added.map(([n, c]) => `${n}: ${c}`).join(", ")} }` });
    return edits;
  }
  const last = props[props.length - 1]!;
  const indent = lineIndent(source, last.start);
  const lines = added.map(([n, c]) => `\n${indent}${n}: ${c},`).join("");
  const comma = source.slice(last.end, object.end - 1).indexOf(",");
  if (comma >= 0) edits.push({ start: last.end + comma + 1, end: last.end + comma + 1, text: lines });
  else edits.push({ start: last.end, end: last.end, text: "," + lines.replace(/,$/, "") });
  return edits;
}
