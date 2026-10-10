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
