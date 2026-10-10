# Fix Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After each analysis, Eumon opens small draft GitHub PRs on Next.js App Router sites. The PRs add or correct head tags, JSON-LD, `llms.txt` and AI-search robots rules. Each PR is checked against the site's own CI and preview deploy before it leaves draft, and a human merges it.

**Architecture:** The new package `packages/fixes` holds everything that can be tested without Cloudflare:
- detection: crawl data plus repo routes become fix candidates;
- scope reading and rule-based edits on a `@babel/parser` syntax tree;
- a validator that every edit must pass.

The AI writes only words (`packages/agents/src/fix-text.ts`), under the guardrails from MedBay's content scripts. `apps/web` stages fixes in the `changes` table at the end of the analysis workflow and opens PRs within a per-site budget. A signature-verified GitHub webhook and a daily sweep move each PR through `draft → ready → merged`.

**Tech Stack:**
- TypeScript, Cloudflare Workers + Workflows, D1
- `@babel/parser` (new; parsing only, no `@babel/traverse`)
- GitHub REST + GraphQL
- `node:test`

**Spec:** `docs/superpowers/specs/2026-10-10-fix-engine-design.md`. Read §12, "Corrections from the code research": it overrides earlier sections where they differ.

## Global Constraints

- **Workspace:**
  - Work in `/home/gabrielchin/Desktop/workstation/eumon-security`, branch `claude/fix-engine`.
  - Use absolute paths, or `cd <worktree> && …` in every command.
  - Never `cd` into two worktrees in parallel shell calls.
- **Remote and external services:**
  - Never run `db:migrate:remote`, deploy, push, or anything against the remote Cloudflare account.
  - Never make real GitHub API calls in tests; use fakes.
- **Dev server:** local checks use port 5175 (`cd apps/web && npx vite dev --port 5175 --strictPort`). Never touch 5174.
- **Tests:**
  - Packages: `npm test -w @organic-growth/<pkg>` (tsc to `dist-test`, relative imports end in `.js`).
  - Web: `cd apps/web && node --test "src/**/*.test.ts" "app/**/*.test.ts"` (imports end in `.ts`; nothing a test imports may import `cloudflare:workers`).
- **Build order:** after changing any package, run `npm run build:packages` before web tests or typecheck. `@organic-growth/fixes` builds after `repo-analyzer` and before `agents`.
- **Typecheck:** `cd apps/web && npm run typecheck` must exit 0.
- **Commits:** end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not stage `.superpowers/`.
- **Framework scope:** Next.js App Router only. The analyzer's fingerprint must say `framework === "Next.js"` and `router === "App Router"`. Anything else: no candidates.
- **Fix types:** `metadata-base`, `head`, `jsonld`, `llms-txt`, `ai-robots`. No content edits (alt text, FAQ blocks), no auto-merge, and no AI *training*-bot rules.
- **AI budget and limits:**
  - 30 AI calls per analysis (the constant `FIX_AI_CALLS` in `apps/web/src/fix-steps.ts`; no env var).
  - At most 12 candidates per analysis, and 3 per workflow step.
- **PR budget:** default 3 open Eumon PRs per site (`site_fix_settings.fix_budget`, 1–5). Drafts close after 7 days.
- **Subrequests (Free plan, 50 per request or step):**
  - stage at most 3 candidates per workflow step;
  - open at most 3 PRs per step (`max`, default 3);
  - the daily sweep handles at most 8 open fixes per run, oldest first. This replaces the spec's "20 per site", which wouldn't fit in one cron invocation.
- **Copy:** every user-facing message is a full sentence that says what happens next. Match the existing tone.
- **Migration number:** before writing `0025_fix_engine.sql`, run `git fetch origin && git ls-tree --name-only origin/main packages/db/migrations/ | tail -2`. If `0025` is taken, use the next free number everywhere this plan says `0025`.

## Review Focus

1. **The route file changed between analysis and PR.** Someone edits the page on `main` after the analysis. The fix must not open on top of the new code: the SHA guard closes it with a clear note, and it is re-detected next time. Test in Task 11.
2. **The preview deploy is password-protected** (Vercel deployment protection answers 401/403). This must count as "no preview available" and fall back to a build-only ready, not fail the fix. Test in Task 13.
3. **A webhook for a PR Eumon didn't open, or a repo no site uses.** It must answer 200 and change nothing. Test in Task 13.
4. **A repo with no CI checks at all.** Zero checks counts as passing; the preview check alone decides. Test in Task 10.
5. **The same route and fix type is found again while its PR is still open, or after a human rejected it.** It must not be staged again. Test in Task 11.

---

## File structure

```
packages/fixes/
  package.json, tsconfig.json, tsconfig.test.json
  src/index.ts          re-exports
  src/types.ts          FixKind, HeadProblem, PageHead, RouteRef, FixCandidate, Edit, Range, EditResult, DetectInput
  src/ast.ts            parseModule, walk, unwrap, lineIndent, hasDirective, FUNCTION_TYPES
  src/match.ts          pathOf, stripLocale, patternRegex, routeForPath
  src/detect.ts         headProblems, schemaTypeFor, detect
  src/scope.ts          findMetadata, findPage, functionScope, bindingNames, memberPaths, urlTemplate, returnsOf
  src/validate.ts       applyEdits, validateEdit, ALLOWED_FILES
  src/code.ts           toCode, placeholders, propertyNamed, setProperties
  src/edit/metadata.ts  editMetadata, editMetadataBase
  src/edit/jsonld.ts    JSON_LD_COMPONENT, componentPath, importPath, jsonLdCode, editJsonLd
  src/edit/llms-txt.ts  LLMS_MARKER, buildLlmsTxt, editLlmsTxt
  src/edit/ai-robots.ts AI_SEARCH_AGENTS, blockedAiSearchAgents, editAiRobots
  src/snippet.ts        metadataSnippet, jsonLdSnippet
  src/*.test.ts, src/edit/*.test.ts
packages/agents/src/fix-text.ts (+ test)       AI words with guardrails
packages/agents/src/github-pr.ts               + file/PR/check helpers (+ test)
packages/db/migrations/0025_fix_engine.sql
packages/db/src/fixes.ts (+ test)              staged fixes, settings, page heads
packages/core/src/types.ts                     ChangeStatus gains fix statuses
apps/web/src/fix-run.ts (+ test)               stage, open, merged-check orchestration (injected deps)
apps/web/src/fix-steps.ts                      the analysis workflow's fixes-* steps: builds DetectInput from D1 + GitHub (runtime)
apps/web/src/fix-github.ts                     wires github-pr helpers to an installation token (runtime)
apps/web/src/github-webhook.ts (+ test)        signature, event handling, preview verification
apps/web/src/fix-sweep.ts (+ test)             daily sweep
apps/web/src/analysis-workflow.ts              new fixes-* steps
apps/web/worker.ts                             sweep in scheduled()
apps/web/app/api/github/webhook/route.ts
apps/web/app/api/sites/[siteId]/fixes/route.ts
apps/web/app/api/fixes/[fixId]/open/route.ts, reject/route.ts
apps/web/app/components/FixesPanel.tsx
```

---

### Task 1: Scaffold `packages/fixes` with AST helpers

**Files:**
- Create: `packages/fixes/package.json`, `packages/fixes/tsconfig.json`, `packages/fixes/tsconfig.test.json`, `packages/fixes/src/index.ts`, `packages/fixes/src/types.ts`, `packages/fixes/src/ast.ts`
- Test: `packages/fixes/src/ast.test.ts`
- Modify: root `package.json` (`build:packages`: add `npm run build -w @organic-growth/fixes &&` right before `npm run build -w @organic-growth/agents`)
- Modify: `apps/web/package.json` (add `"@organic-growth/fixes": "*"` to dependencies)

**Interfaces:**
- Produces: everything in `types.ts` (used by every later task), and `parseModule(source: string): AstNode`, `walk`, `unwrap`, `lineIndent`, `hasDirective`, `FUNCTION_TYPES` from `ast.ts`.

- [ ] **Step 1: Package files.**

`packages/fixes/package.json`:

```json
{
  "name": "@organic-growth/fixes",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "tsc -p tsconfig.test.json && node --test \"dist-test/**/*.test.js\""
  },
  "dependencies": { "@organic-growth/core": "*", "@babel/parser": "^7.28.0" },
  "devDependencies": { "typescript": "^5.9.2", "@types/node": "^22.0.0" }
}
```

`packages/fixes/tsconfig.json`:

```json
{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"bundler","declaration":true,"outDir":"dist","rootDir":"src","strict":true,"skipLibCheck":true},"include":["src/**/*.ts"],"exclude":["src/**/*.test.ts"]}
```

`packages/fixes/tsconfig.test.json`:

```json
{"extends":"./tsconfig.json","compilerOptions":{"outDir":"dist-test","declaration":false,"types":["node"]},"include":["src/**/*.ts"],"exclude":[]}
```

Run `cd /home/gabrielchin/Desktop/workstation/eumon-security && npm install --no-audit --no-fund`, then confirm `node_modules/@babel/parser` exists. Use whatever 7.x version npm resolves. The lockfile diff must only add `@babel/parser` and its dependency `@babel/types`, plus the workspace link. If it rewrites unrelated entries, restore the lockfile and use `npm install @babel/parser@^7 -w @organic-growth/fixes --no-audit --no-fund` instead.

- [ ] **Step 2: `src/types.ts`:**

```ts
export type FixKind = "metadata-base" | "head" | "jsonld" | "llms-txt" | "ai-robots";

export type HeadProblem =
  | "title-missing" | "title-duplicate" | "title-too-long"
  | "description-missing" | "description-duplicate" | "description-length"
  | "canonical-missing" | "hreflang-missing";

/** What Google received for one crawled URL (from `pages.result_json`). */
export type PageHead = {
  url: string;
  status: number;
  title?: string;
  description?: string;
  canonical?: string;
  hreflang: Array<{ lang: string; href: string }>;
  jsonLdTypes: string[];
  /** The first H1's text, from the crawl's heading outline. */
  heading?: string;
};

/** The parts of the repo analyzer's RouteInspection the engine uses. Patterns use `:param`, e.g. `/procedures/:slug`. */
export type RouteRef = {
  pathPattern: string;
  source: string;
  dynamic: boolean;
  rendering: string;
  metadata: "server" | "client" | "inherited" | "none";
};

export type FixCandidate = {
  kind: FixKind;
  file: string;
  route?: RouteRef;
  problems: HeadProblem[];
  /** Affected URLs, at most 20. */
  urls: string[];
  pageCount: number;
  score: number;
  schemaType?: string;
  /** Locale prefixes seen on the site (e.g. ["id", "zh"]), for hreflang. */
  locales?: string[];
};

export type Edit = { start: number; end: number; text: string };
export type Range = { start: number; end: number };

/** An edit the validator can check, or a skip with a ready-to-paste snippet. `files` holds whole files to write (new component, llms.txt, robots.txt). */
export type EditResult =
  | { ok: true; edits: Edit[]; allowedRanges: Range[]; roots: string[]; files: Record<string, string>; summary: string }
  | { ok: false; reason: string; snippet: string };

export type DetectInput = {
  origin: string;
  siteName: string;
  pages: PageHead[];
  routes: RouteRef[];
  rootLayout?: { path: string; hasMetadataBase: boolean };
  llmsTxt: { exists: boolean; managedByEumon: boolean };
  /** `path` is set only when a static public/robots.txt exists. */
  robots: { path?: string; blocksAiSearch: string[] };
  allowAiSearch: boolean;
  limit?: number;
};
```

- [ ] **Step 3: Write the failing test.** Create `src/ast.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasDirective, lineIndent, parseModule, unwrap, walk, type AstNode } from "./ast.js";

describe("ast helpers", () => {
  it("parses TSX and walks every node", () => {
    const program = parseModule(`import a from "a";\nexport default function Page() { return <main><h1>Hi</h1></main>; }`);
    const types: string[] = [];
    walk(program, (node) => { types.push(node.type); });
    assert.ok(types.includes("JSXElement"));
    assert.ok(types.includes("ImportDeclaration"));
  });

  it("skips a subtree when the visitor says so", () => {
    const program = parseModule(`function a() { function b() { return 1; } return 2; }`);
    const returns: number[] = [];
    walk(program, (node) => {
      if (node.type === "FunctionDeclaration" && (node.id as AstNode).name === "b") return "skip";
      if (node.type === "ReturnStatement") returns.push(node.start);
    });
    assert.equal(returns.length, 1);
  });

  it("unwraps satisfies/as and reads indentation and directives", () => {
    const source = `"use client";\nexport const metadata = { title: "x" } satisfies Metadata;`;
    const program = parseModule(source);
    assert.equal(hasDirective(program, "use client"), true);
    let init: AstNode | undefined;
    walk(program, (node) => { if (node.type === "VariableDeclarator") init = node.init as AstNode; });
    assert.equal(unwrap(init!).type, "ObjectExpression");
    assert.equal(lineIndent("a\n    b", 6), "    ");
  });
});
```

- [ ] **Step 4: Run it and confirm it fails.** Run `npm test -w @organic-growth/fixes`. Expected: FAIL, because `./ast.js` is missing.

- [ ] **Step 5: `src/ast.ts`:**

```ts
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
```

`src/index.ts`:

```ts
export * from "./types.js";
export * from "./ast.js";
```

Later tasks append their modules' `export * from` lines.

- [ ] **Step 6: Run the tests and confirm they pass.** Run `npm test -w @organic-growth/fixes`. Expected: PASS, 3/3. Then `npm run build:packages` succeeds.
- [ ] **Step 7: Commit.**

```bash
git add packages/fixes package.json package-lock.json apps/web/package.json
git commit -m "Fix engine: packages/fixes with Babel AST helpers"
```

### Task 2: Route matching and detection

**Files:**
- Create: `packages/fixes/src/match.ts`, `packages/fixes/src/detect.ts`
- Test: `packages/fixes/src/detect.test.ts`
- Modify: `packages/fixes/src/index.ts` (add `export * from "./match.js"; export * from "./detect.js";`)

**Interfaces:**
- Consumes: `types.ts`.
- Produces:
  - `pathOf(url: string): string`
  - `stripLocale(path: string): { locale: string | null; path: string }`
  - `patternRegex(pattern: string): RegExp`
  - `routeForPath(path: string, routes: RouteRef[]): RouteRef | undefined`
  - `headProblems(pages: PageHead[], siteName: string, multiLocale: Set<string>): Map<string, HeadProblem[]>`
  - `schemaTypeFor(pattern: string): string`
  - `detect(input: DetectInput): FixCandidate[]`

- [ ] **Step 1: Write the failing test.** `src/detect.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detect, schemaTypeFor } from "./detect.js";
import { routeForPath, stripLocale } from "./match.js";
import type { DetectInput, PageHead, RouteRef } from "./types.js";

const route = (pathPattern: string, source: string, dynamic = pathPattern.includes(":")): RouteRef =>
  ({ pathPattern, source, dynamic, rendering: "ssr", metadata: "server" });
const page = (url: string, head: Partial<PageHead> = {}): PageHead =>
  ({ url, status: 200, title: `${url} title that is fine`, description: "d".repeat(120), canonical: url, hreflang: [], jsonLdTypes: ["WebPage"], ...head });

const routes = [route("/", "app/page.tsx"), route("/procedures/:slug", "app/procedures/[slug]/page.tsx"), route("/procedures/featured", "app/procedures/featured/page.tsx")];
const base: DetectInput = {
  origin: "https://x.com", siteName: "MedBay", pages: [], routes,
  rootLayout: { path: "app/layout.tsx", hasMetadataBase: true },
  llmsTxt: { exists: true, managedByEumon: false }, robots: { blocksAiSearch: [] }, allowAiSearch: false,
};

describe("matching", () => {
  it("prefers the route with more static segments and strips locale prefixes", () => {
    assert.equal(routeForPath("/procedures/featured", routes)?.source, "app/procedures/featured/page.tsx");
    assert.equal(routeForPath("/procedures/acl", routes)?.source, "app/procedures/[slug]/page.tsx");
    assert.deepEqual(stripLocale("/id/procedures/acl"), { locale: "id", path: "/procedures/acl" });
    assert.deepEqual(stripLocale("/identity"), { locale: null, path: "/identity" });
  });

  it("picks a schema type from the route's words", () => {
    assert.equal(schemaTypeFor("/"), "Organization");
    assert.equal(schemaTypeFor("/procedures/:slug"), "MedicalProcedure");
    assert.equal(schemaTypeFor("/doctors/:slug"), "Physician");
    assert.equal(schemaTypeFor("/things/:slug"), "WebPage");
  });
});

describe("detect", () => {
  it("groups head problems per route into one candidate", () => {
    const pages = [
      page("https://x.com/procedures/a", { title: "MedBay", description: undefined }),
      page("https://x.com/procedures/b", { title: "Same", description: "short" }),
      page("https://x.com/procedures/c", { title: "Same" }),
    ];
    const [head] = detect({ ...base, pages }).filter((c) => c.kind === "head");
    assert.equal(head?.file, "app/procedures/[slug]/page.tsx");
    assert.deepEqual(head?.problems, ["description-length", "description-missing", "title-duplicate", "title-missing"]);
    assert.equal(head?.urls.length, 3);
  });

  it("waits for metadataBase before fixing canonicals", () => {
    const pages = [page("https://x.com/procedures/a", { canonical: undefined }), page("https://x.com/procedures/b", { canonical: undefined })];
    const out = detect({ ...base, pages, rootLayout: { path: "app/layout.tsx", hasMetadataBase: false } });
    assert.equal(out.find((c) => c.kind === "head"), undefined, "no canonical-only head fix yet");
    assert.equal(out.find((c) => c.kind === "metadata-base")?.pageCount, 2);
  });

  it("flags hreflang only on paths that exist in more than one locale", () => {
    const pages = [page("https://x.com/procedures/a"), page("https://x.com/id/procedures/a"), page("https://x.com/procedures/b")];
    const head = detect({ ...base, pages }).find((c) => c.kind === "head");
    assert.deepEqual(head?.problems, ["hreflang-missing"]);
    assert.deepEqual(head?.urls.sort(), ["https://x.com/id/procedures/a", "https://x.com/procedures/a"]);
    assert.deepEqual(head?.locales, ["id"]);
  });

  it("proposes JSON-LD for dynamic routes mostly without it, plus llms.txt and AI robots when allowed", () => {
    const pages = [page("https://x.com/procedures/a", { jsonLdTypes: [] }), page("https://x.com/procedures/b", { jsonLdTypes: [] })];
    const out = detect({ ...base, pages, llmsTxt: { exists: false, managedByEumon: false }, robots: { path: "public/robots.txt", blocksAiSearch: ["OAI-SearchBot"] }, allowAiSearch: true });
    assert.equal(out.find((c) => c.kind === "jsonld")?.schemaType, "MedicalProcedure");
    assert.ok(out.some((c) => c.kind === "llms-txt"));
    assert.ok(out.some((c) => c.kind === "ai-robots"));
    assert.equal(detect({ ...base, pages, robots: { path: "public/robots.txt", blocksAiSearch: ["OAI-SearchBot"] } }).some((c) => c.kind === "ai-robots"), false, "off unless the site allows AI search");
  });

  it("ignores pages that aren't 200 and caps candidates and URLs", () => {
    const pages = Array.from({ length: 30 }, (_, i) => page(`https://x.com/procedures/p${i}`, { description: undefined }));
    pages.push(page("https://x.com/procedures/gone", { status: 404, title: undefined }));
    const head = detect({ ...base, pages, limit: 1 });
    assert.equal(head.length, 1);
    assert.equal(head[0]!.urls.length, 20);
    assert.ok(!head[0]!.urls.includes("https://x.com/procedures/gone"));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `npm test -w @organic-growth/fixes`. Expected: FAIL, because the modules are missing.

- [ ] **Step 3: `src/match.ts`:**

