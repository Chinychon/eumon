import { parseModule, walk, type AstNode } from "./ast.js";
import type { Edit, Range } from "./types.js";

export const ALLOWED_FILES: RegExp[] = [
  /^(src\/)?app\/(.+\/)?page\.[jt]sx?$/,
  /^(src\/)?app\/layout\.[jt]sx?$/,
  /^(src\/)?components\/eumon-json-ld\.tsx$/,
  /^public\/llms\.txt$/,
  /^public\/robots\.txt$/,
];
const GLOBALS = new Set(["URL", "JSON", "String", "Number", "Math", "undefined", "encodeURIComponent"]);
const CODE = /\.[jt]sx?$/;

export type ValidateInput = { filePath: string; before: string; edits: Edit[]; allowedRanges: Range[]; roots: string[]; sensitivePaths: string[]; maxChangedLines?: number };

export function applyEdits(source: string, edits: Edit[]): string {
  let out = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

function fileProblem(path: string, sensitivePaths: string[]): string | null {
  if (!ALLOWED_FILES.some((re) => re.test(path))) return `Eumon doesn't edit ${path}`;
  if (sensitivePaths.includes(path)) return `${path} is marked sensitive`;
  return null;
}

export function validateFile(path: string, content: string, sensitivePaths: string[]): { ok: true } | { ok: false; reason: string } {
  const problem = fileProblem(path, sensitivePaths);
  if (problem) return { ok: false, reason: problem };
  if (content.length > 60_000) return { ok: false, reason: `${path} would be over 60 KB` };
  if (CODE.test(path)) { try { parseModule(content); } catch { return { ok: false, reason: `${path} doesn't parse` }; } }
  return { ok: true };
}

function isReference(node: AstNode, parent: AstNode | null): boolean {
  if (!parent) return true;
  if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && parent.property === node && !parent.computed) return false;
  if ((parent.type === "ObjectProperty" || parent.type === "ObjectMethod") && parent.key === node && !parent.computed) return parent.shorthand === true;
  if (parent.type === "VariableDeclarator" && parent.id === node) return false;
  if ((parent.type === "FunctionDeclaration" || parent.type === "ClassDeclaration") && parent.id === node) return false;
  if (parent.type === "ImportSpecifier" || parent.type === "ImportDefaultSpecifier" || parent.type === "ImportNamespaceSpecifier") return false;
  return true;
}

const importSources = (program: AstNode) =>
  (program.body as AstNode[]).filter((s) => s.type === "ImportDeclaration").map((s) => (s.source as { value: string }).value);

export function validateEdit(input: ValidateInput): { ok: true; after: string } | { ok: false; reason: string } {
  const problem = fileProblem(input.filePath, input.sensitivePaths);
  if (problem) return { ok: false, reason: problem };
  const edits = [...input.edits].sort((a, b) => a.start - b.start);
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    if (i > 0 && edit.start < edits[i - 1]!.end) return { ok: false, reason: "two edits overlap" };
    if (!input.allowedRanges.some((r) => edit.start >= r.start && edit.end <= r.end)) return { ok: false, reason: "an edit falls outside the part of the file Eumon may change" };
  }
  const changed = edits.reduce((sum, e) => sum + Math.max(e.text.split("\n").length, input.before.slice(e.start, e.end).split("\n").length), 0);
  if (changed > (input.maxChangedLines ?? 60)) return { ok: false, reason: `the change is ${changed} lines; Eumon keeps fixes under ${input.maxChangedLines ?? 60}` };
  const after = applyEdits(input.before, edits);
  if (!CODE.test(input.filePath)) return { ok: true, after };

  let beforeProgram: AstNode, afterProgram: AstNode;
  try { beforeProgram = parseModule(input.before); afterProgram = parseModule(after); } catch { return { ok: false, reason: "the edited file doesn't parse" }; }
  const known = new Set(importSources(beforeProgram));
  const added = importSources(afterProgram).filter((s) => !known.has(s));
  if (added.some((s) => !/eumon-json-ld$/.test(s))) return { ok: false, reason: `the edit adds an import (${added.join(", ")})` };

  // Where each inserted text ended up in `after`.
  const spans: Range[] = [];
  let delta = 0;
  for (const edit of edits) {
    spans.push({ start: edit.start + delta, end: edit.start + delta + edit.text.length });
    delta += edit.text.length - (edit.end - edit.start);
  }
  const roots = new Set(input.roots);
  let unknown: string | null = null;
  walk(afterProgram, (node, parent) => {
    if (unknown || node.type !== "Identifier" || !spans.some((s) => node.start >= s.start && node.end <= s.end)) return;
    if (!isReference(node, parent)) return;
    const name = node.name as string;
    if (!roots.has(name) && !GLOBALS.has(name)) unknown = name;
  });
  if (unknown) return { ok: false, reason: `the edit uses \`${unknown}\`, which isn't defined there` };
  return { ok: true, after };
}
