import { CHECKS, finding, organicImpactScore, type CrawlCoverage, type Finding } from "@organic-growth/core";
import { classifyUrlType, type RenderComparison } from "@organic-growth/crawler";
import { routeFamily, type RepoAnalysisResult } from "@organic-growth/repo-analyzer";

type Draft = Pick<Finding, "title" | "summary" | "recommendation" | "evidence" | "organicImpactScore" | "scopeKey"> & { checkId: string; pagesAffected?: string[] };

const count = (value: number) => value.toLocaleString("en");
const familyLabel = (family: string) => (family === "home" ? "the homepage" : family === "page" ? "top-level pages" : `/${family}/ pages`);

function serverFetchAdvice(framework: string, router?: string): string {
  if (router === "App Router") return "Make the page a server component that awaits its data (keep interactive parts in a small client child), so the content is in the HTML.";
  if (router === "Pages Router") return "Load the data in getStaticProps (with revalidate) or getServerSideProps and pass it as props instead of fetching in an effect.";
  if (framework === "Nuxt") return "Load the data with useFetch or useAsyncData, which run on the server, instead of fetching in onMounted.";
  if (framework.startsWith("Vite") || framework === "Create React App") return "Prerender these routes at build time (e.g. vite-react-ssg) or move them to a server-rendering framework, so crawlers get the content without running JavaScript.";
  return "Render the main content on the server so it is part of the HTML response.";
}

/**
 * Explains crawl problems from the code that produces them: templates that
 * fetch content in the browser, titles that never vary, request waterfalls
 * behind slow pages, and list queries that silently truncate (Supabase's
 * 1,000-row default) or will outgrow a single sitemap.
 */
