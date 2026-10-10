import { parseModule, walk, type AstNode } from "./ast.js";
import { JSON_LD_COMPONENT } from "./edit/jsonld.js";
import type { Edit, Range } from "./types.js";

export const ALLOWED_FILES: RegExp[] = [
  /^(src\/)?app\/(.+\/)?page\.[jt]sx?$/,
  /^(src\/)?app\/layout\.[jt]sx?$/,
  /^(src\/)?components\/eumon-json-ld\.tsx$/,
  /^public\/llms\.txt$/,
  /^public\/robots\.txt$/,
];
// Copied from SENSITIVE_PATTERNS in packages/repo-analyzer/src/analyze.ts (not exported there); keep the two in step.
const SENSITIVE_PATTERNS = [
  /(^|\/)\.env/,
  /secrets?\./i,
  /credentials/i,
  /(^|\/)auth\//i,
  /payment/i,
  /(^|\/)(migrations|prisma\/migrations|supabase\/migrations)\//i,
];
const GLOBALS = new Set(["URL", "undefined"]);
const MAX_INSERTED_CHARS = 8_000;
const LINE_BREAK = /\r\n|[\r\n\u2028\u2029]/;
const COMPONENT_IMPORT = /^(\.{1,2}\/)+components\/eumon-json-ld$/;
const BAD_PROPS = new Set(["constructor", "prototype", "__proto__"]);
const PLAIN_TYPES = new Set([
  "Program",
  "ObjectExpression", "ObjectProperty", "ArrayExpression", "StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral",
  "TemplateLiteral", "TemplateElement", "Identifier", "VariableDeclaration", "VariableDeclarator", "ImportDeclaration", "ImportSpecifier",
  "JSXElement", "JSXAttribute", "JSXExpressionContainer", "JSXText", "JSXIdentifier",
]);

/** Why this node may not appear in inserted text, or null if it may. */
function forbidden(node: AstNode): string | null {
  if (PLAIN_TYPES.has(node.type)) return null;
  const callee = node.callee as AstNode | undefined;
  switch (node.type) {
    case "MemberExpression": case "OptionalMemberExpression":
      return !node.computed && !BAD_PROPS.has((node.property as AstNode).name as string) ? null : `a ${node.type} on a computed or special property`;
    case "NewExpression": return callee?.type === "Identifier" && callee.name === "URL" ? null : "a NewExpression other than new URL";
    case "ExportNamedDeclaration": return node.source ? "a re-export" : null;
    case "JSXOpeningElement": case "JSXClosingElement": return (node.name as AstNode).name === "EumonJsonLd" ? null : "a JSX element other than EumonJsonLd";
  }
  return `a ${node.type}`;
}
const CODE = /\.[jt]sx?$/;

export type ValidateInput = { filePath: string; before: string; edits: Edit[]; allowedRanges: Range[]; roots: string[]; sensitivePaths: string[]; maxChangedLines?: number };

export function applyEdits(source: string, edits: Edit[]): string {
  let out = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

function fileProblem(path: string, sensitivePaths: string[]): string | null {
  if (/(^|\/)\.\.?(\/|$)/.test(path) || path.startsWith("/") || path.includes("\\")) return `${path} isn't a path Eumon edits`;
  if (!ALLOWED_FILES.some((re) => re.test(path))) return `Eumon doesn't edit ${path}`;
  if (sensitivePaths.includes(path) || SENSITIVE_PATTERNS.some((re) => re.test(path))) return `${path} is marked sensitive`;
  return null;
}

export function validateFile(path: string, content: string, sensitivePaths: string[]): { ok: true } | { ok: false; reason: string } {
  const problem = fileProblem(path, sensitivePaths);
  if (problem) return { ok: false, reason: problem };
  if (/^(src\/)?components\/eumon-json-ld\.tsx$/.test(path) && content !== JSON_LD_COMPONENT) return { ok: false, reason: `${path} may only contain Eumon's own component` };
  if (content.length > 60_000) return { ok: false, reason: `${path} would be over 60 KB` };
  if (CODE.test(path)) { try { parseModule(content); } catch { return { ok: false, reason: `${path} doesn't parse` }; } }
  return { ok: true };
}

function isReference(node: AstNode, parent: AstNode | null): boolean {
  if (!parent) return true;
  if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && parent.property === node && !parent.computed) return false;
  if ((parent.type === "ObjectProperty" || parent.type === "ObjectMethod") && parent.key === node && !parent.computed) return parent.shorthand === true;
  if (parent.type === "VariableDeclarator" && parent.id === node && node.name === "metadata") return false;
  if (parent.type === "ImportSpecifier" || parent.type === "ImportDefaultSpecifier" || parent.type === "ImportNamespaceSpecifier") return false;
  return true;
}

