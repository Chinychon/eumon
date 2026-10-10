import { lineIndent, parseModule, type AstNode } from "../ast.js";
import { toCode } from "../code.js";
import { findPage } from "../scope.js";
import { jsonLdSnippet } from "../snippet.js";
import type { EditResult } from "../types.js";

export const JSON_LD_COMPONENT = [
  "// Added by Eumon: schema.org structured data, rendered into the page's HTML.",
  "export function EumonJsonLd({ data }: { data: unknown }) {",
  "  return (",
  "    <script",
  '      type="application/ld+json"',
  '      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\\\u003c") }}',
  "    />",
  "  );",
  "}",
  "",
].join("\n");

export type JsonLdPlan = { schemaType: string; fields: Array<{ field: string; path: string }>; url: string; origin: string };

export function componentPath(treePaths: string[]): string {
  return treePaths.some((p) => p.startsWith("src/app/")) ? "src/components/eumon-json-ld.tsx" : "components/eumon-json-ld.tsx";
}

export function importPath(fromFile: string, target: string): string {
  const from = fromFile.split("/").slice(0, -1);
  const to = target.replace(/\.tsx$/, "").split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const rel = [...from.slice(i).map(() => ".."), ...to.slice(i)].join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

export function jsonLdCode(plan: JsonLdPlan): string {
  const url = toCode(plan.origin + plan.url);
  const main = `{ ${[`"@context": "https://schema.org"`, `"@type": ${JSON.stringify(plan.schemaType)}`, ...plan.fields.map((f) => `${JSON.stringify(f.field)}: ${f.path}`), `url: ${url}`].join(", ")} }`;
  const name = plan.fields.find((f) => f.field === "name")?.path;
  if (plan.url === "/" || !name) return main;
  const crumb = `{ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: ${JSON.stringify(plan.origin + "/")} }, { "@type": "ListItem", position: 2, name: ${name}, item: ${url} }] }`;
  return `[${main}, ${crumb}]`;
}

export function editJsonLd(file: string, source: string, plan: JsonLdPlan, treePaths: string[]): EditResult {
  const dataCode = jsonLdCode(plan);
  const snippet = jsonLdSnippet(dataCode);
  if (/EumonJsonLd/.test(source)) return { ok: false, reason: "the page already renders Eumon's structured data", snippet };
  let program: AstNode;
  try { program = parseModule(source); } catch { return { ok: false, reason: "the file doesn't parse", snippet }; }
  const page = findPage(program);
  if (page.kind === "unsupported") return { ok: false, reason: page.reason, snippet };

  const component = componentPath(treePaths);
  const line = `import { EumonJsonLd } from ${JSON.stringify(importPath(file, component))};`;
  const imports = (program.body as AstNode[]).filter((s) => s.type === "ImportDeclaration");
  const directives = (program.directives as AstNode[] | undefined) ?? [];
  const importAt = imports.length ? imports[imports.length - 1]!.end : directives.length ? directives[directives.length - 1]!.end : 0;
  const importText = importAt > 0 ? `\n${line}` : `${line}\n`;

  const root = page.root;
  const open = (root.type === "JSXElement" ? root.openingElement : root.openingFragment) as AstNode;
  const firstChild = ((root.children as AstNode[] | undefined) ?? []).find((c) => c.type !== "JSXText" || String(c.value).trim());
  const indent = firstChild ? lineIndent(source, firstChild.start) : `${lineIndent(source, open.start)}  `;
  const element = `\n${indent}<EumonJsonLd data={${dataCode}} />`;

  return {
    ok: true,
    edits: [{ start: importAt, end: importAt, text: importText }, { start: open.end, end: open.end, text: element }],
    allowedRanges: [{ start: importAt, end: importAt }, { start: open.end, end: open.end }],
    roots: page.names,
    files: treePaths.includes(component) ? {} : { [component]: JSON_LD_COMPONENT },
    summary: `Adds ${plan.schemaType} structured data${plan.url === "/" ? "" : " and a breadcrumb"}, rendered into the HTML so search engines and AI crawlers can read it.`,
  };
}