export function findingsFromCode(input: {
  siteId: string;
  analysisId: string;
  repo: RepoAnalysisResult;
  coverage?: CrawlCoverage | null;
  comparisons?: RenderComparison[];
  repeatability?: Array<{ family: string; medianMs: number; failed: number; attempts: number }>;
  /** Sitemap URLs per route family. */
  familySizes: Record<string, number>;
}): Finding[] {
  const { repo } = input;
  const framework = repo.fingerprint.framework;
  const router = repo.fingerprint.router;
  const drafts: Draft[] = [];
  const familyStats = new Map((input.coverage?.families ?? []).map((family) => [family.family, family]));
  const sizeOf = (family: string) => input.familySizes[family] ?? familyStats.get(family)?.urls ?? 0;
  const templates = repo.routeInspections.filter((route) => route.dynamic || sizeOf(routeFamily(route.pathPattern)) > 1);

  for (const route of templates.filter((entry) => entry.clientDataFetching)) {
    const family = routeFamily(route.pathPattern);
    const stats = familyStats.get(family);
    const rendered = (input.comparisons ?? []).find((comparison) => comparison.family === family);
    const confirmed = (stats && stats.emptyShells > 0) || rendered?.verdict === "client_rendered" || rendered?.verdict === "partially_client_rendered";
    const evidence = stats && stats.emptyShells > 0
      ? ` The crawl confirms it: ${count(stats.emptyShells)} of ${count(stats.crawled)} ${familyLabel(family)} returned an empty or thin HTML shell.`
      : rendered && rendered.verdict !== "server_rendered"
        ? ` A browser rendering of ${rendered.url} shows ${count(rendered.renderedTextLength)} characters of text; the HTML has ${count(rendered.rawTextLength)}.`
        : "";
    drafts.push({
      checkId: "repo.client_fetch",
      scopeKey: family,
      title: `${familyLabel(family)[0]!.toUpperCase()}${familyLabel(family).slice(1)} fetch their content in the browser`,
      summary: `${route.source} (${route.pathPattern}) loads its data client-side (${route.clientDataFetching}), so the HTML crawlers receive doesn't contain it.${evidence}`,
      recommendation: serverFetchAdvice(framework, router),
      evidence: { route, crawl: stats ?? null, render: rendered ?? null },
      organicImpactScore: confirmed
        ? organicImpactScore({ category: "rendering", pagesAffected: Math.max(sizeOf(family), 1), isEmptyShellAtScale: true })
        : 40,
    });
  }

  const duplicateTitles = new Map<string, number>();
  for (const group of input.coverage?.duplicateTitleGroups ?? []) {
    for (const family of new Set(group.examples.map((url) => classifyUrlType(url)))) duplicateTitles.set(family, (duplicateTitles.get(family) ?? 0) + group.count);
  }
  for (const route of templates.filter((entry) => entry.dynamic && entry.metadata !== "server")) {
    const family = routeFamily(route.pathPattern);
    const shared = duplicateTitles.get(family) ?? 0;
    const pages = Math.max(sizeOf(family), 1);
    const what = route.metadata === "client"
      ? `sets its title and meta tags in the browser (${route.metadataEvidence ?? "client-side head manager"}), so crawlers that don't run JavaScript see the generic ones`
      : route.metadata === "inherited"
        ? "has no generateMetadata of its own, so every page inherits the same title and description from a parent layout"
        : "sets no page-specific title or description";
    drafts.push({
      checkId: "repo.no_own_title",
      scopeKey: family,
      title: `${familyLabel(family)[0]!.toUpperCase()}${familyLabel(family).slice(1)} don't get their own title in the HTML`,
      summary: `${route.source} (${route.pathPattern}) ${what}.${shared ? ` The crawl found duplicate titles on ${familyLabel(family)}.` : ""}`,
      recommendation: router === "App Router"
        ? "Export generateMetadata from the page and build the title and description from the record (name, location, key facts)."
        : router === "Pages Router"
          ? "Render <Head> with a title and description built from the page's props."
          : framework === "Nuxt"
            ? "Call useSeoMeta with values from the page's data (it renders on the server)."
            : "Generate the title and meta tags into the HTML at build or request time (prerendering or server rendering).",
      evidence: { route, duplicateTitleUrls: shared },
      organicImpactScore: Math.min(organicImpactScore({ category: "metadata", pagesAffected: pages, commercialIntent: true }) + (shared ? 20 : 5), 65),
    });
  }

  for (const route of repo.routeInspections.filter((entry) => entry.sequentialAwaits >= 3 && entry.rendering !== "static" && entry.rendering !== "client")) {
    const family = routeFamily(route.pathPattern);
    const timing = input.repeatability?.find((entry) => entry.family === family);
    const slow = timing && timing.medianMs >= 2000;
    drafts.push({
      checkId: "repo.sequential_awaits",
      scopeKey: family,
      title: `${familyLabel(family)[0]!.toUpperCase()}${familyLabel(family).slice(1)} wait for ${route.sequentialAwaits} data requests in sequence`,
      summary: `${route.source} renders per request (${route.renderingEvidence ?? route.rendering}) and awaits ${route.sequentialAwaits} data requests one after another before sending HTML.${slow ? ` Googlebot fetches of ${familyLabel(family)} took a median ${(timing.medianMs / 1000).toFixed(1)} s.` : ""}`,
      recommendation: "Run independent requests together with Promise.all, cache shared lookups, or make the route static with revalidation so the HTML is ready before crawlers ask.",
      evidence: { route, timing: timing ?? null },
      organicImpactScore: slow ? Math.min(organicImpactScore({ category: "rendering", pagesAffected: Math.max(sizeOf(family), 1) }) + 15, 55) : 20,
    });
  }

  // Supabase (PostgREST) returns at most 1,000 rows per request unless a range is given.
  const supabase = repo.fingerprint.database === "Supabase";
  const capped = Object.entries(input.familySizes).filter(([, size]) => size === 1000).map(([family]) => family);
  if (repo.sitemapCode?.unboundedQueries.length) {
    const { source, unboundedQueries, splitsSitemaps } = repo.sitemapCode;
    const total = Object.values(input.familySizes).reduce((sum, size) => sum + size, 0);
    if (supabase) {
      drafts.push({
        checkId: "repo.sitemap_capped",
        title: capped.length ? `The sitemap stops at 1,000 ${familyLabel(capped[0]!)}` : "The sitemap query can stop at 1,000 rows",
        summary: `${source} reads ${unboundedQueries.map((query) => query.split(":")[0]).join(", ")} with no range. Supabase returns at most 1,000 rows per request by default, so records beyond the first 1,000 never reach the sitemap.${capped.length ? ` The live sitemap lists exactly 1,000 ${familyLabel(capped[0]!)}.` : ""}`,
        recommendation: "Page through the table with .range(from, to) until a short page comes back, and split the sitemap (e.g. Next.js generateSitemaps) before it reaches 50,000 URLs.",
        evidence: { source, unboundedQueries, cappedFamilies: capped },
        organicImpactScore: capped.length ? 80 : 45,
      });
    } else if (!splitsSitemaps) {
      drafts.push({
        checkId: "repo.sitemap_unpaged",
        title: "The sitemap is built from one query with no paging",
        summary: `${source} loads every row in one query (${unboundedQueries.map((query) => query.split(":")[0]).join(", ")}) and writes a single sitemap. ${total > 40_000 ? `With ~${count(total)} URLs already, it will pass the 50,000-URL limit of a single sitemap.` : "This slows down as the data grows and breaks at 50,000 URLs, the limit for one sitemap file."}`,
        recommendation: "Query in pages (LIMIT/OFFSET or a cursor) and split the sitemap into an index with files of up to 50,000 URLs.",
        evidence: { source, unboundedQueries, sitemapUrls: total },
        organicImpactScore: total > 40_000 ? 60 : 25,
      });
    }
  }

  const unbounded = repo.routeInspections.filter((route) => route.unboundedQueries.length);
  if (unbounded.length) {
    const truncates = supabase && unbounded.some((route) => route.prebuildsPaths || route.rendering === "client");
    drafts.push({
      checkId: "repo.unpaged_queries",
      title: supabase ? "List queries without a range return at most 1,000 rows" : "Pages load whole tables without pagination",
      summary: `${unbounded.slice(0, 4).map((route) => `${route.source} (${route.unboundedQueries.map((query) => query.split(":")[0]).join(", ")})`).join("; ")} ${unbounded.length === 1 ? "reads" : "read"} every row with no limit.${supabase ? " Supabase silently stops at 1,000 rows by default, so pages or static paths beyond that are missing." : " Response time and memory grow with the table, which is how programmatic pages start timing out."}`,
      recommendation: "Paginate list queries (.range() in Supabase, take/skip in Prisma, LIMIT/OFFSET in SQL). On listing pages, expose the pages as crawlable links (?page=2) so every entity stays reachable.",
      evidence: { routes: unbounded.map((route) => ({ source: route.source, pathPattern: route.pathPattern, queries: route.unboundedQueries })) },
      organicImpactScore: truncates ? 55 : 30,
    });
  }

  const createdAt = new Date().toISOString();
  return drafts.map(({ checkId, organicImpactScore: impact, ...rest }) => finding(CHECKS[checkId]!, { ...rest, siteId: input.siteId, analysisId: input.analysisId, impact, createdAt }));
}