const importSources = (program: AstNode) =>
  (program.body as AstNode[]).filter((s) => s.type === "ImportDeclaration" || s.type === "ExportAllDeclaration" || (s.type === "ExportNamedDeclaration" && s.source)).map((s) => (s.source as { value: string }).value);

export function validateEdit(input: ValidateInput): { ok: true; after: string } | { ok: false; reason: string } {
  const problem = fileProblem(input.filePath, input.sensitivePaths);
  if (problem) return { ok: false, reason: problem };
  const len = input.before.length;
  if (input.edits.some((e) => !Number.isInteger(e.start) || !Number.isInteger(e.end) || e.start < 0 || e.start > e.end || e.end > len)) return { ok: false, reason: "an edit has an invalid position" };
  if (input.edits.some((e) => e.text === "" && e.end > e.start)) return { ok: false, reason: "an edit only deletes code, which Eumon never does" };
  const edits = [...input.edits].sort((a, b) => a.start - b.start);
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    if (i > 0 && edit.start < edits[i - 1]!.end) return { ok: false, reason: "two edits overlap" };
    if (!input.allowedRanges.some((r) => edit.start >= r.start && edit.end <= r.end)) return { ok: false, reason: "an edit falls outside the part of the file Eumon may change" };
  }
  if (edits.reduce((sum, e) => sum + e.text.length, 0) > MAX_INSERTED_CHARS) return { ok: false, reason: `the change inserts more than ${MAX_INSERTED_CHARS} characters; Eumon keeps fixes small` };
  const changed = edits.reduce((sum, e) => sum + Math.max(e.text.split(LINE_BREAK).length, input.before.slice(e.start, e.end).split(LINE_BREAK).length), 0);
  if (changed > (input.maxChangedLines ?? 60)) return { ok: false, reason: `the change is ${changed} lines; Eumon keeps fixes under ${input.maxChangedLines ?? 60}` };
  const after = applyEdits(input.before, edits);
  if (!CODE.test(input.filePath)) return { ok: true, after };

  let beforeProgram: AstNode, afterProgram: AstNode;
  try { beforeProgram = parseModule(input.before); afterProgram = parseModule(after); } catch { return { ok: false, reason: "the edited file doesn't parse" }; }
  const known = new Set(importSources(beforeProgram));
  const added = importSources(afterProgram).filter((s) => !known.has(s));
  if (added.some((s) => !COMPONENT_IMPORT.test(s))) return { ok: false, reason: `the edit adds an import (${added.join(", ")})` };

  // Where each inserted text ended up in `after`.
  const spans: Range[] = [];
  let delta = 0;
  for (const edit of edits) {
    spans.push({ start: edit.start + delta, end: edit.start + delta + edit.text.length });
    delta += edit.text.length - (edit.end - edit.start);
  }
  const roots = new Set(input.roots);
  let unknown: string | null = null;
  let banned: string | null = null;
  walk(afterProgram, (node, parent) => {
    if (unknown || banned) return;
    if (spans.some((s) => node.start < s.end && node.end > s.start && !(node.start < s.start && node.end > s.end))) {
      const why = forbidden(node);
      if (why) { banned = why; return; }
    }
    if (node.type !== "Identifier" || !spans.some((s) => (node.start < s.end && node.end > s.start) || (s.start === s.end && node.start < s.start && s.start < node.end))) return;
    if (!isReference(node, parent)) return;
    const name = node.name as string;
    if (!roots.has(name) && !GLOBALS.has(name)) unknown = name;
  });
  if (banned) return { ok: false, reason: `the edit contains ${banned}, which Eumon never inserts` };
  if (unknown) return { ok: false, reason: `the edit uses \`${unknown}\`, which isn't defined there` };
  return { ok: true, after };
}
