import { FUNCTION_TYPES, hasDirective, unwrap, walk, type AstNode } from "./ast.js";

export type MetadataSite =
  | { kind: "object"; object: AstNode; names: string[] }
  | { kind: "function"; object: AstNode; names: string[] }
  | { kind: "none"; insertAt: number }
  | { kind: "unsupported"; reason: string };

export type PageSite = { kind: "page"; fn: AstNode; root: AstNode; names: string[] } | { kind: "unsupported"; reason: string };

export function bindingNames(pattern: AstNode): string[] {
  switch (pattern.type) {
    case "Identifier": return [pattern.name as string];
    case "ObjectPattern": return (pattern.properties as AstNode[]).flatMap((p) => bindingNames((p.type === "RestElement" ? p.argument : p.value) as AstNode));
    case "ArrayPattern": return (pattern.elements as Array<AstNode | null>).flatMap((e) => (e ? bindingNames(e) : []));
    case "AssignmentPattern": return bindingNames(pattern.left as AstNode);
    case "RestElement": return bindingNames(pattern.argument as AstNode);
    case "TSParameterProperty": return bindingNames(pattern.parameter as AstNode);
    default: return [];
  }
}

/** Parameters, plus top-level declarations in the body that come before `before`. */
export function functionScope(fn: AstNode, before: number): string[] {
  const names = new Set<string>();
  for (const param of fn.params as AstNode[]) for (const name of bindingNames(param)) names.add(name);
  for (const statement of (fn.body as AstNode).body as AstNode[]) {
    if (statement.start >= before) break;
    if (statement.type === "VariableDeclaration") for (const d of statement.declarations as AstNode[]) for (const name of bindingNames(d.id as AstNode)) names.add(name);
  }
  return [...names];
}

/** Return statements of a function, not counting nested functions. */
export function returnsOf(fn: AstNode): AstNode[] {
  const out: AstNode[] = [];
  walk(fn.body as AstNode, (node) => {
    if (FUNCTION_TYPES.has(node.type)) return "skip";
    if (node.type === "ReturnStatement") out.push(node);
  });
  return out;
}

export function afterImports(program: AstNode): number {
  const imports = (program.body as AstNode[]).filter((s) => s.type === "ImportDeclaration");
  if (imports.length) return imports[imports.length - 1]!.end;
  const directives = (program.directives as AstNode[] | undefined) ?? [];
  return directives.length ? directives[directives.length - 1]!.end : 0;
}

const META_NAMES = new Set(["metadata", "generateMetadata"]);

export function findMetadata(program: AstNode): MetadataSite {
  if (hasDirective(program, "use client")) return { kind: "unsupported", reason: "the file is a client component, where Next.js can't export metadata" };
  for (const statement of program.body as AstNode[]) {
    if (statement.type !== "ExportNamedDeclaration" || !statement.declaration) continue;
    const declaration = statement.declaration as AstNode;
    if (declaration.type === "VariableDeclaration") {
      for (const d of declaration.declarations as AstNode[]) {
        const id = d.id as AstNode;
        if (id.type !== "Identifier") {
          if (bindingNames(id).some((n) => META_NAMES.has(n))) return { kind: "unsupported", reason: "metadata is exported indirectly" };
          continue;
        }
        if (id.name === "metadata") {
          const init = d.init ? unwrap(d.init as AstNode) : null;
          return init?.type === "ObjectExpression" ? { kind: "object", object: init, names: [] } : { kind: "unsupported", reason: "`metadata` isn't a plain object" };
        }
        if (id.name === "generateMetadata") return { kind: "unsupported", reason: "`generateMetadata` is an arrow function" };
      }
    }
    if (declaration.type === "FunctionDeclaration" && (declaration.id as AstNode | null)?.name === "generateMetadata") {
      const returns = returnsOf(declaration);
      const value = returns.length === 1 && returns[0]!.argument ? unwrap(returns[0]!.argument as AstNode) : null;
      if (value?.type !== "ObjectExpression") return { kind: "unsupported", reason: "`generateMetadata` doesn't end in a single `return { … }`" };
      return { kind: "function", object: value, names: functionScope(declaration, returns[0]!.start) };
    }
  }
  for (const statement of program.body as AstNode[]) {
    if (statement.type === "ExportAllDeclaration") return { kind: "unsupported", reason: "metadata may be re-exported with `export *`" };
    if (statement.type !== "ExportNamedDeclaration") continue;
    for (const spec of (statement.specifiers as AstNode[]) ?? []) {
      const exported = spec.exported as AstNode;
      if (META_NAMES.has((exported.name ?? exported.value) as string)) return { kind: "unsupported", reason: "metadata is exported indirectly" };
    }
  }
  return { kind: "none", insertAt: afterImports(program) };
}

export function findPage(program: AstNode): PageSite {
  let fn: AstNode | undefined;
  for (const statement of program.body as AstNode[]) {
    if (statement.type !== "ExportDefaultDeclaration") continue;
    const declaration = statement.declaration as AstNode;
    if (declaration.type === "FunctionDeclaration") fn = declaration;
    else if (declaration.type === "Identifier") {
      fn = (program.body as AstNode[]).find((s) => s.type === "FunctionDeclaration" && (s.id as AstNode | null)?.name === declaration.name);
    }
  }
  if (!fn) return { kind: "unsupported", reason: "the page's default export isn't a function declaration" };
  const returns = returnsOf(fn);
  const root = returns.length === 1 && returns[0]!.argument ? unwrap(returns[0]!.argument as AstNode) : null;
  if (!root || (root.type !== "JSXElement" && root.type !== "JSXFragment")) return { kind: "unsupported", reason: "the page doesn't end in a single `return (<…>)`" };
  if (root.type === "JSXElement" && (root.openingElement as AstNode).selfClosing) return { kind: "unsupported", reason: "the page returns one self-closing element" };
  return { kind: "page", fn, root, names: functionScope(fn, returns[0]!.start) };
}

function chain(node: AstNode): string[] | null {
  if (node.type === "Identifier") return [node.name as string];
  if ((node.type === "MemberExpression" || node.type === "OptionalMemberExpression") && !node.computed && (node.property as AstNode).type === "Identifier") {
    const head = chain(node.object as AstNode);
    return head ? [...head, (node.property as AstNode).name as string] : null;
  }
  return null;
}

/** The roots themselves plus every member path (and prefix) the file uses on them, e.g. `procedure.summary.en`. */
export function memberPaths(program: AstNode, roots: string[]): string[] {
  const allowed = new Set(roots);
  const out = new Set(roots);
  walk(program, (node) => {
    if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") return;
    const parts = chain(node);
    if (!parts || !allowed.has(parts[0]!)) return;
    for (let i = 2; i <= parts.length; i++) out.add(parts.slice(0, i).join("."));
  });
  return [...out].sort().slice(0, 80);
}

/** `/procedures/:slug` → `/procedures/{slug}`, using a param binding in scope; null when a param isn't reachable. */
export function urlTemplate(pathPattern: string, names: string[], source: string): string | null {
  const out: string[] = [];
  for (const segment of pathPattern.split("/").filter(Boolean)) {
    if (!segment.startsWith(":")) { out.push(segment); continue; }
    const param = segment.slice(1);
    if (names.includes(param)) out.push(`{${param}}`);
    else if (names.includes("params") && !/await\s+params\b/.test(source)) out.push(`{params.${param}}`);
    else return null;
  }
  return `/${out.join("/")}`;
}