```ts
import type { RouteRef } from "./types.js";

// ponytail: a fixed list of locale prefixes; read the site's real locales from the crawl when a site uses others.
const LOCALE = /^\/(id|ms|zh|th|vi|km|en|ja|ko|ar|tl|my|lo)(?=\/|$)/i;

export function pathOf(url: string): string {
  try { return new URL(url).pathname.replace(/\/+$/, "") || "/"; } catch { return "/"; }
}

export function stripLocale(path: string): { locale: string | null; path: string } {
  const match = LOCALE.exec(path);
  return match ? { locale: match[1]!.toLowerCase(), path: path.slice(match[0].length) || "/" } : { locale: null, path };
}

// ponytail: `:x` matches one segment, so a catch-all `[...x]` route only matches single-segment paths.
export function patternRegex(pattern: string): RegExp {
  if (pattern === "/") return /^\/?$/;
  const body = pattern.split("/").filter(Boolean)
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/");
  return new RegExp(`^/${body}/?$`);
}

const staticSegments = (pattern: string) => pattern.split("/").filter((s) => s && !s.startsWith(":")).length;

export function routeForPath(path: string, routes: RouteRef[]): RouteRef | undefined {
  return routes.filter((route) => patternRegex(route.pathPattern).test(path))
    .sort((a, b) => staticSegments(b.pathPattern) - staticSegments(a.pathPattern))[0];
}
```

- [ ] **Step 4: `src/detect.ts`:**

```ts
import { pathOf, routeForPath, stripLocale } from "./match.js";
import type { DetectInput, FixCandidate, HeadProblem, PageHead, RouteRef } from "./types.js";

const WEIGHT = { "metadata-base": 5, "ai-robots": 4, head: 3, jsonld: 2, "llms-txt": 1 } as const;

const SCHEMA_BY_WORD: Array<[RegExp, string]> = [
  [/doctor|physician|specialist|dentist/i, "Physician"],
  [/hospital|clinic/i, "Hospital"],
  [/procedure|treatment|surgery|test/i, "MedicalProcedure"],
  [/product|shop|item/i, "Product"],
  [/blog|post|article|news|guide/i, "Article"],
  [/service/i, "Service"],
];

export function schemaTypeFor(pattern: string): string {
  if (pattern === "/") return "Organization";
  const words = pattern.split("/").filter((s) => s && !s.startsWith(":")).join(" ");
  return SCHEMA_BY_WORD.find(([re]) => re.test(words))?.[1] ?? "WebPage";
}

/** Head-tag problems per URL for one route's pages (duplicates are counted within the route). */
export function headProblems(pages: PageHead[], siteName: string, multiLocale: Set<string>): Map<string, HeadProblem[]> {
  const live = pages.filter((p) => p.status === 200);
  const key = (value?: string) => value?.trim().toLowerCase() ?? "";
  const counts = (values: string[]) => values.reduce((map, v) => (v ? map.set(v, (map.get(v) ?? 0) + 1) : map), new Map<string, number>());
  const titles = counts(live.map((p) => key(p.title)));
  const descriptions = counts(live.map((p) => key(p.description)));
  const site = key(siteName);
  const out = new Map<string, HeadProblem[]>();
  for (const page of live) {
    const problems: HeadProblem[] = [];
    const title = page.title?.trim() ?? "";
    if (!title || key(title) === site) problems.push("title-missing");
    else {
      if ((titles.get(key(title)) ?? 0) > 1) problems.push("title-duplicate");
      if (title.length > 65) problems.push("title-too-long");
    }
    const description = page.description?.trim() ?? "";
    if (!description) problems.push("description-missing");
    else {
      if ((descriptions.get(key(description)) ?? 0) > 1) problems.push("description-duplicate");
      if (description.length < 70 || description.length > 170) problems.push("description-length");
    }
    if (!page.canonical) problems.push("canonical-missing");
    if (page.hreflang.length === 0 && multiLocale.has(stripLocale(pathOf(page.url)).path)) problems.push("hreflang-missing");
    if (problems.length) out.set(page.url, problems);
  }
  return out;
}

export function detect(input: DetectInput): FixCandidate[] {
  const locales = new Map<string, Set<string>>();
  for (const page of input.pages) {
    const { locale, path } = stripLocale(pathOf(page.url));
    locales.set(path, (locales.get(path) ?? new Set<string>()).add(locale ?? "default"));
  }
  const multiLocale = new Set([...locales].filter(([, set]) => set.size > 1).map(([path]) => path));
  const siteLocales = [...new Set([...locales.values()].flatMap((set) => [...set]))].filter((l) => l !== "default").sort();

  const byRoute = new Map<RouteRef, PageHead[]>();
  for (const page of input.pages) {
    const path = pathOf(page.url);
    const route = routeForPath(path, input.routes) ?? routeForPath(stripLocale(path).path, input.routes);
    if (route) byRoute.set(route, [...(byRoute.get(route) ?? []), page]);
  }

  const candidates: FixCandidate[] = [];
  const waitForBase = Boolean(input.rootLayout && !input.rootLayout.hasMetadataBase);
  let canonicalPages = 0;
  for (const [route, pages] of byRoute) {
    const problems = headProblems(pages, input.siteName, multiLocale);
    const kinds = new Set([...problems.values()].flat());
    if (waitForBase && kinds.has("canonical-missing")) {
      canonicalPages += [...problems.values()].filter((p) => p.includes("canonical-missing")).length;
      kinds.delete("canonical-missing");
    }
    const affected = [...problems].filter(([, p]) => p.some((x) => kinds.has(x))).map(([url]) => url);
    if (kinds.size && affected.length) {
      candidates.push({
        kind: "head", file: route.source, route, problems: [...kinds].sort(), urls: affected, pageCount: pages.length,
        score: WEIGHT.head * affected.length, ...(kinds.has("hreflang-missing") ? { locales: siteLocales } : {}),
      });
    }
    const withoutSchema = pages.filter((p) => p.status === 200 && p.jsonLdTypes.length === 0);
    if ((route.dynamic || route.pathPattern === "/") && withoutSchema.length > 0 && withoutSchema.length * 2 >= pages.length) {
      candidates.push({ kind: "jsonld", file: route.source, route, problems: [], urls: withoutSchema.map((p) => p.url), pageCount: pages.length, score: WEIGHT.jsonld * withoutSchema.length, schemaType: schemaTypeFor(route.pathPattern) });
    }
  }
  if (waitForBase && canonicalPages > 0) {
    candidates.push({ kind: "metadata-base", file: input.rootLayout!.path, problems: ["canonical-missing"], urls: [], pageCount: canonicalPages, score: WEIGHT["metadata-base"] * canonicalPages });
  }
  if (!input.llmsTxt.exists || input.llmsTxt.managedByEumon) {
    candidates.push({ kind: "llms-txt", file: "public/llms.txt", problems: [], urls: [], pageCount: input.pages.length, score: WEIGHT["llms-txt"] * 50 });
  }
  if (input.allowAiSearch && input.robots.path && input.robots.blocksAiSearch.length) {
    candidates.push({ kind: "ai-robots", file: input.robots.path, problems: [], urls: [], pageCount: input.pages.length, score: WEIGHT["ai-robots"] * 50 });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, input.limit ?? 12).map((c) => ({ ...c, urls: c.urls.slice(0, 20) }));
}
```

- [ ] **Step 5: Run the tests and confirm they pass.** Run `npm test -w @organic-growth/fixes`. Expected: PASS.
- [ ] **Step 6: Commit.** `git add packages/fixes && git commit -m "Fix engine: route matching and fix detection"`

### Task 3: Scope reading

**Files:**
- Create: `packages/fixes/src/scope.ts`
- Test: `packages/fixes/src/scope.test.ts`
- Modify: `src/index.ts` (add `export * from "./scope.js";`)

**Interfaces:**
- Produces:
  - `type MetadataSite = { kind: "object"; object: AstNode; names: string[] } | { kind: "function"; object: AstNode; names: string[] } | { kind: "none"; insertAt: number } | { kind: "unsupported"; reason: string }`
  - `findMetadata(program: AstNode): MetadataSite`
  - `type PageSite = { kind: "page"; fn: AstNode; root: AstNode; names: string[] } | { kind: "unsupported"; reason: string }`
  - `findPage(program: AstNode): PageSite`
  - `returnsOf(fn: AstNode): AstNode[]`
  - `bindingNames(pattern: AstNode): string[]`
  - `functionScope(fn: AstNode, before: number): string[]`
  - `memberPaths(program: AstNode, roots: string[]): string[]`
  - `urlTemplate(pathPattern: string, names: string[], source: string): string | null`, which returns a `{placeholder}` pattern such as `/procedures/{slug}`
  - `afterImports(program: AstNode): number`

- [ ] **Step 1: Write the failing test.** `src/scope.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseModule } from "./ast.js";
import { findMetadata, findPage, memberPaths, urlTemplate } from "./scope.js";

const dynamicPage = `import { getProcedure } from "@/lib/data";
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const procedure = await getProcedure(slug);
  return { title: procedure.name };
}
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const procedure = await getProcedure(slug);
  return (
    <main>
      <h1>{procedure.name}</h1>
      <p>{procedure.summary.en}</p>
    </main>
  );
}`;

describe("scope", () => {
  it("finds generateMetadata's returned object and the names in scope before it", () => {
    const site = findMetadata(parseModule(dynamicPage));
    assert.equal(site.kind, "function");
    if (site.kind !== "function") return;
    assert.deepEqual(site.names.sort(), ["params", "procedure", "slug"]);
  });

  it("lists member paths used in the file for in-scope roots", () => {
    const program = parseModule(dynamicPage);
    const paths = memberPaths(program, ["procedure", "slug"]);
    assert.ok(paths.includes("procedure.name"));
    assert.ok(paths.includes("procedure.summary.en"));
    assert.ok(paths.includes("slug"));
    assert.ok(!paths.some((p) => p.startsWith("getProcedure")));
  });

  it("finds the page's single returned JSX and its scope", () => {
    const site = findPage(parseModule(dynamicPage));
    assert.equal(site.kind, "page");
    if (site.kind === "page") assert.ok(site.names.includes("procedure"));
  });

  it("reports static metadata objects, absent metadata, and unsupported shapes", () => {
    assert.equal(findMetadata(parseModule(`export const metadata = { title: "About" } satisfies Metadata;`)).kind, "object");
    assert.equal(findMetadata(parseModule(`import a from "a";\nexport default function P() { return <div/>; }`)).kind, "none");
    assert.equal(findMetadata(parseModule(`"use client";\nexport default function P() { return <div/>; }`)).kind, "unsupported");
    assert.equal(findMetadata(parseModule(`export const metadata = base;`)).kind, "unsupported");
    assert.equal(findMetadata(parseModule(`export async function generateMetadata() { if (x) return { title: "a" }; return { title: "b" }; }`)).kind, "unsupported");
    assert.equal(findPage(parseModule(`export default function P() { if (x) return <a/>; return <main></main>; }`)).kind, "unsupported");
  });

  it("builds a URL pattern from route params in scope, or gives up", () => {
    assert.equal(urlTemplate("/procedures/:slug", ["slug", "params"], dynamicPage), "/procedures/{slug}");
    assert.equal(urlTemplate("/procedures/:slug", ["params"], "export async function generateMetadata({ params }) {}"), "/procedures/{params.slug}");
    assert.equal(urlTemplate("/procedures/:slug", ["params"], "const { slug } = await params;"), null, "awaited params without a slug binding");
    assert.equal(urlTemplate("/about", [], ""), "/about");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `npm test -w @organic-growth/fixes`. Expected: FAIL.

- [ ] **Step 3: `src/scope.ts`:**

```ts
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

