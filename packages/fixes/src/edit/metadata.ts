import { parseModule, unwrap, type AstNode } from "../ast.js";
import { propertiesNamed, propertyNamed, setProperties, toCode } from "../code.js";
import { findMetadata } from "../scope.js";
import { languagesCode, metadataSnippet } from "../snippet.js";
import type { EditResult } from "../types.js";

export type MetadataPlan = { title?: string; description?: string; canonical?: string; languages?: Record<string, string> };

function entriesOf(plan: MetadataPlan): { top: Array<[string, string]>; alternates: Array<[string, string]> } {
  const top: Array<[string, string]> = [];
  if (plan.title) top.push(["title", toCode(plan.title)]);
  if (plan.description) top.push(["description", toCode(plan.description)]);
  const alternates: Array<[string, string]> = [];
  if (plan.canonical) alternates.push(["canonical", toCode(plan.canonical)]);
  if (plan.languages) alternates.push(["languages", languagesCode(plan.languages)]);
  return { top, alternates };
}

const objectCode = (entries: Array<[string, string]>) => `{ ${entries.map(([n, c]) => `${n}: ${c}`).join(", ")} }`;

function edit(source: string, entries: { top: Array<[string, string]>; alternates: Array<[string, string]> }, dynamic: boolean, snippet: string, summary: string, parsed?: AstNode): EditResult {
  if (!entries.top.length && !entries.alternates.length) return { ok: false, reason: "there's nothing to change", snippet };
  let program: AstNode;
  try { program = parsed ?? parseModule(source); } catch { return { ok: false, reason: "the file doesn't parse", snippet }; }
  const site = findMetadata(program);
  if (site.kind === "unsupported") return { ok: false, reason: site.reason, snippet };
  if (site.kind === "none") {
    if (dynamic) return { ok: false, reason: "the route is dynamic and has no generateMetadata to edit", snippet };
    const all = [...entries.top, ...(entries.alternates.length ? [["alternates", objectCode(entries.alternates)] as [string, string]] : [])];
    const text = `\n\nexport const metadata = {\n${all.map(([n, c]) => `  ${n}: ${c},`).join("\n")}\n};\n`;
    return { ok: true, edits: [{ start: site.insertAt, end: site.insertAt, text }], allowedRanges: [{ start: site.insertAt, end: site.insertAt }], roots: [], files: {}, summary };
  }
  const object = site.object;
  const dup = (o: AstNode, names: string[]) => names.find((n) => propertiesNamed(o, n).length > 1);
  const topDup = dup(object, [...entries.top.map(([n]) => n), ...(entries.alternates.length ? ["alternates"] : [])]);
  if (topDup) return { ok: false, reason: `${topDup} is defined more than once`, snippet };
  const altProp = propertyNamed(object, "alternates");
  const altValue = altProp ? unwrap(altProp.value as AstNode) : null;
  if (altProp && entries.alternates.length && altValue?.type !== "ObjectExpression") return { ok: false, reason: "`alternates` isn't a plain object", snippet };
  if (altValue?.type === "ObjectExpression") {
    const altDup = dup(altValue, entries.alternates.map(([n]) => n));
    if (altDup) return { ok: false, reason: `${altDup} is defined more than once`, snippet };
  }
  const edits = altValue?.type === "ObjectExpression" && entries.alternates.length
    ? [...setProperties(source, object, entries.top), ...setProperties(source, altValue, entries.alternates)]
    : setProperties(source, object, [...entries.top, ...(entries.alternates.length ? [["alternates", objectCode(entries.alternates)] as [string, string]] : [])]);
  return { ok: true, edits, allowedRanges: [{ start: object.start, end: object.end }], roots: site.names, files: {}, summary };
}

/** `program` is `source` already parsed, to save parsing it again. */
export function editMetadata(source: string, plan: MetadataPlan, dynamic: boolean, program?: AstNode): EditResult {
  const changed = [plan.title && "title", plan.description && "description", plan.canonical && "canonical", plan.languages && "hreflang"].filter(Boolean).join(", ");
  return edit(source, entriesOf(plan), dynamic, metadataSnippet(plan, dynamic), `Sets ${changed} in the route's metadata.`, program);
}

export function editMetadataBase(source: string, origin: string): EditResult {
  const entries = { top: [["metadataBase", `new URL(${JSON.stringify(origin)})`] as [string, string]], alternates: [] };
  return edit(source, entries, false, `export const metadata = {\n  metadataBase: new URL(${JSON.stringify(origin)}),\n};`, `Sets metadataBase to ${origin}, so canonical and hreflang URLs resolve to the live site.`);
}

/** The root layout's `title: { template: "…%s…" }`, which Next.js wraps every child page's title in. */
export function titleTemplate(source: string): string | undefined {
  let program: AstNode;
  try { program = parseModule(source); } catch { return undefined; }
  const site = findMetadata(program);
  if (site.kind !== "object" && site.kind !== "function") return undefined;
  const title = propertyNamed(site.object, "title");
  const value = title ? unwrap(title.value as AstNode) : null;
  const template = value?.type === "ObjectExpression" ? propertyNamed(value, "template") : undefined;
  const literal = template ? unwrap(template.value as AstNode) : null;
  return literal?.type === "StringLiteral" && String(literal.value).includes("%s") ? String(literal.value) : undefined;
}
