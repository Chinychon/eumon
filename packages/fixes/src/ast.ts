import { parse } from "@babel/parser";

/** A Babel AST node, typed loosely so the package needs no @babel/types import. Offsets are into the original source. */
export type AstNode = { type: string; start: number; end: number; [key: string]: unknown };

const SKIP_KEYS = new Set(["loc", "leadingComments", "trailingComments", "innerComments", "extra", "range"]);
export const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod"]);

export function parseModule(source: string): AstNode {
  return (parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] }) as unknown as { program: AstNode }).program;
}

export function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

export function childrenOf(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue;
    if (Array.isArray(value)) { for (const item of value) if (isNode(item)) out.push(item); }
    else if (isNode(value)) out.push(value);
  }
  return out;
}

/** Depth-first walk; return "skip" from the visitor to not descend into a node. */
export function walk(node: AstNode, visit: (node: AstNode, parent: AstNode | null) => void | "skip", parent: AstNode | null = null): void {
  if (visit(node, parent) === "skip") return;
  for (const child of childrenOf(node)) walk(child, visit, node);
}

/** `x as T`, `x satisfies T`, `(x)`, `x!` → `x`. */
export function unwrap(node: AstNode): AstNode {
  let current = node;
  while (["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression", "TSNonNullExpression"].includes(current.type)) current = current.expression as AstNode;
  return current;
}

export function hasDirective(program: AstNode, value: string): boolean {
  return ((program.directives as AstNode[] | undefined) ?? []).some((directive) => (directive.value as { value: string }).value === value);
}

/** The leading whitespace of the line containing `position`. */
export function lineIndent(source: string, position: number): string {
  const lineStart = source.lastIndexOf("\n", position - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart))![0];
}