export function findMetadata(program: AstNode): MetadataSite {
  if (hasDirective(program, "use client")) return { kind: "unsupported", reason: "the file is a client component, where Next.js can't export metadata" };
  for (const statement of program.body as AstNode[]) {
    if (statement.type !== "ExportNamedDeclaration" || !statement.declaration) continue;
    const declaration = statement.declaration as AstNode;
    if (declaration.type === "VariableDeclaration") {
      for (const d of declaration.declarations as AstNode[]) {
        const id = d.id as AstNode;
        if (id.type !== "Identifier") continue;
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
```

- [ ] **Step 4: Run the tests and confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add packages/fixes && git commit -m "Fix engine: read metadata and page scope from route files"`

### Task 4: The validator

**Files:**
- Create: `packages/fixes/src/validate.ts`
- Test: `packages/fixes/src/validate.test.ts`
- Modify: `src/index.ts` (add `export * from "./validate.js";`)

**Interfaces:**
- Produces:
  - `applyEdits(source: string, edits: Edit[]): string`
  - `ALLOWED_FILES: RegExp[]`
  - `type ValidateInput = { filePath: string; before: string; edits: Edit[]; allowedRanges: Range[]; roots: string[]; sensitivePaths: string[]; maxChangedLines?: number }`
  - `validateEdit(input: ValidateInput): { ok: true; after: string } | { ok: false; reason: string }`
  - `validateFile(path: string, content: string, sensitivePaths: string[]): { ok: true } | { ok: false; reason: string }`, for whole-file writes

- [ ] **Step 1: Write the failing test.** `src/validate.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateEdit, validateFile } from "./validate.js";

const source = `import x from "x";\nexport const metadata = {\n  title: "Old",\n};\nexport default function P() { return <main/>; }\n`;
const objectStart = source.indexOf("{");
const objectEnd = source.indexOf("};") + 1;
const base = { filePath: "app/about/page.tsx", before: source, allowedRanges: [{ start: objectStart, end: objectEnd }], roots: ["procedure"], sensitivePaths: [] };
const insertAt = source.indexOf(`"Old",`) + `"Old",`.length;

describe("validateEdit", () => {
  it("accepts an edit inside the allowed object that uses in-scope names", () => {
    const result = validateEdit({ ...base, edits: [{ start: insertAt, end: insertAt, text: "\n  description: `${procedure.name} in Malaysia`," }] });
    assert.equal(result.ok, true);
  });

  it("refuses edits outside the allowed range", () => {
    const at = source.indexOf("<main/>");
    assert.match(String((validateEdit({ ...base, edits: [{ start: at, end: at, text: "x" }] }) as { reason?: string }).reason), /outside/);
  });

  it("refuses unknown variables, but not property keys or member names", () => {
    const bad = validateEdit({ ...base, edits: [{ start: insertAt, end: insertAt, text: "\n  description: `${doctor.name}`," }] });
    assert.match(String((bad as { reason?: string }).reason), /doctor/);
  });

  it("refuses an edit that breaks parsing", () => {
    assert.equal(validateEdit({ ...base, edits: [{ start: insertAt, end: insertAt, text: "\n  description: `${procedure.name" }] }).ok, false);
  });

  it("refuses files off the allowlist, sensitive paths and oversized diffs", () => {
    assert.equal(validateEdit({ ...base, filePath: "app/api/route.ts", edits: [] }).ok, false);
    assert.equal(validateEdit({ ...base, filePath: "app/auth/page.tsx", sensitivePaths: ["app/auth/page.tsx"], edits: [] }).ok, false);
    const big = Array.from({ length: 70 }, (_, i) => `\n  k${i}: "v",`).join("");
    assert.equal(validateEdit({ ...base, edits: [{ start: insertAt, end: insertAt, text: big }] }).ok, false);
  });

  it("refuses new imports other than the Eumon component", () => {
    const top = source.indexOf("\n") ;
    const sneaky = validateEdit({ ...base, allowedRanges: [{ start: top, end: top }], edits: [{ start: top, end: top, text: `\nimport fs from "fs";` }] });
    assert.equal(sneaky.ok, false);
    const fine = validateEdit({ ...base, allowedRanges: [{ start: top, end: top }], edits: [{ start: top, end: top, text: `\nimport { EumonJsonLd } from "../components/eumon-json-ld";` }] });
    assert.equal(fine.ok, true);
  });
});

describe("validateFile", () => {
  it("allows only the whole-file targets", () => {
    assert.equal(validateFile("public/llms.txt", "# x", []).ok, true);
    assert.equal(validateFile("components/eumon-json-ld.tsx", "export function EumonJsonLd() { return null; }", []).ok, true);
    assert.equal(validateFile("next.config.js", "x", []).ok, false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Expected: FAIL.

- [ ] **Step 3: `src/validate.ts`:**

```ts
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
```

In the import test, `EumonJsonLd` is an `ImportSpecifier` identifier and is skipped by `isReference`. JSX names are `JSXIdentifier` nodes, so they aren't checked.

- [ ] **Step 4: Run the tests and confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add packages/fixes && git commit -m "Fix engine: validator (region-only, in-scope names, file allowlist, size cap)"`

### Task 5: Code helpers and head-tag edits

**Files:**
- Create: `packages/fixes/src/code.ts`, `packages/fixes/src/edit/metadata.ts`, `packages/fixes/src/snippet.ts`
- Test: `packages/fixes/src/edit/metadata.test.ts`
- Modify: `src/index.ts` (add `export * from "./code.js"; export * from "./snippet.js"; export * from "./edit/metadata.js";`)

**Interfaces:**
- Consumes: `parseModule`, `unwrap`, `lineIndent` (Task 1); `findMetadata` (Task 3).
- Produces:
  - `toCode(pattern: string): string`, which turns `{a.b}` placeholders into a template literal, and a plain string literal otherwise
  - `placeholders(pattern: string): string[]`
  - `propertyNamed(object: AstNode, name: string): AstNode | undefined`
  - `setProperties(source: string, object: AstNode, entries: Array<[string, string]>): Edit[]`
  - `type MetadataPlan = { title?: string; description?: string; canonical?: string; languages?: Record<string, string> }`, where each value is a pattern in `{path}` form
  - `editMetadata(source: string, plan: MetadataPlan, dynamic: boolean): EditResult`
  - `editMetadataBase(source: string, origin: string): EditResult`
  - `metadataSnippet(plan: MetadataPlan, dynamic: boolean): string`

- [ ] **Step 1: Write the failing test.** `src/edit/metadata.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEdits, validateEdit } from "../validate.js";
import { editMetadata, editMetadataBase } from "./metadata.js";
import { toCode } from "../code.js";

const applied = (source: string, result: ReturnType<typeof editMetadata>, file = "app/procedures/[slug]/page.tsx") => {
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return "";
  const checked = validateEdit({ filePath: file, before: source, edits: result.edits, allowedRanges: result.allowedRanges, roots: result.roots, sensitivePaths: [] });
  assert.equal(checked.ok, true, checked.ok ? "" : checked.reason);
  return applyEdits(source, result.edits);
};

describe("toCode", () => {
  it("makes template literals only when there are placeholders, escaping backticks", () => {
    assert.equal(toCode("About us"), `"About us"`);
    assert.equal(toCode("{procedure.name} `cost`"), "`${procedure.name} \\`cost\\``");
  });
});

describe("editMetadata", () => {
  const dynamic = `export async function generateMetadata({ params }) {\n  const { slug } = await params;\n  const procedure = await get(slug);\n  return {\n    title: procedure.name\n  };\n}\n`;

  it("sets title, description and alternates inside generateMetadata's returned object", () => {
    const after = applied(dynamic, editMetadata(dynamic, { title: "{procedure.name} | MedBay", description: "{procedure.name} in Malaysia: costs and specialists.", canonical: "/procedures/{slug}" }, true));
    assert.match(after, /title: `\$\{procedure\.name\} \| MedBay`/);
    assert.match(after, /description: `\$\{procedure\.name\} in Malaysia: costs and specialists\.`/);
    assert.match(after, /alternates: \{ canonical: `\/procedures\/\$\{slug\}` \}/);
  });

  it("adds into an existing alternates object instead of replacing it", () => {
    const source = `export const metadata = {\n  title: "About",\n  alternates: { languages: { en: "/about" } },\n};\n`;
    const after = applied(source, editMetadata(source, { canonical: "/about" }, false), "app/about/page.tsx");
    assert.match(after, /alternates: \{ languages: \{ en: "\/about" \},\n  canonical: "\/about",? \}/);
  });

  it("adds a static metadata export to a static page without one", () => {
    const source = `import x from "x";\nexport default function P() { return <main/>; }\n`;
    const after = applied(source, editMetadata(source, { title: "About | MedBay" }, false), "app/about/page.tsx");
    assert.match(after, /import x from "x";\n\nexport const metadata = \{\n  title: "About \| MedBay",\n\};/);
  });

  it("skips with a snippet where it can't edit safely", () => {
    const none = editMetadata(`export default function P() { return <main/>; }`, { title: "{x.name}" }, true);
    assert.equal(none.ok, false);
    if (!none.ok) assert.match(none.snippet, /generateMetadata/);
    const client = editMetadata(`"use client";\nexport default function P() { return <main/>; }`, { title: "A" }, false);
    assert.equal(client.ok, false);
    const alias = editMetadata(`export const metadata = { alternates: shared };`, { canonical: "/a" }, false);
    assert.equal(alias.ok, false);
  });
});

describe("editMetadataBase", () => {
  it("adds metadataBase to the root layout's metadata", () => {
    const source = `export const metadata = { title: "MedBay" };\nexport default function L({ children }) { return <html><body>{children}</body></html>; }\n`;
    const after = applied(source, editMetadataBase(source, "https://medbaycare.com"), "app/layout.tsx");
    assert.match(after, /metadataBase: new URL\("https:\/\/medbaycare\.com"\)/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Expected: FAIL.

- [ ] **Step 3: `src/code.ts`:**

```ts
import { lineIndent, unwrap, type AstNode } from "./ast.js";
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

export { unwrap };
```

- [ ] **Step 4: `src/snippet.ts`:**

```ts
import { toCode } from "./code.js";
import type { MetadataPlan } from "./edit/metadata.js";

const languagesCode = (languages: Record<string, string>) => `{ ${Object.entries(languages).map(([lang, p]) => `${JSON.stringify(lang)}: ${toCode(p)}`).join(", ")} }`;

export function metadataSnippet(plan: MetadataPlan, dynamic: boolean): string {
  const lines: string[] = [];
  if (plan.title) lines.push(`title: ${toCode(plan.title)},`);
  if (plan.description) lines.push(`description: ${toCode(plan.description)},`);
  const alternates = [plan.canonical ? `canonical: ${toCode(plan.canonical)}` : "", plan.languages ? `languages: ${languagesCode(plan.languages)}` : ""].filter(Boolean);
  if (alternates.length) lines.push(`alternates: { ${alternates.join(", ")} },`);
  return dynamic
    ? `export async function generateMetadata({ params }) {\n  // Load the same data the page uses, then:\n  return {\n${lines.map((l) => `    ${l}`).join("\n")}\n  };\n}`
    : `export const metadata = {\n${lines.map((l) => `  ${l}`).join("\n")}\n};`;
}

export function jsonLdSnippet(dataCode: string): string {
  return `<script\n  type="application/ld+json"\n  dangerouslySetInnerHTML={{ __html: JSON.stringify(${dataCode}).replace(/</g, "\\\\u003c") }}\n/>`;
}

export { languagesCode };
```

- [ ] **Step 5: `src/edit/metadata.ts`:**

```ts
import { parseModule, unwrap, type AstNode } from "../ast.js";
import { propertyNamed, setProperties, toCode } from "../code.js";
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

function edit(source: string, entries: { top: Array<[string, string]>; alternates: Array<[string, string]> }, dynamic: boolean, snippet: string, summary: string): EditResult {
  if (!entries.top.length && !entries.alternates.length) return { ok: false, reason: "there's nothing to change", snippet };
  let program: AstNode;
  try { program = parseModule(source); } catch { return { ok: false, reason: "the file doesn't parse", snippet }; }
  const site = findMetadata(program);
  if (site.kind === "unsupported") return { ok: false, reason: site.reason, snippet };
  if (site.kind === "none") {
    if (dynamic) return { ok: false, reason: "the route is dynamic and has no generateMetadata to edit", snippet };
    const all = [...entries.top, ...(entries.alternates.length ? [["alternates", objectCode(entries.alternates)] as [string, string]] : [])];
    const text = `\n\nexport const metadata = {\n${all.map(([n, c]) => `  ${n}: ${c},`).join("\n")}\n};\n`;
    return { ok: true, edits: [{ start: site.insertAt, end: site.insertAt, text }], allowedRanges: [{ start: site.insertAt, end: site.insertAt }], roots: [], files: {}, summary };
  }
  const object = site.object;
  const altProp = propertyNamed(object, "alternates");
  const altValue = altProp ? unwrap(altProp.value as AstNode) : null;
  if (altProp && entries.alternates.length && altValue?.type !== "ObjectExpression") return { ok: false, reason: "`alternates` isn't a plain object", snippet };
  const edits = altValue?.type === "ObjectExpression" && entries.alternates.length
    ? [...setProperties(source, object, entries.top), ...setProperties(source, altValue, entries.alternates)]
    : setProperties(source, object, [...entries.top, ...(entries.alternates.length ? [["alternates", objectCode(entries.alternates)] as [string, string]] : [])]);
  return { ok: true, edits, allowedRanges: [{ start: object.start, end: object.end }], roots: site.names, files: {}, summary };
}

export function editMetadata(source: string, plan: MetadataPlan, dynamic: boolean): EditResult {
  const changed = [plan.title && "title", plan.description && "description", plan.canonical && "canonical", plan.languages && "hreflang"].filter(Boolean).join(", ");
  return edit(source, entriesOf(plan), dynamic, metadataSnippet(plan, dynamic), `Sets ${changed} in the route's metadata.`);
}

export function editMetadataBase(source: string, origin: string): EditResult {
  const entries = { top: [["metadataBase", `new URL(${JSON.stringify(origin)})`] as [string, string]], alternates: [] };
  return edit(source, entries, false, `export const metadata = {\n  metadataBase: new URL(${JSON.stringify(origin)}),\n};`, `Sets metadataBase to ${origin}, so canonical and hreflang URLs resolve to the live site.`);
}
```

If the regex in the "existing alternates" test doesn't match the exact output, adjust the **test's regex** to the actual (correct) output. `setProperties` keeps the existing `languages` and adds `canonical` after it, on a new line with the property's indentation. Don't change the edit logic just to fit the regex.

- [ ] **Step 6: Run the tests and confirm they pass.** Expected: PASS.
- [ ] **Step 7: Commit.** `git add packages/fixes && git commit -m "Fix engine: head-tag and metadataBase edits with snippets"`

### Task 6: JSON-LD edits

**Files:**
- Create: `packages/fixes/src/edit/jsonld.ts`
- Test: `packages/fixes/src/edit/jsonld.test.ts`
- Modify: `src/index.ts` (add `export * from "./edit/jsonld.js";`)

**Interfaces:**
- Consumes: `findPage` (Task 3), `toCode` (Task 5), `jsonLdSnippet` (Task 5).
- Produces:
  - `JSON_LD_COMPONENT: string`
  - `componentPath(treePaths: string[]): string`
  - `importPath(fromFile: string, target: string): string`
  - `type JsonLdPlan = { schemaType: string; fields: Array<{ field: string; path: string }>; url: string; origin: string }`, where `url` is a `{path}` pattern such as `/procedures/{slug}` or `/`
  - `jsonLdCode(plan: JsonLdPlan): string`
  - `editJsonLd(file: string, source: string, plan: JsonLdPlan, treePaths: string[]): EditResult`

- [ ] **Step 1: Write the failing test.** `src/edit/jsonld.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEdits, validateEdit, validateFile } from "../validate.js";
import { componentPath, editJsonLd, importPath, JSON_LD_COMPONENT } from "./jsonld.js";

const page = `import { get } from "@/lib/data";

export default async function Page({ params }) {
  const { slug } = await params;
  const procedure = await get(slug);
  return (
    <main className="wrap">
      <h1>{procedure.name}</h1>
    </main>
  );
}
`;
const plan = { schemaType: "MedicalProcedure", fields: [{ field: "name", path: "procedure.name" }], url: "/procedures/{slug}", origin: "https://x.com" };

describe("editJsonLd", () => {
  it("imports the component and renders it first inside the page root, with a breadcrumb", () => {
    const file = "app/procedures/[slug]/page.tsx";
    const result = editJsonLd(file, page, plan, ["app/page.tsx", file]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const checked = validateEdit({ filePath: file, before: page, edits: result.edits, allowedRanges: result.allowedRanges, roots: result.roots, sensitivePaths: [] });
    assert.equal(checked.ok, true, checked.ok ? "" : checked.reason);
    const after = applyEdits(page, result.edits);
    assert.match(after, /import \{ EumonJsonLd \} from "\.\.\/\.\.\/\.\.\/components\/eumon-json-ld";/);
    assert.match(after, /<main className="wrap">\n      <EumonJsonLd data=\{\[\{ "@context": "https:\/\/schema\.org", "@type": "MedicalProcedure", "name": procedure\.name, url: `https:\/\/x\.com\/procedures\/\$\{slug\}` \}, \{ "@context": "https:\/\/schema\.org", "@type": "BreadcrumbList"/);
    assert.equal(result.files["components/eumon-json-ld.tsx"], JSON_LD_COMPONENT);
    assert.equal(validateFile("components/eumon-json-ld.tsx", JSON_LD_COMPONENT, []).ok, true);
  });

  it("reuses an existing component and uses src/ layouts", () => {
    assert.equal(componentPath(["src/app/page.tsx"]), "src/components/eumon-json-ld.tsx");
    assert.equal(importPath("src/app/a/page.tsx", "src/components/eumon-json-ld.tsx"), "../../components/eumon-json-ld");
    const result = editJsonLd("app/procedures/[slug]/page.tsx", page, plan, ["components/eumon-json-ld.tsx"]);
    assert.ok(result.ok && Object.keys(result.files).length === 0);
  });

  it("skips pages it can't edit safely, or that already have it", () => {
    assert.equal(editJsonLd("app/a/page.tsx", `export default function P() { if (x) return <a/>; return <main></main>; }`, plan, []).ok, false);
    assert.equal(editJsonLd("app/a/page.tsx", page.replace("<h1>", "<EumonJsonLd data={{}} /><h1>"), plan, []).ok, false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Expected: FAIL.

- [ ] **Step 3: `src/edit/jsonld.ts`:**

```ts
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
```

If the long regex in Step 1 is off by formatting only (spacing inside `jsonLdCode`), fix the regex to match the output. The output must keep the shape: an array of the main object, then the breadcrumb.

- [ ] **Step 4: Run the tests and confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add packages/fixes && git commit -m "Fix engine: JSON-LD edits with a shared server component"`

### Task 7: `llms.txt` and AI-search robots rules

**Files:**
- Create: `packages/fixes/src/edit/llms-txt.ts`, `packages/fixes/src/edit/ai-robots.ts`
- Test: `packages/fixes/src/edit/files.test.ts`
- Modify: `src/index.ts` (add the two `export *` lines)

**Interfaces:**
- Produces:
  - `LLMS_MARKER = "<!-- maintained by Eumon -->"`
  - `buildLlmsTxt(input: { siteName: string; summary: string; pages: Array<{ url: string; title?: string; description?: string; section: string }> }): string`
  - `editLlmsTxt(existing: string | null, content: string): EditResult`
  - `AI_SEARCH_AGENTS: string[]`
  - `blockedAiSearchAgents(robots: string): string[]`
  - `editAiRobots(robots: string, agents: string[]): EditResult`

- [ ] **Step 1: Write the failing test.** `src/edit/files.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blockedAiSearchAgents, editAiRobots } from "./ai-robots.js";
import { buildLlmsTxt, editLlmsTxt, LLMS_MARKER } from "./llms-txt.js";

describe("llms.txt", () => {
  const content = buildLlmsTxt({ siteName: "MedBay", summary: "Medical travel to Malaysia.", pages: [
    { url: "https://x.com/procedures/a", title: "A", description: "About A", section: "Procedures" },
    { url: "https://x.com/doctors/b", title: "Dr B", section: "Doctors" },
  ] });

  it("writes the site, a summary, the marker, and pages grouped by section", () => {
    assert.match(content, /^# MedBay\n\n> Medical travel to Malaysia\.\n\n<!-- maintained by Eumon -->\n/);
    assert.match(content, /## Procedures\n- \[A\]\(https:\/\/x\.com\/procedures\/a\): About A/);
    assert.match(content, /## Doctors\n- \[Dr B\]\(https:\/\/x\.com\/doctors\/b\)\n/);
  });

  it("creates or refreshes its own file, never a hand-written one", () => {
    assert.equal(editLlmsTxt(null, content).ok, true);
    assert.equal(editLlmsTxt(`# Old\n${LLMS_MARKER}\n`, content).ok, true);
    assert.equal(editLlmsTxt(content, content).ok, false, "already up to date");
    assert.equal(editLlmsTxt("# Written by hand\n", content).ok, false);
  });
});

describe("AI search robots rules", () => {
  const robots = "User-agent: *\nAllow: /\n\nUser-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n";

  it("finds blocked AI search agents, ignoring training bots", () => {
    assert.deepEqual(blockedAiSearchAgents(robots), ["OAI-SearchBot"]);
  });

  it("turns only that group's Disallow: / into Allow: /", () => {
    const result = editAiRobots(robots, ["OAI-SearchBot"]);
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.files["public/robots.txt"], "User-agent: *\nAllow: /\n\nUser-agent: OAI-SearchBot\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n");
  });

  it("skips a group shared with other agents", () => {
    assert.equal(editAiRobots("User-agent: OAI-SearchBot\nUser-agent: GPTBot\nDisallow: /\n", ["OAI-SearchBot"]).ok, false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Expected: FAIL.

- [ ] **Step 3: `src/edit/llms-txt.ts`:**

```ts
import type { EditResult } from "../types.js";

export const LLMS_MARKER = "<!-- maintained by Eumon -->";
const PER_SECTION = 50;
const TOTAL = 200;

export function buildLlmsTxt(input: { siteName: string; summary: string; pages: Array<{ url: string; title?: string; description?: string; section: string }> }): string {
  const sections = new Map<string, string[]>();
  let total = 0;
  for (const page of input.pages) {
    const list = sections.get(page.section) ?? [];
    if (list.length >= PER_SECTION || total >= TOTAL) continue;
    list.push(`- [${(page.title ?? page.url).replace(/[[\]]/g, "")}](${page.url})${page.description ? `: ${page.description}` : ""}`);
    sections.set(page.section, list);
    total++;
  }
  const body = [...sections].map(([title, links]) => `## ${title}\n${links.join("\n")}\n`).join("\n");
  return `# ${input.siteName}\n\n> ${input.summary}\n\n${LLMS_MARKER}\n\n${body}`;
}

export function editLlmsTxt(existing: string | null, content: string): EditResult {
  if (existing !== null && !existing.includes(LLMS_MARKER)) return { ok: false, reason: "the site has a hand-written llms.txt, which Eumon leaves alone", snippet: content };
  if (existing === content) return { ok: false, reason: "llms.txt is already up to date", snippet: content };
  return { ok: true, edits: [], allowedRanges: [], roots: [], files: { "public/llms.txt": content }, summary: existing ? "Refreshes llms.txt from the latest crawl." : "Adds llms.txt so AI assistants can find the site's key pages." };
}
```

- [ ] **Step 4: `src/edit/ai-robots.ts`:**

```ts
import type { EditResult } from "../types.js";

/** AI *search* crawlers only. Training crawlers (GPTBot, Google-Extended…) are never touched. */
export const AI_SEARCH_AGENTS = ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot"];

type Group = { agents: string[]; rules: Array<{ index: number; field: string; value: string }> };

function groups(lines: string[]): Group[] {
  const out: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  lines.forEach((raw, index) => {
    const line = raw.replace(/#.*/, "").trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) return;
    const field = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; out.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      current?.rules.push({ index, field, value });
      lastWasAgent = false;
    }
  });
  return out;
}

export function blockedAiSearchAgents(robots: string): string[] {
  const all = groups(robots.split("\n"));
  return AI_SEARCH_AGENTS.filter((agent) => all.some((g) => g.agents.includes(agent.toLowerCase())
    && g.rules.some((r) => r.field === "disallow" && r.value === "/")
    && !g.rules.some((r) => r.field === "allow" && r.value === "/")));
}

export function editAiRobots(robots: string, agents: string[]): EditResult {
  const lines = robots.split("\n");
  const all = groups(lines);
  const change = new Set<number>();
  for (const agent of agents) {
    const group = all.find((g) => g.agents.includes(agent.toLowerCase()));
    if (!group) continue;
    if (group.agents.length > 1) return { ok: false, reason: `${agent} shares a robots.txt group with other crawlers`, snippet: `User-agent: ${agent}\nAllow: /` };
    for (const rule of group.rules) if (rule.field === "disallow" && rule.value === "/") change.add(rule.index);
  }
  if (!change.size) return { ok: false, reason: "nothing in robots.txt blocks AI search", snippet: "" };
  const next = lines.map((line, i) => (change.has(i) ? line.replace(/disallow\s*:\s*\//i, "Allow: /") : line)).join("\n");
  return { ok: true, edits: [], allowedRanges: [], roots: [], files: { "public/robots.txt": next }, summary: `Lets ${agents.join(", ")} read the site, so AI search can cite it.` };
}
```

- [ ] **Step 5: Run the tests and confirm they pass.** Expected: PASS.
- [ ] **Step 6: Commit.** `git add packages/fixes && git commit -m "Fix engine: llms.txt and AI-search robots rules"`

### Task 8: The AI text step with guardrails

**Files:**
- Create: `packages/agents/src/fix-text.ts`
- Test: `packages/agents/src/fix-text.test.ts`
- Modify: `packages/agents/package.json` (add `"@organic-growth/fixes": "*"` to dependencies)
- Modify: `packages/agents/src/index.ts` (add `export * from "./fix-text.js";` if the file re-exports modules; check with `grep -n "export \*" packages/agents/src/index.ts`)

**Interfaces:**
- Consumes: `placeholders` from `@organic-growth/fixes`; `JsonLlm`, `schema` from `@organic-growth/ai`.
- Produces:
  - `FIX_PROMPT_VERSION = "fix-text-1"`
  - `type FixSample = { url: string; title?: string; h1?: string; description?: string; text: string }`
  - `type FixTextInput = { kind: "head" | "jsonld"; siteName: string; language: string; problems: string[]; paths: string[]; dynamic: boolean; schemaType?: string; samples: FixSample[]; queries: string[] }`
  - `type FixText = { facts: string[]; titleSubject: string | null; titleQualifier: string | null; description: string | null; schema: Array<{ field: string; path: string }>; examples: Array<{ url: string; values: Array<{ path: string; value: string }> }> }`
  - `type FixTextResult = { ok: true; text: FixText; warnings: string[] } | { ok: false; reason: string }`
  - `render(pattern: string, values: Map<string, string>): string`
  - `titleOf(text: FixText, values: Map<string, string>, siteName: string, dynamic: boolean): string | null`
  - `checkFixText(input: FixTextInput, text: FixText): string[]`
  - `writeFixText(llm: JsonLlm, input: FixTextInput, budget: { calls: number }): Promise<FixTextResult>`

- [ ] **Step 1: Write the failing test.** `src/fix-text.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonLlm } from "@organic-growth/ai";
import { checkFixText, writeFixText, type FixText, type FixTextInput } from "./fix-text.js";

const input: FixTextInput = {
  kind: "head", siteName: "MedBay", language: "en", problems: ["title-missing", "description-missing"],
  paths: ["procedure.name", "procedure.priceFrom", "slug"], dynamic: true, queries: ["acl reconstruction cost malaysia"],
  samples: [
    { url: "https://x.com/procedures/acl", h1: "ACL Reconstruction", text: "ACL Reconstruction in Malaysia from RM 18,000 with 40 specialists." },
    { url: "https://x.com/procedures/mri", h1: "MRI Scan", text: "MRI Scan in Malaysia from RM 900 with 120 specialists." },
  ],
};
const good: FixText = {
  facts: ["procedures are offered in Malaysia", "prices are listed in RM"],
  titleSubject: "procedure.name", titleQualifier: "Cost Malaysia",
  description: "{procedure.name} in Malaysia: compare estimated costs and specialists, then send a free WhatsApp enquiry for a written hospital quote.",
  schema: [],
  examples: [
    { url: "https://x.com/procedures/acl", values: [{ path: "procedure.name", value: "ACL Reconstruction" }] },
    { url: "https://x.com/procedures/mri", values: [{ path: "procedure.name", value: "MRI Scan" }] },
  ],
};

describe("checkFixText", () => {
  it("accepts grounded text within the budgets", () => {
    assert.deepEqual(checkFixText(input, good), []);
  });

  it("rejects unknown variables, ungrounded values, invented numbers and claims", () => {
    const errors = checkFixText(input, {
      ...good,
      description: "{procedure.rating} The best clinic in Malaysia since 1999, trusted by patients worldwide for every procedure.",
      examples: [{ url: "https://x.com/procedures/acl", values: [{ path: "procedure.name", value: "ACL Surgery" }, { path: "procedure.rating", value: "5" }] }],
    });
    assert.ok(errors.some((e) => e.includes("unknown variable procedure.rating")));
    assert.ok(errors.some((e) => e.includes("ACL Surgery")));
    assert.ok(errors.some((e) => e.includes("no example values for https://x.com/procedures/mri")));
    assert.ok(errors.some((e) => e.includes("1999")));
    assert.ok(errors.some((e) => e.includes('"best"')));
  });

  it("checks rendered lengths and the qualifier against search queries", () => {
    const errors = checkFixText(input, { ...good, titleQualifier: "Prices Packages Deals", description: "{procedure.name}." });
    assert.ok(errors.some((e) => e.startsWith("length: description")));
    assert.ok(errors.some((e) => e.startsWith("qualifier:")));
  });
});

function fakeLlm(answers: unknown[]): JsonLlm & { calls: number } {
  const llm = { model: "fake", calls: 0, async json<T>() { llm.calls++; return answers.shift() as T; } };
  return llm;
}

describe("writeFixText", () => {
  it("returns checked text after a passing independent check", async () => {
    const llm = fakeLlm([{ ...good, skip: false, reason: "" }, { supported: true, problems: [] }]);
    const result = await writeFixText(llm, input, { calls: 5 });
    assert.equal(result.ok, true);
    assert.equal(llm.calls, 2);
  });

  it("retries once, naming the failure, only for length or language", async () => {
    const short = { ...good, description: "{procedure.name} in Malaysia.", skip: false, reason: "" };
    const llm = fakeLlm([short, { ...good, skip: false, reason: "" }, { supported: true, problems: [] }]);
    assert.equal((await writeFixText(llm, input, { calls: 5 })).ok, true);
    assert.equal(llm.calls, 3);
  });

  it("skips when the AI skips, the checker objects, or the budget is spent", async () => {
    assert.equal((await writeFixText(fakeLlm([{ ...good, skip: true, reason: "too little text" }]), input, { calls: 5 })).ok, false);
    assert.equal((await writeFixText(fakeLlm([{ ...good, skip: false, reason: "" }, { supported: false, problems: ["claims a price"] }]), input, { calls: 5 })).ok, false);
    assert.equal((await writeFixText(fakeLlm([]), input, { calls: 0 })).ok, false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `npm run build:packages && npm test -w @organic-growth/agents`. Expected: FAIL.

- [ ] **Step 3: `src/fix-text.ts`:**

```ts
import { schema, type JsonLlm } from "@organic-growth/ai";
import { placeholders } from "@organic-growth/fixes";

/*
 * The words of a fix: the subject and qualifier of a title, a description pattern, and which page
 * values fill which schema.org fields. Code makes the edit; the AI only writes these, under the
 * guardrails that worked in MedBay's content scripts: facts first, a closed set of variables,
 * every value grounded in a sample page, banned claims, one targeted retry, an independent check,
 * and a skip escape.
 */

export const FIX_PROMPT_VERSION = "fix-text-1";

export type FixSample = { url: string; title?: string; h1?: string; description?: string; text: string };
export type FixTextInput = { kind: "head" | "jsonld"; siteName: string; language: string; problems: string[]; paths: string[]; dynamic: boolean; schemaType?: string; samples: FixSample[]; queries: string[] };
export type FixText = {
  facts: string[];
  titleSubject: string | null;
  titleQualifier: string | null;
  description: string | null;
  schema: Array<{ field: string; path: string }>;
  examples: Array<{ url: string; values: Array<{ path: string; value: string }> }>;
};
export type FixTextResult = { ok: true; text: FixText; warnings: string[] } | { ok: false; reason: string };

const BANNED = ["leading", "renowned", "best", "world-class", "award-winning", "top", "premier", "trusted", "famous", "number one"];
const FUNCTION_WORDS: Record<string, string[]> = {
  id: ["yang", "dan", "di", "untuk", "dengan", "dari", "ini", "atau", "ke", "pada"],
  ms: ["yang", "dan", "di", "untuk", "dengan", "dari", "ini", "atau", "ke", "pada"],
  en: ["the", "and", "for", "with", "of", "in", "to", "a", "your", "at"],
};
const norm = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

export function render(pattern: string, values: Map<string, string>): string {
  return pattern.replace(/\{([\w$.]+)\}/g, (_, path: string) => values.get(path) ?? `{${path}}`);
}

export function titleOf(text: FixText, values: Map<string, string>, siteName: string, dynamic: boolean): string | null {
  if (!text.titleSubject) return null;
  const subject = dynamic ? values.get(text.titleSubject) ?? "" : text.titleSubject;
  return `${subject}${text.titleQualifier ? ` ${text.titleQualifier}` : ""} | ${siteName}`;
}

/** Every reason the text can't be used. Codes before the colon: `length` and `language` may be retried; the rest can't. */
export function checkFixText(input: FixTextInput, text: FixText): string[] {
  const errors: string[] = [];
  const allowed = new Set(input.paths);
  const used = new Set<string>([
    ...(text.description ? placeholders(text.description) : []),
    ...(input.dynamic && text.titleSubject ? [text.titleSubject] : []),
    ...text.schema.map((s) => s.path),
  ]);
  for (const path of used) if (!allowed.has(path)) errors.push(`fact: unknown variable ${path}`);
  if (!input.dynamic && text.description && placeholders(text.description).length) errors.push("fact: a static page can't use variables");
  for (const s of text.schema) if (!/^[a-zA-Z]+$/.test(s.field)) errors.push(`fact: bad schema field ${s.field}`);
  if (input.kind === "head" && input.problems.some((p) => p.startsWith("title")) && !text.titleSubject) errors.push("fact: no title");
  if (input.kind === "head" && input.problems.some((p) => p.startsWith("description")) && !text.description) errors.push("fact: no description");
  if (input.kind === "jsonld" && !text.schema.some((s) => s.field === "name")) errors.push("fact: structured data needs a name");

  const corpus = norm(input.samples.map((s) => [s.title, s.h1, s.description, s.text].join(" ")).join(" "));
  for (const sample of input.samples) {
    const example = text.examples.find((e) => e.url === sample.url);
    if (!example) { errors.push(`fact: no example values for ${sample.url}`); continue; }
    const pageText = norm([sample.title, sample.h1, sample.description, sample.text].join(" "));
    const values = new Map(example.values.map((v) => [v.path, v.value]));
    for (const path of used) {
      const value = values.get(path);
      if (!value) errors.push(`fact: no example value for ${path} on ${sample.url}`);
      else if (!pageText.includes(norm(value))) errors.push(`fact: "${value}" for ${path} isn't on ${sample.url}`);
    }
    const title = titleOf(text, values, input.siteName, input.dynamic);
    if (title && title.length > 65) errors.push(`length: the title is ${title.length} characters on ${sample.url} (65 at most)`);
    if (text.description) {
      const description = render(text.description, values);
      if (description.length < 70 || description.length > 160) errors.push(`length: the description is ${description.length} characters on ${sample.url} (70 to 160)`);
      const words = norm(description).split(/[^\p{L}]+/u);
      const lang = input.language.slice(0, 2);
      const expected = FUNCTION_WORDS[lang];
      if (expected && !words.some((w) => expected.includes(w))) errors.push(`language: the description isn't in "${lang}"`);
    }
  }
  const prose = norm([text.titleQualifier ?? "", text.description ?? "", input.dynamic ? "" : text.titleSubject ?? ""].join(" "));
  for (const word of BANNED) if (new RegExp(`(^|[^\\p{L}])${word}([^\\p{L}]|$)`, "u").test(prose) && !corpus.includes(word)) errors.push(`claim: "${word}" isn't used on the site`);
  for (const number of (text.description ?? "").replace(/\{[\w$.]+\}/g, " ").match(/\d[\d,.]*/g) ?? []) if (!corpus.includes(number.replace(/[.,]$/, ""))) errors.push(`fact: the number ${number} isn't on the site`);
  if (text.titleQualifier) {
    if (!input.queries.length) errors.push("qualifier: without Search Console queries there's nothing to base a qualifier on");
    else {
      const queries = norm(input.queries.join(" "));
      for (const word of norm(text.titleQualifier).split(" ").filter((w) => w.length > 2)) if (!queries.includes(word)) errors.push(`qualifier: "${word}" isn't in the site's search queries`);
    }
  }
  return errors;
}

const SYSTEM = [
  "You write search-result text for one route of a website. Code puts it into the page; you supply only words.",
  "RULES",
  "1. Facts first: list in `facts` the facts you will use, each taken from the sample pages. Use nothing else.",
  "2. Invent nothing. Every name, number, place and claim must appear in the samples.",
  "3. Dynamic routes: write patterns with {placeholders}; each placeholder must be one of `paths`, exactly. Static routes: plain text, no placeholders.",
  "4. titleSubject: for a dynamic route, the path whose value names the page (e.g. procedure.name); for a static route, the words that name it. Code adds \" | <site name>\".",
  "5. titleQualifier: 1 to 4 words that the site's search queries add (e.g. \"Cost in Malaysia\"), or null. Null when there are no queries.",
  "6. description: 120 to 155 characters once rendered, in the site's language; what the page offers and why to click. Never leading, best, renowned, top, trusted, world-class, award-winning, premier, famous unless the samples say so.",
  "7. schema (structured data only): map schema.org fields of the given type to paths, e.g. {field: \"name\", path: \"procedure.name\"}. Always include name. Otherwise return [].",
  "8. examples: for EVERY sample url, the value of each path you used on that page, copied exactly from the page.",
  "9. If the samples don't support good text, return skip: true and say why. Skipping beats guessing.",
].join("\n");

const CHECK_SYSTEM = "You check search-result text against the pages it describes. supported = false if any title or description states something the page facts don't support (a number, a name, a claim), or makes an advertising claim the page doesn't make. List each problem briefly.";

const FIX_SCHEMA = schema.object({
  skip: schema.boolean("true when the samples don't support good text"),
  reason: schema.string(),
  facts: schema.array(schema.string()),
  titleSubject: schema.nullable(schema.string()),
  titleQualifier: schema.nullable(schema.string()),
  description: schema.nullable(schema.string()),
  schema: schema.array(schema.object({ field: schema.string(), path: schema.string() })),
  examples: schema.array(schema.object({ url: schema.string(), values: schema.array(schema.object({ path: schema.string(), value: schema.string() })) })),
});
const CHECK_SCHEMA = schema.object({ supported: schema.boolean(), problems: schema.array(schema.string()) });

type Answer = FixText & { skip: boolean; reason: string };

export async function writeFixText(llm: JsonLlm, input: FixTextInput, budget: { calls: number }): Promise<FixTextResult> {
  const task = input.kind === "head" ? "title and description" : `structured data of type ${input.schemaType}`;
  const ask = async (extra: string): Promise<Answer | null> => {
    if (budget.calls <= 0) return null;
    budget.calls -= 1;
    return llm.json<Answer>({ system: SYSTEM, user: JSON.stringify({ task, ...input }) + extra, schema: FIX_SCHEMA, maxTokens: 1500, effort: "low" });
  };
  let answer = await ask("");
  if (!answer) return { ok: false, reason: "The AI budget for this analysis is used up; the fix is offered as a snippet instead." };
  if (answer.skip) return { ok: false, reason: answer.reason || "The pages had too little to write from." };
  let errors = checkFixText(input, answer);
  if (errors.length && errors.every((e) => e.startsWith("length:") || e.startsWith("language:"))) {
    const retry = await ask(`\n\nYour last answer was rejected: ${errors.join("; ")}. Fix only that and answer again.`);
    if (retry && !retry.skip) { answer = retry; errors = checkFixText(input, answer); }
  }
  if (errors.length) return { ok: false, reason: `The written text didn't pass the checks: ${errors.slice(0, 3).join("; ")}.` };
  if (input.kind === "jsonld") return { ok: true, text: answer, warnings: [] };
  if (budget.calls <= 0) return { ok: true, text: answer, warnings: ["Not independently checked: the AI budget ran out."] };
  budget.calls -= 1;
  const final = answer;
  const outputs = input.samples.map((sample) => {
    const values = new Map((final.examples.find((e) => e.url === sample.url)?.values ?? []).map((v) => [v.path, v.value]));
    return { url: sample.url, title: titleOf(final, values, input.siteName, input.dynamic), description: final.description ? render(final.description, values) : null };
  });
  const check = await llm.json<{ supported: boolean; problems: string[] }>({
    system: CHECK_SYSTEM,
    user: JSON.stringify({ facts: input.samples.map((s) => ({ url: s.url, title: s.title, h1: s.h1, text: s.text })), outputs }),
    schema: CHECK_SCHEMA, maxTokens: 600, effort: "low",
  });
  if (!check.supported) return { ok: false, reason: `The independent check found unsupported claims: ${check.problems.slice(0, 2).join("; ")}.` };
  return { ok: true, text: final, warnings: [] };
}
```

- [ ] **Step 4: Run the tests and confirm they pass.** Run `npm run build:packages && npm test -w @organic-growth/agents`. Expected: PASS. The good description in the test is 120–160 characters when rendered; if not, extend the test's description text. The rule doesn't change.
- [ ] **Step 5: Commit.** `git add packages/agents && git commit -m "Fix engine: AI words with MedBay-style guardrails"`

### Task 9: Migration and storage for fixes

**Files:**
- Create: `packages/db/migrations/0025_fix_engine.sql`, `packages/db/src/fixes.ts`
- Test: `packages/db/src/fixes.test.ts`
- Modify: `packages/db/src/index.ts` (add `export * from "./fixes.js";`)
- Modify: `packages/core/src/types.ts` (`ChangeStatus` union: append `| "staged" | "skipped" | "draft" | "ready" | "closed" | "reverted"`)

**Interfaces:**
- Produces in `@organic-growth/db`:
  - `type FixStatus = "staged" | "skipped" | "draft" | "ready" | "merged" | "failed" | "rejected" | "closed" | "reverted"`
  - `type FixRecord = { id: string; siteId: string; analysisId: string; kind: string; route: string; filePath: string; fileSha?: string; title: string; reason: string; files: Record<string, string>; original: Record<string, string>; urls: string[]; problems: string[]; snippet?: string; beforeSnippet?: string; afterSnippet?: string; promptSha?: string; warnings: string[]; score: number; status: FixStatus; prUrl?: string; prNumber?: number; branch?: string; headSha?: string; prNodeId?: string; previewUrl?: string; verification?: Record<string, unknown>; result?: string; createdAt: string; updatedAt: string }`
  - `stageFix(db, fix: FixRecord): Promise<void>`
  - `getFix(db, id): Promise<FixRecord | null>`
  - `listFixes(db, siteId, statuses?: FixStatus[]): Promise<FixRecord[]>`
  - `listOpenFixes(db, limit: number): Promise<FixRecord[]>`, for status `draft` across all sites, oldest first
  - `findFixByPr(db, siteId, prNumber): Promise<FixRecord | null>`
  - `findFixByHeadSha(db, headSha): Promise<FixRecord | null>`
  - `updateFix(db, id, patch: Partial<Pick<FixRecord, "status" | "prUrl" | "prNumber" | "branch" | "headSha" | "prNodeId" | "previewUrl" | "verification" | "result">>): Promise<void>`
  - `hasLiveFix(db, siteId, route, kind): Promise<boolean>`, for status in `staged`, `draft`, `ready` or `rejected`
  - `countOpenFixes(db, siteId): Promise<number>`, for status in `draft` or `ready`
  - `type FixSettings = { allowAiSearch: boolean; budget: number; autopilot: boolean }`
  - `getFixSettings(db, siteId): Promise<FixSettings>`, with defaults `{ allowAiSearch: false, budget: 3, autopilot: true }`
  - `setFixSettings(db, siteId, settings: FixSettings): Promise<void>`
  - `type PageHeadRow = { url: string; status: number; title?: string; description?: string; canonical?: string; hreflang: Array<{ lang: string; href: string }>; jsonLdTypes: string[]; heading?: string }`
  - `listPageHeads(db, analysisId): Promise<PageHeadRow[]>`
  - `findSiteByRepo(db, owner, repo): Promise<SiteRecord | null>`

- [ ] **Step 1: Migration.** Re-check the number first (Global Constraints). Create `packages/db/migrations/0025_fix_engine.sql`:

```sql
-- Fix engine: each fix is a row in `changes`, from staged through its pull request to merged
-- or reverted; per-site autopilot settings.
ALTER TABLE changes ADD COLUMN fix_kind TEXT;
ALTER TABLE changes ADD COLUMN route TEXT;
ALTER TABLE changes ADD COLUMN file_path TEXT;
ALTER TABLE changes ADD COLUMN file_sha TEXT;
ALTER TABLE changes ADD COLUMN before_snippet TEXT;
ALTER TABLE changes ADD COLUMN after_snippet TEXT;
ALTER TABLE changes ADD COLUMN prompt_sha TEXT;
ALTER TABLE changes ADD COLUMN warnings_json TEXT;
ALTER TABLE changes ADD COLUMN score REAL;
ALTER TABLE changes ADD COLUMN branch TEXT;
ALTER TABLE changes ADD COLUMN head_sha TEXT;
ALTER TABLE changes ADD COLUMN pr_node_id TEXT;
ALTER TABLE changes ADD COLUMN preview_url TEXT;
ALTER TABLE changes ADD COLUMN verification_json TEXT;
ALTER TABLE changes ADD COLUMN updated_at TEXT;
CREATE INDEX idx_changes_site_status ON changes (site_id, status);
CREATE INDEX idx_changes_head_sha ON changes (head_sha);

CREATE TABLE site_fix_settings (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  allow_ai_search INTEGER NOT NULL DEFAULT 0,
  fix_budget INTEGER NOT NULL DEFAULT 3,
  autopilot INTEGER NOT NULL DEFAULT 1
);
```

- [ ] **Step 2: Write the failing test.** `src/fixes.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countOpenFixes, findFixByHeadSha, findFixByPr, getFixSettings, hasLiveFix, listFixes, listPageHeads, setFixSettings, stageFix, updateFix, type FixRecord } from "./fixes.js";
import { upsertSite } from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

const AT = "2026-10-10T00:00:00.000Z";
async function setup() {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT, githubOwner: "acme", githubRepo: "web" });
  await db.prepare("INSERT INTO analyses (id, site_id, status, created_at) VALUES ('a', 's', 'completed', ?)").bind(AT).run();
  return db;
}
const fix = (over: Partial<FixRecord> = {}): FixRecord => ({
  id: "f1", siteId: "s", analysisId: "a", kind: "head", route: "/procedures/:slug", filePath: "app/procedures/[slug]/page.tsx", fileSha: "sha1",
  title: "Fix titles on /procedures/:slug", reason: "40 pages", files: { "app/procedures/[slug]/page.tsx": "new" }, original: { "app/procedures/[slug]/page.tsx": "old" },
  urls: ["https://x.com/procedures/a"], problems: ["title-missing"], warnings: [], score: 120, status: "staged", createdAt: AT, updatedAt: AT, ...over,
});

describe("fix storage", () => {
  it("stages, lists, updates and finds fixes", async () => {
    const db = await setup();
    await stageFix(db, fix());
    assert.equal((await listFixes(db, "s"))[0]?.files["app/procedures/[slug]/page.tsx"], "new");
    assert.equal(await hasLiveFix(db, "s", "/procedures/:slug", "head"), true);
    await updateFix(db, "f1", { status: "draft", prNumber: 7, headSha: "abc", prUrl: "https://github.com/acme/web/pull/7" });
    assert.equal(await countOpenFixes(db, "s"), 1);
    assert.equal((await findFixByPr(db, "s", 7))?.id, "f1");
    assert.equal((await findFixByHeadSha(db, "abc"))?.status, "draft");
    await updateFix(db, "f1", { status: "merged" });
    assert.equal(await hasLiveFix(db, "s", "/procedures/:slug", "head"), false, "merged fixes don't block a new one");
  });

  it("keeps settings with defaults", async () => {
    const db = await setup();
    assert.deepEqual(await getFixSettings(db, "s"), { allowAiSearch: false, budget: 3, autopilot: true });
    await setFixSettings(db, "s", { allowAiSearch: true, budget: 5, autopilot: false });
    assert.deepEqual(await getFixSettings(db, "s"), { allowAiSearch: true, budget: 5, autopilot: false });
  });

  it("reads head tags from crawled pages", async () => {
    const db = await setup();
    await db.prepare("INSERT INTO pages (analysis_id, url, status, title, is_empty_shell, crawl_state, result_json) VALUES ('a', 'https://x.com/p', 200, 'P', 0, 'complete', ?)")
      .bind(JSON.stringify({ description: "D", canonical: "https://x.com/p", hreflang: [], jsonLdTypes: ["WebPage"], headingOutline: ["h1:Hello", "h2:x"] })).run();
    assert.deepEqual(await listPageHeads(db, "a"), [{ url: "https://x.com/p", status: 200, title: "P", description: "D", canonical: "https://x.com/p", hreflang: [], jsonLdTypes: ["WebPage"], heading: "Hello" }]);
  });
});
```

If the `analyses` or `pages` INSERT fails because the current schema has other NOT NULL columns, read them with `grep -n "CREATE TABLE.*analyses\|CREATE TABLE.*pages" -A14 packages/db/migrations/*.sql | tail -40` and add those columns to the INSERTs. Don't change the schema.

- [ ] **Step 3: Run it and confirm it fails.** Run `npm test -w @organic-growth/db`. Expected: FAIL.

- [ ] **Step 4: `src/fixes.ts`.** It follows `index.ts`'s style (`D1Like`, `nowIso`, explicit columns):

```ts
import type { SiteRecord } from "@organic-growth/core";
import { nowIso, type D1Like } from "./d1.js";
import { getSite } from "./index.js";

export type FixStatus = "staged" | "skipped" | "draft" | "ready" | "merged" | "failed" | "rejected" | "closed" | "reverted";
export type FixRecord = {
  id: string; siteId: string; analysisId: string; kind: string; route: string; filePath: string; fileSha?: string;
  title: string; reason: string; files: Record<string, string>; original: Record<string, string>; urls: string[]; problems: string[];
  snippet?: string; beforeSnippet?: string; afterSnippet?: string; promptSha?: string; warnings: string[]; score: number;
  status: FixStatus; prUrl?: string; prNumber?: number; branch?: string; headSha?: string; prNodeId?: string;
  previewUrl?: string; verification?: Record<string, unknown>; result?: string; createdAt: string; updatedAt: string;
};
export type FixSettings = { allowAiSearch: boolean; budget: number; autopilot: boolean };
export type PageHeadRow = { url: string; status: number; title?: string; description?: string; canonical?: string; hreflang: Array<{ lang: string; href: string }>; jsonLdTypes: string[]; heading?: string };

const opt = (value: unknown) => (value === null || value === undefined ? undefined : String(value));

function mapFix(row: Record<string, unknown>): FixRecord {
  const evidence = JSON.parse(String(row.evidence_json ?? "{}")) as { files?: Record<string, string>; original?: Record<string, string>; urls?: string[]; problems?: string[]; snippet?: string };
  return {
    id: String(row.id), siteId: String(row.site_id), analysisId: String(row.analysis_id), kind: String(row.fix_kind ?? ""), route: String(row.route ?? ""),
    filePath: String(row.file_path ?? ""), fileSha: opt(row.file_sha), title: String(row.title), reason: String(row.reason),
    files: evidence.files ?? {}, original: evidence.original ?? {}, urls: evidence.urls ?? [], problems: evidence.problems ?? [], snippet: evidence.snippet,
    beforeSnippet: opt(row.before_snippet), afterSnippet: opt(row.after_snippet), promptSha: opt(row.prompt_sha),
    warnings: JSON.parse(String(row.warnings_json ?? "[]")) as string[], score: Number(row.score ?? 0), status: String(row.status) as FixStatus,
    prUrl: opt(row.pr_url), prNumber: row.pr_number === null || row.pr_number === undefined ? undefined : Number(row.pr_number),
    branch: opt(row.branch), headSha: opt(row.head_sha), prNodeId: opt(row.pr_node_id), previewUrl: opt(row.preview_url),
    verification: row.verification_json ? JSON.parse(String(row.verification_json)) as Record<string, unknown> : undefined,
    result: opt(row.result), createdAt: String(row.created_at), updatedAt: String(row.updated_at ?? row.created_at),
  };
}

export async function stageFix(db: D1Like, fix: FixRecord): Promise<void> {
  await db.prepare(
    `INSERT INTO changes (id, site_id, analysis_id, title, reason, evidence_json, files_changed_json, pages_affected_json, patch, status, author, created_at,
       fix_kind, route, file_path, file_sha, before_snippet, after_snippet, prompt_sha, warnings_json, score, updated_at, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'eumon-fix-engine', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    fix.id, fix.siteId, fix.analysisId, fix.title, fix.reason,
    JSON.stringify({ files: fix.files, original: fix.original, urls: fix.urls, problems: fix.problems, snippet: fix.snippet }),
    JSON.stringify(Object.keys(fix.files)), JSON.stringify(fix.urls.slice(0, 50)), fix.afterSnippet ?? "", fix.status, fix.createdAt,
    fix.kind, fix.route, fix.filePath, fix.fileSha ?? null, fix.beforeSnippet ?? null, fix.afterSnippet ?? null, fix.promptSha ?? null,
    JSON.stringify(fix.warnings), fix.score, fix.updatedAt, fix.result ?? null,
  ).run();
}

export async function getFix(db: D1Like, id: string): Promise<FixRecord | null> {
  const row = await db.prepare("SELECT * FROM changes WHERE id = ? AND fix_kind IS NOT NULL").bind(id).first<Record<string, unknown>>();
  return row ? mapFix(row) : null;
}

export async function listFixes(db: D1Like, siteId: string, statuses?: FixStatus[]): Promise<FixRecord[]> {
  const filter = statuses?.length ? ` AND status IN (${statuses.map(() => "?").join(", ")})` : "";
  const { results } = await db.prepare(`SELECT * FROM changes WHERE site_id = ? AND fix_kind IS NOT NULL${filter} ORDER BY score DESC, created_at DESC LIMIT 200`)
    .bind(siteId, ...(statuses ?? [])).all<Record<string, unknown>>();
  return results.map(mapFix);
}

export async function listOpenFixes(db: D1Like, limit: number): Promise<FixRecord[]> {
  const { results } = await db.prepare("SELECT * FROM changes WHERE fix_kind IS NOT NULL AND status = 'draft' ORDER BY updated_at LIMIT ?").bind(limit).all<Record<string, unknown>>();
  return results.map(mapFix);
}

export async function findFixByPr(db: D1Like, siteId: string, prNumber: number): Promise<FixRecord | null> {
  const row = await db.prepare("SELECT * FROM changes WHERE site_id = ? AND pr_number = ? AND fix_kind IS NOT NULL").bind(siteId, prNumber).first<Record<string, unknown>>();
  return row ? mapFix(row) : null;
}

export async function findFixByHeadSha(db: D1Like, headSha: string): Promise<FixRecord | null> {
  const row = await db.prepare("SELECT * FROM changes WHERE head_sha = ? AND fix_kind IS NOT NULL").bind(headSha).first<Record<string, unknown>>();
  return row ? mapFix(row) : null;
}

export async function updateFix(db: D1Like, id: string, patch: Partial<Pick<FixRecord, "status" | "prUrl" | "prNumber" | "branch" | "headSha" | "prNodeId" | "previewUrl" | "verification" | "result">>): Promise<void> {
  const columns: Record<string, unknown> = {
    status: patch.status, pr_url: patch.prUrl, pr_number: patch.prNumber, branch: patch.branch, head_sha: patch.headSha, pr_node_id: patch.prNodeId,
    preview_url: patch.previewUrl, verification_json: patch.verification ? JSON.stringify(patch.verification) : undefined, result: patch.result,
  };
  const set = Object.entries(columns).filter(([, v]) => v !== undefined);
  await db.prepare(`UPDATE changes SET ${[...set.map(([k]) => `${k} = ?`), "updated_at = ?"].join(", ")} WHERE id = ?`)
    .bind(...set.map(([, v]) => v), nowIso(), id).run();
}

export async function hasLiveFix(db: D1Like, siteId: string, route: string, kind: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS yes FROM changes WHERE site_id = ? AND route = ? AND fix_kind = ? AND status IN ('staged', 'draft', 'ready', 'rejected') LIMIT 1")
    .bind(siteId, route, kind).first();
  return Boolean(row);
}

export async function countOpenFixes(db: D1Like, siteId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM changes WHERE site_id = ? AND fix_kind IS NOT NULL AND status IN ('draft', 'ready')").bind(siteId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function getFixSettings(db: D1Like, siteId: string): Promise<FixSettings> {
  const row = await db.prepare("SELECT allow_ai_search, fix_budget, autopilot FROM site_fix_settings WHERE site_id = ?").bind(siteId).first<{ allow_ai_search: number; fix_budget: number; autopilot: number }>();
  return row ? { allowAiSearch: Number(row.allow_ai_search) === 1, budget: Number(row.fix_budget), autopilot: Number(row.autopilot) === 1 } : { allowAiSearch: false, budget: 3, autopilot: true };
}

export async function setFixSettings(db: D1Like, siteId: string, settings: FixSettings): Promise<void> {
  await db.prepare(`INSERT INTO site_fix_settings (site_id, allow_ai_search, fix_budget, autopilot) VALUES (?, ?, ?, ?)
    ON CONFLICT (site_id) DO UPDATE SET allow_ai_search = excluded.allow_ai_search, fix_budget = excluded.fix_budget, autopilot = excluded.autopilot`)
    .bind(siteId, settings.allowAiSearch ? 1 : 0, Math.min(5, Math.max(1, Math.round(settings.budget))), settings.autopilot ? 1 : 0).run();
}

export async function listPageHeads(db: D1Like, analysisId: string): Promise<PageHeadRow[]> {
  const { results } = await db.prepare("SELECT url, status, title, result_json FROM pages WHERE analysis_id = ? AND crawl_state = 'complete'").bind(analysisId)
    .all<{ url: string; status: number; title: string | null; result_json: string | null }>();
  return results.map((row) => {
    const r = JSON.parse(row.result_json ?? "{}") as { description?: string; canonical?: string; hreflang?: Array<{ lang: string; href: string }>; jsonLdTypes?: string[]; headingOutline?: string[] };
    const h1 = r.headingOutline?.find((h) => h.startsWith("h1:"))?.slice(3);
    return {
      url: row.url, status: Number(row.status), ...(row.title ? { title: row.title } : {}), ...(r.description ? { description: r.description } : {}),
      ...(r.canonical ? { canonical: r.canonical } : {}), hreflang: r.hreflang ?? [], jsonLdTypes: r.jsonLdTypes ?? [], ...(h1 ? { heading: h1 } : {}),
    };
  });
}

export async function findSiteByRepo(db: D1Like, owner: string, repo: string): Promise<SiteRecord | null> {
  const row = await db.prepare("SELECT id FROM sites WHERE lower(github_owner) = lower(?) AND lower(github_repo) = lower(?) LIMIT 1").bind(owner, repo).first<{ id: string }>();
  return row ? getSite(db, row.id) : null;
}
```

Also edit `packages/core/src/types.ts` `ChangeStatus` as listed under Files.

- [ ] **Step 5: Run the tests and confirm they pass.** Run `npm run build:packages && npm test -w @organic-growth/db`. Expected: PASS, including all existing db tests.
- [ ] **Step 6: Commit.** `git add packages/db packages/core && git commit -m "Fix engine: migration 0025, fix storage, settings and page heads"`

### Task 10: GitHub helpers

**Files:**
- Modify: `packages/agents/src/github-pr.ts`
- Test: `packages/agents/src/github-pr.test.ts` (create)

**Interfaces:**
- Produces, alongside the existing exports:
  - `createGitHubPullRequest` returns `{ number: number; url: string; nodeId: string; headSha: string }`; the last two are new. Read the function: use the created PR's `node_id` and the new commit's `sha`.
  - `getFileWithSha(token: string, owner: string, repo: string, path: string, ref: string, fetchFn?: typeof fetch): Promise<{ content: string; sha: string } | null>`
  - `getPullRequest(token, owner, repo, number, fetchFn?): Promise<{ state: "open" | "closed"; merged: boolean; draft: boolean; headSha: string; nodeId: string; createdAt: string }>`
  - `checkStateOf(checkRuns: Array<{ status: string; conclusion: string | null }>, combinedStatus: { state: string; total_count: number }): "success" | "failure" | "pending"`
  - `combinedCheckState(token, owner, repo, sha, fetchFn?): Promise<"success" | "failure" | "pending">`
  - `latestPreviewUrl(token, owner, repo, sha, fetchFn?): Promise<string | null>`
  - `markReadyForReview(token, nodeId, fetchFn?): Promise<void>`
  - `commentOnPullRequest(token, owner, repo, number, body, fetchFn?): Promise<void>`
  - `closePullRequest(token, owner, repo, number, fetchFn?): Promise<void>`

- [ ] **Step 1: Write the failing test.** `src/github-pr.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkStateOf, getFileWithSha, latestPreviewUrl, markReadyForReview } from "./github-pr.js";

function fake(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    return key ? Response.json(routes[key]) : new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("github helpers", () => {
  it("reads a file with its blob SHA, decoding base64 as UTF-8", async () => {
    const content = Buffer.from("const a = \"é\";\n").toString("base64");
    const { fetchFn, calls } = fake({ "/contents/app/page.tsx?ref=main": { content, sha: "abc", encoding: "base64" } });
    assert.deepEqual(await getFileWithSha("t", "acme", "web", "app/page.tsx", "main", fetchFn), { content: "const a = \"é\";\n", sha: "abc" });
    assert.match(String((calls[0]!.init!.headers as Record<string, string>).Authorization), /Bearer t/);
    assert.equal(await getFileWithSha("t", "acme", "web", "missing.tsx", "main", fetchFn), null);
  });

  it("treats a repo with no checks as passing, and any failure as failing", () => {
    assert.equal(checkStateOf([], { state: "pending", total_count: 0 }), "success");
    assert.equal(checkStateOf([{ status: "completed", conclusion: "success" }], { state: "success", total_count: 1 }), "success");
    assert.equal(checkStateOf([{ status: "in_progress", conclusion: null }], { state: "pending", total_count: 0 }), "pending");
    assert.equal(checkStateOf([{ status: "completed", conclusion: "failure" }], { state: "success", total_count: 1 }), "failure");
    assert.equal(checkStateOf([], { state: "failure", total_count: 1 }), "failure");
  });

  it("finds the newest successful preview URL for a commit", async () => {
    const { fetchFn } = fake({ "/deployments?sha=s1": [{ id: 9 }], "/deployments/9/statuses": [{ state: "success", environment_url: "https://pr-7.vercel.app" }] });
    assert.equal(await latestPreviewUrl("t", "acme", "web", "s1", fetchFn), "https://pr-7.vercel.app");
  });

  it("marks a draft ready through GraphQL", async () => {
    const { fetchFn, calls } = fake({ "/graphql": { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } } });
    await markReadyForReview("t", "PR_node", fetchFn);
    assert.match(String(calls[0]!.init!.body), /markPullRequestReadyForReview/);
    assert.match(String(calls[0]!.init!.body), /PR_node/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Expected: FAIL, because the helpers are missing.

- [ ] **Step 3: Implement**, appending to `github-pr.ts`. Reuse the file's existing header and fetch style if it has a helper; otherwise use this:

```ts
const GITHUB = "https://api.github.com";
const headers = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Eumon", "X-GitHub-Api-Version": "2022-11-28" });

async function github<T>(token: string, path: string, init: RequestInit = {}, fetchFn: typeof fetch = fetch): Promise<T | null> {
  const response = await fetchFn(`${GITHUB}${path}`, { ...init, headers: { ...headers(token), ...(init.body ? { "Content-Type": "application/json" } : {}) } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}.`);
  return response.status === 204 ? (null as T) : (await response.json()) as T;
}

export async function getFileWithSha(token: string, owner: string, repo: string, path: string, ref: string, fetchFn: typeof fetch = fetch): Promise<{ content: string; sha: string } | null> {
  const file = await github<{ content?: string; sha: string; encoding?: string }>(token, `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`, {}, fetchFn);
  if (!file?.content) return null;
  const bytes = Uint8Array.from(atob(file.content.replace(/\n/g, "")), (c) => c.charCodeAt(0));
  return { content: new TextDecoder().decode(bytes), sha: file.sha };
}

export async function getPullRequest(token: string, owner: string, repo: string, number: number, fetchFn: typeof fetch = fetch) {
  const pr = await github<{ state: "open" | "closed"; merged: boolean; draft: boolean; head: { sha: string }; node_id: string; created_at: string }>(token, `/repos/${owner}/${repo}/pulls/${number}`, {}, fetchFn);
  if (!pr) throw new Error(`Pull request #${number} wasn't found.`);
  return { state: pr.state, merged: pr.merged, draft: pr.draft, headSha: pr.head.sha, nodeId: pr.node_id, createdAt: pr.created_at };
}

export function checkStateOf(checkRuns: Array<{ status: string; conclusion: string | null }>, combinedStatus: { state: string; total_count: number }): "success" | "failure" | "pending" {
  if (checkRuns.some((r) => r.status === "completed" && ["failure", "timed_out", "cancelled", "action_required"].includes(r.conclusion ?? ""))) return "failure";
  if (combinedStatus.total_count > 0 && (combinedStatus.state === "failure" || combinedStatus.state === "error")) return "failure";
  if (checkRuns.some((r) => r.status !== "completed")) return "pending";
  if (combinedStatus.total_count > 0 && combinedStatus.state === "pending") return "pending";
  return "success";
}

export async function combinedCheckState(token: string, owner: string, repo: string, sha: string, fetchFn: typeof fetch = fetch): Promise<"success" | "failure" | "pending"> {
  const runs = await github<{ check_runs: Array<{ status: string; conclusion: string | null }> }>(token, `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`, {}, fetchFn);
  const status = await github<{ state: string; total_count: number }>(token, `/repos/${owner}/${repo}/commits/${sha}/status`, {}, fetchFn);
  return checkStateOf(runs?.check_runs ?? [], status ?? { state: "pending", total_count: 0 });
}

export async function latestPreviewUrl(token: string, owner: string, repo: string, sha: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const deployments = await github<Array<{ id: number }>>(token, `/repos/${owner}/${repo}/deployments?sha=${sha}&per_page=5`, {}, fetchFn);
  for (const deployment of deployments ?? []) {
    const statuses = await github<Array<{ state: string; environment_url?: string }>>(token, `/repos/${owner}/${repo}/deployments/${deployment.id}/statuses?per_page=5`, {}, fetchFn);
    const success = statuses?.find((s) => s.state === "success" && s.environment_url);
    if (success?.environment_url) return success.environment_url;
  }
  return null;
}

export async function markReadyForReview(token: string, nodeId: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const response = await fetchFn(`${GITHUB}/graphql`, {
    method: "POST", headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ query: "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }", variables: { id: nodeId } }),
  });
  const body = (await response.json()) as { errors?: Array<{ message: string }> };
  if (!response.ok || body.errors?.length) throw new Error(`GitHub couldn't mark the PR ready: ${body.errors?.[0]?.message ?? response.status}.`);
}

export async function commentOnPullRequest(token: string, owner: string, repo: string, number: number, body: string, fetchFn: typeof fetch = fetch): Promise<void> {
  await github(token, `/repos/${owner}/${repo}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) }, fetchFn);
}

export async function closePullRequest(token: string, owner: string, repo: string, number: number, fetchFn: typeof fetch = fetch): Promise<void> {
  await github(token, `/repos/${owner}/${repo}/pulls/${number}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) }, fetchFn);
}
```

Then update `createGitHubPullRequest` so that `PullRequestResult` also has `nodeId: string; headSha: string`, filled from the PR response's `node_id` and the commit SHA it created. Update the one existing caller's type usage if it breaks. That caller is removed in Task 15 anyway.

- [ ] **Step 4: Run the tests and confirm they pass.** Run `npm test -w @organic-growth/agents`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add packages/agents && git commit -m "Fix engine: GitHub file, PR, check and preview helpers"`

### Task 11: Orchestration (stage, open, merged check)

**Files:**
- Create: `apps/web/src/fix-run.ts`
- Test: `apps/web/src/fix-run.test.ts`

**Interfaces:**
- Consumes: everything from `@organic-growth/fixes`; `writeFixText`, `FIX_PROMPT_VERSION` (Task 8); the db functions (Task 9); `parseHtmlSignals`, `visibleText` from `@organic-growth/crawler`; `createId` from `@organic-growth/core`.
- Produces:
  - `type FixRepo = { owner: string; name: string; branch: string; treePaths: string[]; getFile(path: string): Promise<{ content: string; sha: string } | null> }`
  - `type FixDeps = { db: D1Like; repo: FixRepo; fetchPage(url: string): Promise<{ status: number; body: string } | null>; llm: JsonLlm | null; budget: { calls: number }; now(): Date }`
  - `type StageInput = { siteId: string; analysisId: string; origin: string; siteName: string; language: string; queries: string[]; candidates: FixCandidate[]; pages: PageHead[]; sensitivePaths: string[] }`
  - `stageCandidates(deps: FixDeps, input: StageInput): Promise<{ staged: number; skipped: number }>`
  - `type PrOps = { createPr(input: { branch: string; title: string; body: string; files: Record<string, string> }): Promise<{ number: number; url: string; nodeId: string; headSha: string }> }`
  - `openStagedFixes(deps: FixDeps, pr: PrOps, input: { siteId: string; origin: string; budget: number; onlyId?: string; max?: number }): Promise<number>`, which opens at most `max` (default 3) per call
  - `fixPrBody(fix: FixRecord, origin: string): string`
  - `checkMergedFixes(deps: FixDeps, pr: PrOps, input: { siteId: string; pages: PageHead[] }): Promise<number>`, which returns the number of revert PRs opened

**Behaviour, summarising spec §5:**
- `stageCandidates` goes through `candidates` in order. It skips any where `hasLiveFix(siteId, route ?? file, kind)`. Each candidate becomes one `stageFix` row: `staged` with `files` and `original`, or `skipped` with `snippet` and `result` set to the reason.
- `route` is `candidate.route?.pathPattern ?? candidate.file`.
- Per kind:
  - **head:**
    1. `getFile(file)`; a missing file is a skip, "the file isn't on the default branch".
    2. Parse; `findMetadata`; `names`; `paths = memberPaths(program, names)`.
    3. `canonical = problems.includes("canonical-missing") ? urlTemplate(route.pathPattern, names, source) : undefined`.
    4. `languages` when `hreflang-missing` and the canonical template exists: `{ "x-default": tpl, [language]: tpl, ...Object.fromEntries(locales.map((l) => [l, `/${l}${tpl}`])) }`.
    5. Title and description only when the problems include `title-*` or `description-*`, and `deps.llm` is present: fetch up to 3 of `candidate.urls` with `fetchPage`, keeping only 200s; build `FixSample`s from `parseHtmlSignals(body)` (title, description, the first `h1:` in `headingOutline`) and `visibleText(body).slice(0, 600)`; call `writeFixText` with `kind: "head"`, `paths`, `dynamic: route.dynamic`, `queries`. On ok, `title = dynamic ? `{${text.titleSubject}}${q} | ${siteName}` : `${text.titleSubject}${q} | ${siteName}``, where `q = text.titleQualifier ? " " + text.titleQualifier : ""`, and `description = text.description`.
    6. If nothing remains to change, skip with the AI's reason.
    7. `editMetadata(source, plan, route.dynamic)`, then `validateEdit` with `filePath: file`, `before: source`, `edits`, `allowedRanges`, `roots: paths.map((p) => p.split(".")[0])` deduplicated, and `sensitivePaths`.
    8. Stage with `files = { [file]: after }` merged with `result.files`, `original = { [file]: source }`, `fileSha`, `beforeSnippet` (the original text of the allowed range, or "(none)"), `afterSnippet` (the same range in `after`), `promptSha: FIX_PROMPT_VERSION`, `warnings` from the AI, and `score`.
  - **metadata-base:** `getFile`, `editMetadataBase(source, origin)`, validate, stage.
  - **jsonld:**
    1. `getFile`; `findPage`; `paths = memberPaths(program, page.names)`.
    2. `url = urlTemplate(...)`; null is a skip.
    3. Fetch samples as for head; `writeFixText` with `kind: "jsonld"`, `schemaType`.
    4. On ok, `editJsonLd(file, source, { schemaType, fields: text.schema, url, origin }, repo.treePaths)`.
    5. Validate the main file with `validateEdit`, and each extra file with `validateFile`; stage.
  - **llms-txt:**
    1. `existing = await getFile("public/llms.txt")`.
    2. `buildLlmsTxt` with `summary` from the home page's description in `input.pages` (else `` `${siteName}: ${origin}` ``) and `pages` = the 200-status pages whose title exists. Each page's `section` is the first static segment of its matched route, title-cased, or "Pages".
    3. `editLlmsTxt(existing?.content ?? null, content)`; `validateFile`; stage. `fileSha` is the existing SHA, or "new" for a new file.
  - **ai-robots:** `getFile(file)`, `editAiRobots(content, blockedAiSearchAgents(content))`, `validateFile`, stage.
- `openStagedFixes`:
  1. `slots = budget - countOpenFixes`.
  2. Take staged fixes by score (`onlyId` restricts to one).
  3. For each, while slots remain and fewer than `max` (default 3) have opened in this call: `fresh = getFile(fix.filePath)`.
     - If `!fresh` and `fileSha !== "new"`, or `fresh` and `fresh.sha !== fix.fileSha`: `updateFix(status "closed", result "The file changed after the analysis; Eumon will check it again on the next run.")`.
     - Otherwise: `branch = `eumon/${kind}-${slug(route)}`` (slug: lowercase, non-alphanumerics to `-`, trimmed, capped at 40 characters); `createPr({ branch, title: fix.title, body: fixPrBody(fix, origin), files: fix.files })`; then `updateFix(status "draft", prNumber, prUrl, branch, headSha, prNodeId)`.
  4. Return the number opened.
- `fixPrBody`: markdown containing:
  - the fix summary (`fix.reason`) and the affected page count, with 5 example URLs;
  - the before and after snippets in fenced blocks;
  - "Eumon will mark this ready after your checks pass and the change shows up on the preview deploy."
  - a revert line: "To undo after merging, revert this PR's single commit."
  - footer: "Opened by Eumon's fix engine."
- `checkMergedFixes`: for each `merged` fix without a `verification`:
  - Look at `input.pages` for its `urls`.
  - **Broken** means any of them now has status ≥ 400, or (kind `head`, with a title problem) more than half of them lack a title.
  - **Broken:** `createPr({ branch: `eumon/revert-${fix.id.slice(-8)}`, title: `Revert: ${fix.title}`, body: "Eumon's recrawl after this fix found <what>. This restores the previous version.", files: fix.original })`, then `updateFix(status "reverted", result)`.
  - **Not broken:** `updateFix({ verification: { recrawl: "ok", checkedAt } })`.

- [ ] **Step 1: Write the failing test.** `apps/web/src/fix-run.test.ts` uses `openSqliteD1`, a fake repo, a fake `fetchPage` and a fake llm (as in Task 8):

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getFix, listFixes, updateFix, upsertSite, type D1Like } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import type { FixCandidate } from "@organic-growth/fixes";
import { checkMergedFixes, openStagedFixes, stageCandidates, type FixDeps } from "./fix-run.ts";

const AT = "2026-10-10T00:00:00.000Z";
const pageFile = `export async function generateMetadata({ params }) {\n  const { slug } = await params;\n  const procedure = await get(slug);\n  return {\n    title: procedure.name,\n  };\n}\nexport default async function Page() { return <main><h1>x</h1></main>; }\n`;
const html = (name: string) => `<html><head><title>${name}</title></head><body><h1>${name}</h1><p>${name} in Malaysia from RM 900 with 120 specialists.</p></body></html>`;

async function setup() {
  const db: D1Like = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT });
  await db.prepare("INSERT INTO analyses (id, site_id, status, created_at) VALUES ('a', 's', 'completed', ?)").bind(AT).run();
  const files: Record<string, { content: string; sha: string }> = { "app/procedures/[slug]/page.tsx": { content: pageFile, sha: "sha1" } };
  const deps: FixDeps = {
    db, now: () => new Date(AT), budget: { calls: 10 },
    repo: { owner: "acme", name: "web", branch: "main", treePaths: Object.keys(files), getFile: async (p) => files[p] ?? null },
    fetchPage: async (url) => ({ status: 200, body: html(url.endsWith("mri") ? "MRI Scan" : "ACL Reconstruction") }),
    llm: null,
  };
  return { db, deps, files };
}
const head: FixCandidate = {
  kind: "head", file: "app/procedures/[slug]/page.tsx",
  route: { pathPattern: "/procedures/:slug", source: "app/procedures/[slug]/page.tsx", dynamic: true, rendering: "ssr", metadata: "server" },
  problems: ["canonical-missing"], urls: ["https://x.com/procedures/acl"], pageCount: 2, score: 6,
};
const input = { siteId: "s", analysisId: "a", origin: "https://x.com", siteName: "MedBay", language: "en", queries: [], pages: [], sensitivePaths: [] };
const prs = () => {
  const opened: Array<{ branch: string; files: Record<string, string> }> = [];
  return { opened, ops: { createPr: async (pr: { branch: string; title: string; body: string; files: Record<string, string> }) => { opened.push(pr); return { number: opened.length, url: `https://github.com/acme/web/pull/${opened.length}`, nodeId: "N", headSha: `h${opened.length}` }; } } };
};

describe("fix run", () => {
  it("stages a validated canonical fix and opens it as a draft within budget", async () => {
    const { db, deps } = await setup();
    assert.deepEqual(await stageCandidates(deps, { ...input, candidates: [head] }), { staged: 1, skipped: 0 });
    const [fix] = await listFixes(db, "s");
    assert.match(fix!.files["app/procedures/[slug]/page.tsx"]!, /canonical: `\/procedures\/\$\{slug\}`/);
    const { opened, ops } = prs();
    assert.equal(await openStagedFixes(deps, ops, { siteId: "s", origin: "https://x.com", budget: 3 }), 1);
    assert.equal(opened[0]!.branch, "eumon/head-procedures-slug");
    assert.equal((await getFix(db, fix!.id))?.status, "draft");
  });

  it("never re-stages a route and kind that's open or rejected", async () => {
    const { deps } = await setup();
    await stageCandidates(deps, { ...input, candidates: [head] });
    assert.deepEqual(await stageCandidates(deps, { ...input, candidates: [head] }), { staged: 0, skipped: 0 });
  });

  it("closes a staged fix whose file changed before the PR (Review Focus 1)", async () => {
    const { db, deps, files } = await setup();
    await stageCandidates(deps, { ...input, candidates: [head] });
    files["app/procedures/[slug]/page.tsx"] = { content: pageFile + "\n// edited", sha: "sha2" };
    const { opened, ops } = prs();
    assert.equal(await openStagedFixes(deps, ops, { siteId: "s", origin: "https://x.com", budget: 3 }), 0);
    assert.equal(opened.length, 0);
    assert.equal((await listFixes(db, "s"))[0]?.status, "closed");
  });

  it("skips with a snippet when there's no AI for the words", async () => {
    const { db, deps } = await setup();
    await stageCandidates(deps, { ...input, candidates: [{ ...head, problems: ["title-missing"] }] });
    const [fix] = await listFixes(db, "s");
    assert.equal(fix?.status, "skipped");
  });

  it("opens a revert PR when the recrawl finds merged pages broken", async () => {
    const { db, deps } = await setup();
    await stageCandidates(deps, { ...input, candidates: [head] });
    const [fix] = await listFixes(db, "s");
    await updateFix(db, fix!.id, { status: "merged" });
    const { opened, ops } = prs();
    const pages = [{ url: "https://x.com/procedures/acl", status: 500, hreflang: [], jsonLdTypes: [] }];
    assert.equal(await checkMergedFixes(deps, ops, { siteId: "s", pages }), 1);
    assert.equal(opened[0]!.files["app/procedures/[slug]/page.tsx"], pageFile);
    assert.equal((await getFix(db, fix!.id))?.status, "reverted");
  });
});
```

Add these to the `analyses` INSERT if the schema needs them (see Task 9 Step 2).

- [ ] **Step 2: Run it and confirm it fails.** Run `npm run build:packages && cd apps/web && node --test src/fix-run.test.ts`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement `apps/web/src/fix-run.ts`** with the behaviour above. Imports: `@organic-growth/fixes` for `parseModule`, `findMetadata`, `findPage`, `memberPaths`, `urlTemplate`, `routeForPath`, `pathOf`, `editMetadata`, `editMetadataBase`, `editJsonLd`, `buildLlmsTxt`, `editLlmsTxt`, `editAiRobots`, `blockedAiSearchAgents`, `validateEdit`, `validateFile`, and types; `@organic-growth/agents` for `writeFixText`, `FIX_PROMPT_VERSION`, `FixSample`; `@organic-growth/db` for `stageFix`, `listFixes`, `updateFix`, `hasLiveFix`, `countOpenFixes`, `FixRecord`; `@organic-growth/crawler` for `parseHtmlSignals`, `visibleText`; `@organic-growth/core` for `createId`.
  - Keep each kind in its own small function (`stageHead`, `stageMetadataBase`, `stageJsonLd`, `stageLlms`, `stageRobots`), each returning a `FixRecord`, and a shared `samplesFor(deps, urls)`.
  - Wrap each candidate in `try/catch`. An exception becomes a `skipped` row whose `result` is "Eumon couldn't prepare this fix: <message>". It never throws out of `stageCandidates`.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `cd apps/web && node --test src/fix-run.test.ts`. Expected: PASS. Then run `npm run typecheck`, which must exit 0.
- [ ] **Step 5: Commit.** `git add apps/web/src/fix-run.ts apps/web/src/fix-run.test.ts && git commit -m "Fix engine: stage, open within budget, and revert broken merges"`

### Task 12: Workflow wiring

**Files:**
- Create: `apps/web/src/fix-github.ts`, `apps/web/src/fix-steps.ts`
- Modify: `apps/web/src/analysis-workflow.ts`. After the `analyze-repository-and-site` step and before `return { analysisId, status: "completed" }`, add one call: `await runFixSteps(this.env, step, payload.siteId, payload.analysisId).catch(() => undefined);`. It must never fail the analysis (spec §9). If TypeScript rejects the workflow's `step` as a `FixStep` (because of `WorkflowStep`'s serialisable-output generics), pass `step as unknown as FixStep`, the same way `sync-steps.ts` adapts it to `StepLike`.
- Modify: `apps/web/cloudflare.config.ts`. Add `GITHUB_WEBHOOK_SECRET: bindings.secret(),` next to the other GitHub secrets, with the comment `// Verifies GitHub App webhooks (/api/github/webhook).` Copy the exact form the file uses for `GITHUB_APP_PRIVATE_KEY`.
- Modify: `apps/web/.dev.vars.example` (or whichever example env file exists: `ls apps/web/.dev.vars*`). Add `GITHUB_WEBHOOK_SECRET=` with a one-line comment.

**Interfaces:**
- Consumes: `createInstallationToken`, `createGitHubApiClient` (`@organic-growth/repo-analyzer`); `createGitHubPullRequest`, `getFileWithSha`, `getPullRequest`, `combinedCheckState`, `latestPreviewUrl`, `markReadyForReview`, `commentOnPullRequest`, `closePullRequest` (Task 10); `detect`, `blockedAiSearchAgents`, `LLMS_MARKER` (`@organic-growth/fixes`); `stageCandidates`, `openStagedFixes`, `checkMergedFixes` (Task 11); `getAnalysisJob`, `getSite`, `listPageHeads`, `listTopQueries`, `getFixSettings` (`@organic-growth/db`); `createLlm` (`@organic-growth/ai`); `defaultFetcher` (`@organic-growth/crawler`); `featureRefusal` (`./limits.ts`); `settingsFor` (`./server.ts`).
- Produces:
  - `fix-github.ts`:
    - `type GitHubOps = { getPullRequest(n: number): ReturnType<typeof getPullRequest>; checkState(sha: string): Promise<"success" | "failure" | "pending">; previewUrl(sha: string): Promise<string | null>; markReady(nodeId: string): Promise<void>; comment(n: number, body: string): Promise<void>; close(n: number): Promise<void> }`
    - `fixRepoFor(env: AppEnv, site: SiteRecord): Promise<{ repo: FixRepo; pr: PrOps; ops: GitHubOps }>`, which throws if the site has no installation, owner or repo
  - `fix-steps.ts`:
    - `FIX_AI_CALLS = 30`
    - `type FixStep = { do<T>(name: string, fn: () => Promise<T>): Promise<T> }`
    - `runFixSteps(env: AppEnv, step: FixStep, siteId: string, analysisId: string): Promise<void>`
    - `fetchHtml(url: string): Promise<{ status: number; body: string } | null>`, which wraps `defaultFetcher` and also returns non-200 statuses

- [ ] **Step 1: `fix-github.ts`.** Only wiring, no logic; it isn't unit-tested, and Tasks 11 and 13 test the logic it feeds. Write:

```ts
import type { SiteRecord } from "@organic-growth/core";
import { closePullRequest, combinedCheckState, commentOnPullRequest, createGitHubPullRequest, getFileWithSha, getPullRequest, latestPreviewUrl, markReadyForReview } from "@organic-growth/agents";
import { createGitHubApiClient, createInstallationToken } from "@organic-growth/repo-analyzer";
import type { FixRepo, PrOps } from "./fix-run.ts";
import type { AppEnv } from "./env.ts"; // use whatever module exports the Worker env type; check analysis-workflow.ts's imports

export type GitHubOps = {
  getPullRequest(n: number): ReturnType<typeof getPullRequest>;
  checkState(sha: string): Promise<"success" | "failure" | "pending">;
  previewUrl(sha: string): Promise<string | null>;
  markReady(nodeId: string): Promise<void>;
  comment(n: number, body: string): Promise<void>;
  close(n: number): Promise<void>;
};

export async function fixRepoFor(env: AppEnv, site: SiteRecord): Promise<{ repo: FixRepo; pr: PrOps; ops: GitHubOps }> {
  if (!site.githubInstallationId || !site.githubOwner || !site.githubRepo) throw new Error("The site has no connected repository.");
  const token = await createInstallationToken(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, site.githubInstallationId);
  const owner = site.githubOwner;
  const name = site.githubRepo;
  const branch = site.defaultBranch ?? "main";
  const treePaths = await createGitHubApiClient(token).getTreePaths(owner, name, branch);
  return {
    repo: { owner, name, branch, treePaths, getFile: (path) => getFileWithSha(token, owner, name, path, branch) },
    pr: { createPr: (input) => createGitHubPullRequest(token, { owner, repo: name, baseBranch: branch, ...input }) },
    ops: {
      getPullRequest: (n) => getPullRequest(token, owner, name, n),
      checkState: (sha) => combinedCheckState(token, owner, name, sha),
      previewUrl: (sha) => latestPreviewUrl(token, owner, name, sha),
      markReady: (nodeId) => markReadyForReview(token, nodeId),
      comment: (n, body) => commentOnPullRequest(token, owner, name, n, body),
      close: (n) => closePullRequest(token, owner, name, n),
    },
  };
}
```

If the helpers from Task 10 aren't exported from the `@organic-growth/agents` index, add `export * from "./github-pr.js";` there (check first: `grep -n github-pr packages/agents/src/index.ts`). Fix the `AppEnv` import to the real module before moving on.

- [ ] **Step 2: `fix-steps.ts`.** Every step's output stays small: candidates are at most 12, each with at most 20 URLs.

```ts
import { createLlm, type JsonLlm } from "@organic-growth/ai";
import type { SiteRecord } from "@organic-growth/core";
import { defaultFetcher } from "@organic-growth/crawler";
import { getAnalysisJob, getFixSettings, getSite, listPageHeads, listTopQueries, type D1Like } from "@organic-growth/db";
import { blockedAiSearchAgents, detect, LLMS_MARKER, type FixCandidate, type RouteRef } from "@organic-growth/fixes";
import { fixRepoFor } from "./fix-github.ts";
import { checkMergedFixes, openStagedFixes, stageCandidates, type FixDeps } from "./fix-run.ts";
import { featureRefusal } from "./limits.ts";
import { settingsFor } from "./server.ts";
import type { AppEnv } from "./env.ts"; // same import as fix-github.ts

export const FIX_AI_CALLS = 30;
const PER_STEP = 3;

export type FixStep = { do<T>(name: string, fn: () => Promise<T>): Promise<T> };

export async function fetchHtml(url: string): Promise<{ status: number; body: string } | null> {
  try {
    const response = await defaultFetcher(url, { headers: { "User-Agent": "EumonBot/1.0 (+fix verification)" } });
    return { status: response.status, body: response.status === 200 ? await response.text() : "" };
  } catch { return null; }
}

type Report = { repo?: { fingerprint?: { framework?: string; router?: string }; routeInspections?: RouteRef[]; sensitivePaths?: string[] } };

async function depsFor(env: AppEnv, site: SiteRecord, calls: number): Promise<FixDeps & { pr: Awaited<ReturnType<typeof fixRepoFor>>["pr"] }> {
  const { repo, pr } = await fixRepoFor(env, site);
  let llm: JsonLlm | null = null;
  try { llm = createLlm(env); } catch { llm = null; }
  return { db: env.DB as D1Like, repo, pr, llm, budget: { calls }, fetchPage: fetchHtml, now: () => new Date() };
}

export async function runFixSteps(env: AppEnv, step: FixStep, siteId: string, analysisId: string): Promise<void> {
  const db = env.DB as D1Like;
  const site = await getSite(db, siteId);
  if (!site?.githubInstallationId || !site.githubOwner || !site.githubRepo) return;
  const report = (await getAnalysisJob(db, analysisId))?.report as Report | undefined;
  const fingerprint = report?.repo?.fingerprint;
  if (fingerprint?.framework !== "Next.js" || fingerprint.router !== "App Router") return;
  const sensitivePaths = report?.repo?.sensitivePaths ?? [];

  const prepared = await step.do("fixes-prepare", async () => {
    const { repo } = await fixRepoFor(env, site);
    const settings = await settingsFor(site);
    const fixSettings = await getFixSettings(db, siteId);
    const layoutPath = ["app/layout.tsx", "src/app/layout.tsx", "app/layout.jsx", "src/app/layout.jsx"].find((p) => repo.treePaths.includes(p));
    const layout = layoutPath ? await repo.getFile(layoutPath) : null;
    const llms = repo.treePaths.includes("public/llms.txt") ? await repo.getFile("public/llms.txt") : null;
    const robots = repo.treePaths.includes("public/robots.txt") ? await repo.getFile("public/robots.txt") : null;
    const pages = await listPageHeads(db, analysisId);
    const candidates = detect({
      origin: settings.publicOrigin || site.baseUrl, siteName: settings.siteName || site.name, pages,
      routes: (report?.repo?.routeInspections ?? []).filter((r) => /(^|\/)app\/(.+\/)?page\.[jt]sx?$/.test(r.source)),
      rootLayout: layoutPath ? { path: layoutPath, hasMetadataBase: /metadataBase/.test(layout?.content ?? "") } : undefined,
      llmsTxt: { exists: Boolean(llms), managedByEumon: Boolean(llms?.content.includes(LLMS_MARKER)) },
      robots: robots ? { path: "public/robots.txt", blocksAiSearch: blockedAiSearchAgents(robots.content) } : { blocksAiSearch: [] },
      allowAiSearch: fixSettings.allowAiSearch,
    });
    const queries = (await listTopQueries(db, siteId, 50)).map((q) => q.query);
    return { candidates, queries, origin: settings.publicOrigin || site.baseUrl, siteName: settings.siteName || site.name, language: settings.language || "en" };
  });

  let calls = FIX_AI_CALLS;
  for (let i = 0; i < prepared.candidates.length; i += PER_STEP) {
    const batch: FixCandidate[] = prepared.candidates.slice(i, i + PER_STEP);
    calls = await step.do(`fixes-stage-${i / PER_STEP}`, async () => {
      const deps = await depsFor(env, site, calls);
      const pages = await listPageHeads(db, analysisId);
      await stageCandidates(deps, { siteId, analysisId, origin: prepared.origin, siteName: prepared.siteName, language: prepared.language, queries: prepared.queries, candidates: batch, pages, sensitivePaths });
      return deps.budget.calls;
    });
  }

  await step.do("fixes-check-merged", async () => {
    const deps = await depsFor(env, site, 0);
    return checkMergedFixes(deps, deps.pr, { siteId, pages: await listPageHeads(db, analysisId) });
  });

  const { autopilot, budget } = await getFixSettings(db, siteId);
  if (!autopilot || (await featureRefusal(db, site.workspaceId!, "pullRequests"))) return;
  await step.do("fixes-open", async () => {
    const deps = await depsFor(env, site, 0);
    return openStagedFixes(deps, deps.pr, { siteId, origin: prepared.origin, budget });
  });
}
```

Adjust the names to the real ones where they differ:
- `site.baseUrl`, `site.name` and `site.workspaceId`: check `SiteRecord` in `packages/core/src/types.ts`.
- `settings.publicOrigin`, `siteName` and `language`: these come from `PageSettings`.

Keep the logic as written.

- [ ] **Step 3: Wire up and typecheck.** Make the analysis-workflow edit listed under Files. Then run `npm run build:packages && cd apps/web && npm run typecheck`. Expected: exit 0. Also run `cd apps/web && npm test`. Expected: PASS, with all existing tests unchanged.
- [ ] **Step 4: Commit.**

```bash
git add apps/web/src/fix-github.ts apps/web/src/fix-steps.ts apps/web/src/analysis-workflow.ts apps/web/cloudflare.config.ts apps/web/.dev.vars*
git commit -m "Fix engine: stage, check and open fixes at the end of each analysis"
```

### Task 13: GitHub webhook

**Files:**
- Create: `apps/web/src/github-webhook.ts`, `apps/web/app/api/github/webhook/route.ts`
- Test: `apps/web/src/github-webhook.test.ts`
- Modify: `apps/web/src/gate.ts` (add `/^\/api\/github\/webhook$/, // GitHub App events (HMAC-signed)` to `PUBLIC`)
- Modify: `apps/web/src/routes-guarded.test.ts` (add `"github/webhook/route.ts"` to its `PUBLIC` set)

**Interfaces:**
- Consumes: `GitHubOps` (Task 12); `findSiteByRepo`, `findFixByPr`, `findFixByHeadSha`, `updateFix`, `FixRecord` (Task 9); `parseHtmlSignals`, `blockedAiSearchAgents`, `LLMS_MARKER`.
- Produces:
  - `verifySignature(secret: string, body: string, header: string | null): Promise<boolean>`
  - `type WebhookDeps = { db: D1Like; opsFor(site: SiteRecord): Promise<GitHubOps>; fetchHtml(url: string): Promise<{ status: number; body: string } | null>; now(): Date }`
  - `handleGitHubEvent(deps: WebhookDeps, event: string, payload: Record<string, unknown>): Promise<string>`, which returns a short outcome string for logs and tests: `"ignored"`, `"merged"`, `"rejected"`, `"ready"`, `"failed"`, `"waiting"`
  - `advanceFix(deps: WebhookDeps, ops: GitHubOps, fix: FixRecord): Promise<"ready" | "failed" | "waiting">`, also used by the sweep

**Behaviour:**
- `pull_request` with `action: "closed"`:
  - Find the site from `repository.owner.login` and `repository.name`, then the fix by `pull_request.number`.
  - If `merged`, the fix becomes `merged`.
  - Otherwise, if its status is `draft` or `ready`, it becomes `rejected` with result "Closed without merging on GitHub."
- `check_suite`, `check_run`, `status` and `deployment_status`: the head SHA is at `check_suite.head_sha`, `check_run.head_sha`, `sha` or `deployment_status.deployment.sha` respectively. Find the fix with `findFixByHeadSha`; only status `draft` advances.
- Anything else, an unknown repo, or no matching fix: `"ignored"`, with no change.
- `advanceFix`:
  1. `ops.checkState(headSha)`.
  2. **failure:** status `failed`, result "Your CI checks failed on this change, so Eumon left it as a draft.", and comment that on the PR.
  3. **pending:** `"waiting"`.
  4. **success:** `preview = ops.previewUrl(headSha)`.
     - **With a preview:** fetch up to 3 of the fix's URLs, rewritten onto the preview origin (`new URL(new URL(u).pathname, preview)`). For `llms-txt` fetch `/llms.txt`; for `ai-robots` fetch `/robots.txt`.
       - A 401 or 403 counts as **no preview** (Review Focus 2).
       - Otherwise the fix must show in the raw HTML:
         - `head`: every problem the fix targets is gone. `title-*` means a title exists and isn't just the site name; `description-*` means a description of 70–170 characters; `canonical-missing` means a canonical exists; `hreflang-missing` means at least one hreflang entry.
         - `jsonld`: `jsonLdCount > 0`.
         - `metadata-base`: every fetched page has a canonical.
         - `llms-txt`: the body contains `LLMS_MARKER`.
         - `ai-robots`: `blockedAiSearchAgents(body)` is empty.
       - **Missing:** `failed`, with result "The preview deploy doesn't show the change in its HTML (<which check>)." and the same comment on the PR.
       - **Present:** `ops.markReady(prNodeId)`, status `ready`, `verification: { preview, checked: urls, at }`, and the comment "Checks passed and the preview shows the change. Ready for your review."
     - **No preview:** if `now - updatedAt >= 30 minutes`, mark ready with `verification: { buildOnly: true }` and the comment "Checks passed. No preview deploy was found, so only the build was verified." Otherwise `"waiting"`.

- [ ] **Step 1: Write the failing test.** `src/github-webhook.test.ts`:

```ts
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { getFix, stageFix, updateFix, upsertSite, type FixRecord } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { handleGitHubEvent, verifySignature, type WebhookDeps } from "./github-webhook.ts";
import type { GitHubOps } from "./fix-github.ts";

const AT = "2026-10-10T00:00:00.000Z";
const repository = { name: "web", owner: { login: "acme" } };

async function setup(over: Partial<GitHubOps> = {}, pages: Record<string, { status: number; body: string }> = {}, minutes = 0) {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT, githubOwner: "acme", githubRepo: "web" });
  await db.prepare("INSERT INTO analyses (id, site_id, status, created_at) VALUES ('a', 's', 'completed', ?)").bind(AT).run();
  const fix: FixRecord = { id: "f1", siteId: "s", analysisId: "a", kind: "head", route: "/p/:slug", filePath: "app/p/[slug]/page.tsx", title: "T", reason: "R",
    files: {}, original: {}, urls: ["https://x.com/p/a"], problems: ["canonical-missing"], warnings: [], score: 1, status: "staged", createdAt: AT, updatedAt: AT };
  await stageFix(db, fix);
  await updateFix(db, "f1", { status: "draft", prNumber: 7, headSha: "h1", prNodeId: "N1" });
  const calls: string[] = [];
  const ops: GitHubOps = {
    getPullRequest: async () => ({ state: "open", merged: false, draft: true, headSha: "h1", nodeId: "N1", createdAt: AT }),
    checkState: async () => "success", previewUrl: async () => "https://pr-7.vercel.app",
    markReady: async (id) => { calls.push(`ready:${id}`); }, comment: async (_n, body) => { calls.push(`comment:${body.slice(0, 20)}`); }, close: async () => { calls.push("close"); },
    ...over,
  };
  const deps: WebhookDeps = { db, opsFor: async () => ops, fetchHtml: async (url) => pages[url] ?? null, now: () => new Date(Date.now() + minutes * 60_000) };
  return { db, deps, calls };
}

describe("webhook signature", () => {
  it("accepts GitHub's sha256 HMAC and rejects anything else", async () => {
    const body = '{"a":1}';
    const header = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
    assert.equal(await verifySignature("s3cret", body, header), true);
    assert.equal(await verifySignature("s3cret", body + " ", header), false);
    assert.equal(await verifySignature("s3cret", body, null), false);
    assert.equal(await verifySignature("", body, header), false);
  });
});

describe("webhook events", () => {
  it("records merges and rejections", async () => {
    const { db, deps } = await setup();
    assert.equal(await handleGitHubEvent(deps, "pull_request", { action: "closed", repository, pull_request: { number: 7, merged: true } }), "merged");
    assert.equal((await getFix(db, "f1"))?.status, "merged");
    const second = await setup();
    assert.equal(await handleGitHubEvent(second.deps, "pull_request", { action: "closed", repository, pull_request: { number: 7, merged: false } }), "rejected");
  });

  it("ignores repos and PRs Eumon doesn't know (Review Focus 3)", async () => {
    const { db, deps } = await setup();
    assert.equal(await handleGitHubEvent(deps, "pull_request", { action: "closed", repository: { name: "other", owner: { login: "acme" } }, pull_request: { number: 7, merged: true } }), "ignored");
    assert.equal(await handleGitHubEvent(deps, "check_suite", { repository, check_suite: { head_sha: "zzz" } }), "ignored");
    assert.equal((await getFix(db, "f1"))?.status, "draft");
  });

  it("marks ready when checks pass and the preview shows the change", async () => {
    const html = `<html><head><link rel="canonical" href="https://x.com/p/a"></head><body></body></html>`;
    const { db, deps, calls } = await setup({}, { "https://pr-7.vercel.app/p/a": { status: 200, body: html } });
    assert.equal(await handleGitHubEvent(deps, "check_suite", { repository, check_suite: { head_sha: "h1" } }), "ready");
    assert.equal((await getFix(db, "f1"))?.status, "ready");
    assert.ok(calls.includes("ready:N1"));
  });

  it("fails when the preview lacks the change, and when checks fail", async () => {
    const { db, deps } = await setup({}, { "https://pr-7.vercel.app/p/a": { status: 200, body: "<html><head></head></html>" } });
    assert.equal(await handleGitHubEvent(deps, "status", { repository, sha: "h1" }), "failed");
    assert.equal((await getFix(db, "f1"))?.status, "failed");
    const red = await setup({ checkState: async () => "failure" });
    assert.equal(await handleGitHubEvent(red.deps, "check_run", { repository, check_run: { head_sha: "h1" } }), "failed");
  });

  it("treats a password-protected preview as no preview, then readies on build after 30 minutes (Review Focus 2)", async () => {
    const locked = { "https://pr-7.vercel.app/p/a": { status: 401, body: "" } };
    const early = await setup({}, locked, 5);
    assert.equal(await handleGitHubEvent(early.deps, "deployment_status", { repository, deployment_status: { deployment: { sha: "h1" } } }), "waiting");
    const late = await setup({}, locked, 31);
    assert.equal(await handleGitHubEvent(late.deps, "deployment_status", { repository, deployment_status: { deployment: { sha: "h1" } } }), "ready");
    assert.deepEqual((await getFix(late.db, "f1"))?.verification, { buildOnly: true });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `cd apps/web && node --test src/github-webhook.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `src/github-webhook.ts`** with the behaviour above. Signature check, using Web Crypto (available in Workers and Node 22):

```ts
export async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const expected = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
```

Use `parseHtmlSignals` from `@organic-growth/crawler` for the HTML checks, and `blockedAiSearchAgents` and `LLMS_MARKER` from `@organic-growth/fixes`. Comments on the PR are best-effort: wrap each in `.catch(() => undefined)` so a comment failure never blocks a status change.

- [ ] **Step 4: The route.** `apps/web/app/api/github/webhook/route.ts`:

```ts
import { env } from "cloudflare:workers";
import type { D1Like } from "@organic-growth/db";
import { fixRepoFor } from "../../../../src/fix-github";
import { fetchHtml } from "../../../../src/fix-steps";
import { handleGitHubEvent, verifySignature } from "../../../../src/github-webhook";

// Public: GitHub App events, authenticated by the HMAC signature rather than a session.
export async function POST(request: Request) {
  if (!env.GITHUB_WEBHOOK_SECRET) return Response.json({ error: "Webhooks aren't configured." }, { status: 503 });
  const body = await request.text();
  if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get("x-hub-signature-256")))) {
    return Response.json({ error: "Invalid signature." }, { status: 401 });
  }
  const outcome = await handleGitHubEvent(
    { db: env.DB as D1Like, opsFor: async (site) => (await fixRepoFor(env, site)).ops, fetchHtml, now: () => new Date() },
    request.headers.get("x-github-event") ?? "", JSON.parse(body) as Record<string, unknown>,
  ).catch((error: unknown) => `error: ${error instanceof Error ? error.message : "unknown"}`);
  return Response.json({ outcome });
}
```

Make the gate and `routes-guarded.test.ts` edits listed under Files. Check the relative import depth against a sibling route, e.g. `app/api/sites/[siteId]/events/route.ts`. Note that `fixRepoFor` also lists the tree, which the webhook doesn't need; that one extra call is accepted.

- [ ] **Step 5: Run the tests and confirm they pass.** Run `cd apps/web && npm test && npm run typecheck`. Expected: PASS and exit 0, including `routes-guarded.test.ts` and the gate tests.
- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/github-webhook.ts apps/web/src/github-webhook.test.ts apps/web/app/api/github apps/web/src/gate.ts apps/web/src/routes-guarded.test.ts
git commit -m "Fix engine: signed GitHub webhook moves PRs from draft to ready, merged or failed"
```

### Task 14: Daily sweep

**Files:**
- Create: `apps/web/src/fix-sweep.ts`
- Test: `apps/web/src/fix-sweep.test.ts`
- Modify: `apps/web/worker.ts`. In `scheduled()`, add `ctx.waitUntil(sweepFixes({ db: env.DB, opsFor: async (site) => (await fixRepoFor(env, site)).ops, fetchHtml, now: () => new Date(controller.scheduledTime) }).catch(() => 0));` after the existing `startDailySyncs` line.

**Interfaces:**
- Consumes: `listOpenFixes`, `getSite`, `updateFix` (Task 9); `advanceFix`, `WebhookDeps` (Task 13).
- Produces: `sweepFixes(deps: WebhookDeps, limit = 8): Promise<number>`, which returns how many fixes changed status.

**Behaviour:**
- Takes at most `limit` draft fixes, oldest first. The webhook can miss events (an outage, a GitHub delivery failure), so the sweep is the catch-up.
- For each fix, call `ops.getPullRequest(prNumber)`:
  - merged → `merged`;
  - closed → `rejected`;
  - a draft older than 7 days (from `updatedAt`) → `ops.close`, comment "Eumon closed this draft after 7 days without checks passing.", status `closed`;
  - otherwise → `advanceFix`.
- Each fix is wrapped in try/catch; one bad repo never stops the sweep.

- [ ] **Step 1: Write the failing test.** `src/fix-sweep.test.ts` reuses the setup shape of Task 13's test:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getFix, stageFix, updateFix, upsertSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import type { GitHubOps } from "./fix-github.ts";
import { sweepFixes } from "./fix-sweep.ts";

const AT = "2026-10-10T00:00:00.000Z";
async function setup(pr: Partial<Awaited<ReturnType<GitHubOps["getPullRequest"]>>>, days = 0) {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT, githubOwner: "acme", githubRepo: "web" });
  await db.prepare("INSERT INTO analyses (id, site_id, status, created_at) VALUES ('a', 's', 'completed', ?)").bind(AT).run();
  await stageFix(db, { id: "f1", siteId: "s", analysisId: "a", kind: "llms-txt", route: "public/llms.txt", filePath: "public/llms.txt", title: "T", reason: "R",
    files: {}, original: {}, urls: [], problems: [], warnings: [], score: 1, status: "staged", createdAt: AT, updatedAt: AT });
  await updateFix(db, "f1", { status: "draft", prNumber: 7, headSha: "h1", prNodeId: "N1" });
  const closed: number[] = [];
  const ops: GitHubOps = {
    getPullRequest: async () => ({ state: "open", merged: false, draft: true, headSha: "h1", nodeId: "N1", createdAt: AT, ...pr }),
    checkState: async () => "pending", previewUrl: async () => null, markReady: async () => {}, comment: async () => {}, close: async (n) => { closed.push(n); },
  };
  return { db, closed, deps: { db, opsFor: async () => ops, fetchHtml: async () => null, now: () => new Date(Date.now() + days * 86_400_000) } };
}

describe("sweepFixes", () => {
  it("catches up on merges and closes missed by the webhook", async () => {
    const merged = await setup({ state: "closed", merged: true });
    assert.equal(await sweepFixes(merged.deps), 1);
    assert.equal((await getFix(merged.db, "f1"))?.status, "merged");
    const closed = await setup({ state: "closed", merged: false });
    await sweepFixes(closed.deps);
    assert.equal((await getFix(closed.db, "f1"))?.status, "rejected");
  });

  it("closes drafts older than 7 days and leaves fresh pending ones alone", async () => {
    const old = await setup({}, 8);
    assert.equal(await sweepFixes(old.deps), 1);
    assert.deepEqual(old.closed, [7]);
    assert.equal((await getFix(old.db, "f1"))?.status, "closed");
    const fresh = await setup({});
    assert.equal(await sweepFixes(fresh.deps), 0);
    assert.equal((await getFix(fresh.db, "f1"))?.status, "draft");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `cd apps/web && node --test src/fix-sweep.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `src/fix-sweep.ts`** with the behaviour above. Then make the `worker.ts` edit, importing `sweepFixes`, `fixRepoFor` and `fetchHtml`.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `cd apps/web && npm test && npm run typecheck`. Expected: PASS and exit 0.
- [ ] **Step 5: Commit.** `git add apps/web/src/fix-sweep.ts apps/web/src/fix-sweep.test.ts apps/web/worker.ts && git commit -m "Fix engine: daily sweep for missed webhook events and stale drafts"`

### Task 15: Fixes panel, API, and removing the old flow

**Files:**
- Create: `apps/web/app/api/sites/[siteId]/fixes/route.ts`, `apps/web/app/api/fixes/[fixId]/open/route.ts`, `apps/web/app/api/fixes/[fixId]/reject/route.ts`, `apps/web/app/components/FixesPanel.tsx`
- Modify:
  - `apps/web/src/fix-run.ts`: add `parseFixSettings`
  - `apps/web/src/fix-run.test.ts`: add its test
  - `apps/web/app/components/ReportTabs.tsx`:
    - `TechnicalTab` drops the `changes`, `busy`, `onGenerateChange` and `onOpenPullRequest` props and renders `<FixesPanel siteId={siteId} hasRepo={hasRepo} />` above the findings card;
    - `FindingRow` drops its fix button and `change` prop;
    - delete the `Change` type.
  - `apps/web/app/components/OverviewView.tsx`: remove the `changes` state, its two fetches (around lines 107 and 115), `generateChange`, `openPullRequest`, and the props passed to `TechnicalTab` (around line 298). Keep `busy` if anything else uses it.
- Delete:
  - `apps/web/app/api/analyses/[analysisId]/changes/route.ts`
  - `apps/web/app/api/changes/[changeId]/pull-request/route.ts`
  - `packages/agents/src/change-generator.ts`
  - `packages/agents/src/change-generator.test.ts`
  - the `change-generator` export in `packages/agents/src/index.ts` (`grep -n change-generator packages/agents/src/index.ts`)

**Interfaces:**
- Consumes: Tasks 9, 11 and 12; `requireSite(request, siteId, "read" | "write")` and `requireOwned(request, "change", id, "write")` from `src/guard.ts`; `featureRefusal`; `fail` from `src/server.ts`; `api` from `app/components/api.ts`; `Badge`, `Button`, `Card`, `CopyBlock` from `app/components/ui.tsx`.
- Produces:
  - `parseFixSettings(body: unknown): FixSettings | string`, where a string is the error message
  - `GET /api/sites/:siteId/fixes` returns `{ fixes: FixView[]; settings: FixSettings; open: number }`, where `FixView` is `FixRecord` without `files` and `original` (too large for the browser)
  - `PUT /api/sites/:siteId/fixes` takes `FixSettings` and returns `{ settings }`
  - `POST /api/fixes/:fixId/open` returns `{ fix }`, or 409 or 403 with `{ error }`
  - `POST /api/fixes/:fixId/reject` returns `{ fix }`

- [ ] **Step 1: Write the failing test.** Append to `apps/web/src/fix-run.test.ts`:

```ts
import { parseFixSettings } from "./fix-run.ts";

describe("parseFixSettings", () => {
  it("accepts booleans and a budget from 1 to 5", () => {
    assert.deepEqual(parseFixSettings({ allowAiSearch: true, budget: 2, autopilot: false }), { allowAiSearch: true, budget: 2, autopilot: false });
  });
  it("explains what's wrong otherwise", () => {
    assert.equal(typeof parseFixSettings({ allowAiSearch: "yes", budget: 2, autopilot: true }), "string");
    assert.equal(typeof parseFixSettings({ allowAiSearch: true, budget: 9, autopilot: true }), "string");
    assert.equal(typeof parseFixSettings(null), "string");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `cd apps/web && node --test src/fix-run.test.ts`. Expected: FAIL, because `parseFixSettings` isn't exported.
- [ ] **Step 3: Implement `parseFixSettings`** in `fix-run.ts`:

```ts
export function parseFixSettings(body: unknown): FixSettings | string {
  const b = body as Partial<FixSettings> | null;
  if (!b || typeof b.allowAiSearch !== "boolean" || typeof b.autopilot !== "boolean") return "Send allowAiSearch and autopilot as true or false.";
  if (!Number.isInteger(b.budget) || b.budget! < 1 || b.budget! > 5) return "The PR budget must be a whole number from 1 to 5.";
  return { allowAiSearch: b.allowAiSearch, budget: b.budget!, autopilot: b.autopilot };
}
```

Run the test. Expected: PASS.

- [ ] **Step 4: Routes.** `apps/web/app/api/sites/[siteId]/fixes/route.ts`:

```ts
import { env } from "cloudflare:workers";
import { countOpenFixes, getFixSettings, listFixes, setFixSettings, type D1Like } from "@organic-growth/db";
import { parseFixSettings } from "../../../../../src/fix-run";
import { requireSite } from "../../../../../src/guard";
import { fail } from "../../../../../src/server";

type Ctx = { params: Promise<{ siteId: string }> };

export async function GET(request: Request, context: Ctx) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "read");
  if (access instanceof Response) return access;
  const db = env.DB as D1Like;
  const fixes = (await listFixes(db, siteId)).map(({ files: _files, original: _original, ...rest }) => rest);
  return Response.json({ fixes, settings: await getFixSettings(db, siteId), open: await countOpenFixes(db, siteId) });
}

export async function PUT(request: Request, context: Ctx) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const settings = parseFixSettings(await request.json().catch(() => null));
  if (typeof settings === "string") return fail(settings, 400);
  await setFixSettings(env.DB as D1Like, siteId, settings);
  return Response.json({ settings });
}
```

`apps/web/app/api/fixes/[fixId]/open/route.ts`. First confirm that `requireOwned`'s `"change"` kind looks the row up in `changes` by id: `grep -n '"change"' apps/web/src/guard.ts apps/web/src/access.ts`. Then write:

```ts
import { env } from "cloudflare:workers";
import { countOpenFixes, getFix, getFixSettings, type D1Like } from "@organic-growth/db";
import { fixRepoFor } from "../../../../../src/fix-github";
import { openStagedFixes } from "../../../../../src/fix-run";
import { fetchHtml } from "../../../../../src/fix-steps";
import { requireOwned } from "../../../../../src/guard";
import { featureRefusal } from "../../../../../src/limits";
import { fail, settingsFor } from "../../../../../src/server";

export async function POST(request: Request, context: { params: Promise<{ fixId: string }> }) {
  const { fixId } = await context.params;
  const access = await requireOwned(request, "change", fixId, "write");
  if (access instanceof Response) return access;
  const db = env.DB as D1Like;
  const fix = await getFix(db, fixId);
  if (!fix) return fail("Fix not found.", 404);
  if (fix.status !== "staged") return fail("Only a staged fix can be opened as a pull request.", 409);
  const { site } = access;
  const refusal = await featureRefusal(db, site.workspaceId!, "pullRequests");
  if (refusal) return fail(refusal, 403);
  const { budget } = await getFixSettings(db, site.id);
  if ((await countOpenFixes(db, site.id)) >= budget) return fail(`This site already has ${budget} open Eumon pull requests. Merge or close one first, or raise the budget.`, 409);
  try {
    const { repo, pr } = await fixRepoFor(env, site);
    const settings = await settingsFor(site);
    await openStagedFixes({ db, repo, llm: null, budget: { calls: 0 }, fetchPage: fetchHtml, now: () => new Date() }, pr, { siteId: site.id, origin: settings.publicOrigin || site.baseUrl, budget, onlyId: fixId, max: 1 });
    return Response.json({ fix: await getFix(db, fixId) });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Eumon couldn't open the pull request. Check that the GitHub App can write contents and pull requests.", 502);
  }
}
```

`apps/web/app/api/fixes/[fixId]/reject/route.ts` follows the same guard pattern:
- It accepts status `staged`, `draft` or `ready`; anything else gets 409.
- If the fix has a `prNumber`, call `ops.comment(n, "Rejected in Eumon; it won't propose this fix for this route again.")` and then `ops.close(n)`, both inside try/catch. GitHub failing must not block the rejection.
- Then `updateFix(db, fixId, { status: "rejected", result: "Rejected in Eumon." })`, and respond with `{ fix: await getFix(db, fixId) }`.

Strip `files` and `original` from every fix a route returns, as the GET does.

- [ ] **Step 5: `FixesPanel.tsx`.** Match the existing components' style: `Card`, `Badge`, `Button small`, `CopyBlock`, and hard corners (the user's preference).

```tsx
"use client";
import { useEffect, useState } from "react";
import { api } from "./api";
import { Badge, Button, Card, CopyBlock } from "./ui";

type FixView = {
  id: string; kind: string; route: string; filePath: string; title: string; reason: string; urls: string[]; snippet?: string;
  beforeSnippet?: string; afterSnippet?: string; warnings: string[]; status: string; prUrl?: string; result?: string;
};
type Settings = { allowAiSearch: boolean; budget: number; autopilot: boolean };

const STATUS_LABEL: Record<string, string> = {
  staged: "Ready to open", skipped: "Snippet", draft: "Draft PR", ready: "Ready for review", merged: "Merged",
  failed: "Failed checks", rejected: "Rejected", closed: "Closed", reverted: "Reverted",
};

export function FixesPanel({ siteId, hasRepo }: { siteId: string; hasRepo: boolean }) {
  const [data, setData] = useState<{ fixes: FixView[]; settings: Settings; open: number } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = () => api<{ fixes: FixView[]; settings: Settings; open: number }>(`/api/sites/${siteId}/fixes`).then(setData).catch(() => setData(null));
  useEffect(() => { void load(); }, [siteId]);

  const act = async (id: string, path: string, init?: Parameters<typeof api>[1]) => {
    setBusy(id); setError("");
    try { await api(path, init ?? { method: "POST" }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Something went wrong. Try again."); }
    finally { setBusy(""); }
  };
  const save = (next: Settings) => act("settings", `/api/sites/${siteId}/fixes`, { method: "PUT", json: next });

  if (!hasRepo) return <Card title="Code fixes"><p className="muted">Connect a GitHub repository in Connections, and Eumon will open small pull requests that fix head tags, structured data and llms.txt.</p></Card>;
  if (!data) return null;
  const { fixes, settings, open } = data;
  return (
    <Card title="Code fixes" subtitle="Small pull requests, checked by your CI and preview deploy. You merge." actions={<span className="count-pill">{open} of {settings.budget} open</span>}>
      <div className="fix-settings">
        <label><input type="checkbox" checked={settings.autopilot} disabled={busy === "settings"} onChange={(e) => save({ ...settings, autopilot: e.target.checked })} /> Open pull requests automatically</label>
        <label>At most <select value={settings.budget} disabled={busy === "settings"} onChange={(e) => save({ ...settings, budget: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</select> open at once</label>
        <label><input type="checkbox" checked={settings.allowAiSearch} disabled={busy === "settings"} onChange={(e) => save({ ...settings, allowAiSearch: e.target.checked })} /> Let AI search crawlers read the site (never training crawlers)</label>
      </div>
      {error && <p className="form-error">{error}</p>}
      {fixes.length === 0 && <p className="muted">No code fixes yet. They're prepared at the end of each analysis on Next.js App Router sites.</p>}
      {fixes.map((fix) => (
        <details key={fix.id} className="fix-row">
          <summary>
            <Badge>{STATUS_LABEL[fix.status] ?? fix.status}</Badge> <strong>{fix.title}</strong> <span className="muted">{fix.urls.length} pages · {fix.filePath}</span>
          </summary>
          <p>{fix.reason}</p>
          {fix.result && <p className="muted">{fix.result}</p>}
          {fix.warnings.map((w) => <p key={w} className="muted">{w}</p>)}
          {fix.beforeSnippet && <><h4>Before</h4><pre>{fix.beforeSnippet}</pre></>}
          {fix.afterSnippet && <><h4>After</h4><pre>{fix.afterSnippet}</pre></>}
          {fix.status === "skipped" && fix.snippet && <><h4>Paste this into {fix.filePath}</h4><CopyBlock code={fix.snippet} /></>}
          <div className="row-actions">
            {fix.prUrl && <a href={fix.prUrl} target="_blank" rel="noreferrer">View pull request</a>}
            {fix.status === "staged" && <Button small busy={busy === fix.id} disabled={Boolean(busy)} onClick={() => act(fix.id, `/api/fixes/${fix.id}/open`)}>Open now</Button>}
            {["staged", "draft", "ready"].includes(fix.status) && <Button small variant="ghost" disabled={Boolean(busy)} onClick={() => act(fix.id, `/api/fixes/${fix.id}/reject`)}>Reject</Button>}
          </div>
        </details>
      ))}
    </Card>
  );
}
```

- Check `api`'s init type supports `{ method, json }`. `OverviewView.tsx:189` uses `{ method: "POST", json: { findingId } }`, so it does.
- Add any missing CSS classes (`fix-settings`, `fix-row`, `row-actions`, `form-error`) to the app stylesheet, after first grepping for existing equivalents to reuse: `grep -n "row-actions\|form-error\|\.muted" apps/web/app/*.css`. Keep corners square (`border-radius: 0`), following DESIGN.md.

- [ ] **Step 6: Remove the old flow.** Apply the ReportTabs, OverviewView and delete edits listed under Files. Then run `grep -rn "change-generator\|onGenerateChange\|pull-request\|SAFE_SEO_CONFIG_PATHS" apps packages --include=*.ts --include=*.tsx`. Expected: no hits outside `node_modules` and `dist`.
- [ ] **Step 7: Verify.**
  1. Run `npm run build:packages && npm test && (cd apps/web && npm run typecheck)`. Expected: all PASS and exit 0.
  2. Start the dev server on 5175 (Global Constraints) and apply migrations locally: `cd apps/web && npm run db:migrate:local`, or whichever *local* script `package.json` has. Never the remote one.
  3. The user signs in with Google. Never type credentials; ask them to sign in on 5175 if needed.
  4. Open a site's Dashboard → Technical tab. Confirm:
     - without a repo, the panel shows the "Connect a GitHub repository" text;
     - with a connected repo, the settings row saves (reload and see the values kept);
     - the empty state shows.
  5. Report what you saw.
- [ ] **Step 8: Commit.**

```bash
git add -A apps/web packages/agents
git commit -m "Fix engine: Fixes panel with open, reject and snippets; remove the robots.txt-only change flow"
```

### Task 16: Docs and hand-off

**Files:**
- Modify: the docs page about the GitHub integration. Find it with `grep -rln "GitHub App\|pull request" docs README.md apps/web/README.md 2>/dev/null`. If there's none, add a "Code fixes" section to `README.md`.

- [ ] **Step 1: Write the docs.** Plain sentences, no marketing:
  - **What it does:** the five fix types; Next.js App Router only; when fixes are prepared (the end of each analysis); the PR budget; human merge; the 7-day close; the revert PR on a broken recrawl.
  - **What it never does:**
    - merge;
    - touch files outside `app/**/page.tsx`, the root layout, `components/eumon-json-ld.tsx`, `public/llms.txt` and `public/robots.txt`;
    - add dependencies;
    - allow AI training crawlers;
    - edit a hand-written `llms.txt`.
  - **GitHub App setup** (done by the site owner or admin, at `github.com/settings/apps/eumon-growth-engine`):
    - Repository permissions: Contents read & write, Pull requests read & write, Checks read, Commit statuses read, Deployments read.
    - Subscribe to the events Check run, Check suite, Status, Deployment status and Pull request.
    - Webhook URL `https://eumon.chin-gabriel.workers.dev/api/github/webhook`, with a random secret.
    - Store the secret with `npx wrangler secret put GITHUB_WEBHOOK_SECRET`. Locally it goes in `apps/web/.dev.vars`.
    - Existing installations must accept the new permissions.
  - **Migration:** `0025_fix_engine.sql` must be applied before deploy.
- [ ] **Step 2: Final check.** Run `npm run build:packages && npm test && (cd apps/web && npm run typecheck)`. Expected: all PASS and exit 0.
- [ ] **Step 3: Commit.** `git add -A docs README.md && git commit -m "Docs: code fixes and the GitHub App setup they need"`
- [ ] **Step 4: Hand-off to the user.** Don't push or open a PR without asking. Report:
  - the commits;
  - the test totals;
  - the manual steps from Step 1's GitHub App setup;
  - that `0025` must be applied remotely before the merge deploys;
  - that a real end-to-end run needs a Next.js App Router test repo with CI and a preview deploy (Vercel or Cloudflare). Spec §10's manual e2e is the user's call: offer to run it on a repo they choose.
