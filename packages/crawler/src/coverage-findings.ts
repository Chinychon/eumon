import type { CrawlCoverage, CrawlFamilyStats, CrawlIssue, CrawlLocaleStats, CrawlPageResult, Finding, FindingCategory } from "@organic-growth/core";
import { createId, organicImpactScore, severityFromImpact } from "@organic-growth/core";

type Draft = {
  category: FindingCategory;
  impact: number;
  title: string;
  summary: string;
  recommendation: string;
  evidence: Finding["evidence"];
  pagesAffected?: string[];
};

const count = (value: number) => value.toLocaleString("en");
/** "1 page has" / "12 pages have". */
const pages = (value: number, singular = "page", plural = `${singular}s`) => `${count(value)} ${value === 1 ? singular : plural}`;
const share = (part: number, whole: number) => `${Math.round((part / Math.max(whole, 1)) * 100)}%`;

/** "/procedures/ (45 of 50), /blog/ (3 of 120)" — where a problem is concentrated, by page template. */
function byFamily(families: CrawlFamilyStats[] | undefined, pick: (family: CrawlFamilyStats) => number, limit = 4): string {
  return (families ?? [])
    .filter((family) => pick(family) > 0)
    .sort((a, b) => pick(b) - pick(a))
    .slice(0, limit)
    .map((family) => `${familyLabel(family.family)} (${count(pick(family))} of ${count(family.urls)})`)
    .join(", ");
}

function familyLabel(family: string): string {
  return family === "home" ? "the homepage" : family === "page" ? "top-level pages" : `/${family}/`;
}

function isSiteRoot(href: string | undefined, origin: string | undefined): boolean {
  if (!href) return false;
  try {
    const url = new URL(href, origin);
    return url.pathname === "/" || url.pathname === "";
  } catch {
    return false;
  }
}

/** Findings based on every sitemap URL, rather than extrapolating from a sample. */
export function findingsFromCrawlCoverage(input: {
  siteId: string;
  analysisId: string;
  coverage: CrawlCoverage;
  examples?: CrawlPageResult[];
}): Finding[] {
  const { coverage } = input;
  const issues = coverage.issues ?? {};
  const examples = coverage.issueExamples ?? {};
  const families = coverage.families;
  const crawled = Math.max(coverage.completedUrls, 1);
  const served = Math.max(coverage.completedUrls - coverage.httpErrorUrls - (issues.botChallenge ?? 0), 1);
  // Pages dropped from the index by noindex, a foreign canonical, or robots.txt
  // are scored by the share of the site they represent (a proxy for traffic share).
  const exampleUrls = (issue: CrawlIssue) => (examples[issue] ?? []).map((example) => example.url);
  const drafts: Draft[] = [];

  if (coverage.emptyShellUrls > 0) {
    const shellRatio = coverage.emptyShellUrls / crawled;
    const where = byFamily(families, (family) => family.emptyShells);
    const shellPages = (input.examples ?? []).filter((page) => page.isEmptyShell).slice(0, 20);
    drafts.push({
      category: "rendering",
      impact: organicImpactScore({
        category: "rendering",
        pagesAffected: coverage.emptyShellUrls,
        isEmptyShellAtScale: shellRatio >= 0.1 || coverage.emptyShellUrls >= 25,
        isBlockingCrawl: shellRatio >= 0.3,
      }),
      title: "Googlebot receives empty or thin HTML on sitemap URLs",
      summary: `${count(coverage.emptyShellUrls)} of ${count(coverage.completedUrls)} crawled sitemap URLs returned an empty or thin HTML shell (${share(coverage.emptyShellUrls, crawled)}).${where ? ` Concentrated in ${where}.` : ""}`,
      evidence: {
        coverage: { totalUrls: coverage.totalUrls, completedUrls: coverage.completedUrls, emptyShellUrls: coverage.emptyShellUrls },
        families: (families ?? []).filter((family) => family.emptyShells > 0),
        examples: shellPages.map((page) => ({ url: page.url, status: page.status, title: page.title, textLength: page.rawTextLength })),
      },
      recommendation: "Ensure indexable routes return meaningful server or edge HTML before client hydration, then validate the affected template across its sitemap URLs.",
      pagesAffected: shellPages.map((page) => page.url),
    });
  }

  const homepageNoindex = (families ?? []).some((family) => family.family === "home" && family.noindex > 0);
  if (homepageNoindex) {
    drafts.push({
      category: "indexing",
      impact: 100,
      title: "The homepage is marked noindex",
      summary: "The homepage tells search engines not to index it (robots meta tag or X-Robots-Tag header). This is usually a staging or preview setting that shipped to production, and it often affects the whole site.",
      evidence: { examples: examples.noindex ?? [] },
      recommendation: "Remove the noindex directive from production (check environment-dependent metadata, framework robots settings, and hosting headers), then request indexing in Search Console.",
      pagesAffected: exampleUrls("noindex"),
    });
  }

  const noindex = issues.noindex ?? 0;
  if (noindex > (homepageNoindex ? 1 : 0)) {
    const ratio = noindex / served;
    drafts.push({
      category: "indexing",
      impact: organicImpactScore({ category: "indexing", pagesAffected: noindex, isBlockingCrawl: ratio >= 0.3, trafficShareAffected: ratio }),
      title: "Sitemap lists pages that are marked noindex",
      summary: `${pages(noindex, "sitemap URL")} (${share(noindex, served)} of pages that loaded) ${noindex === 1 ? "carries" : "carry"} a noindex directive.${byFamily(families, (family) => family.noindex) ? ` Mostly ${byFamily(families, (family) => family.noindex)}.` : ""} The sitemap asks Google to index them while the pages refuse.${ratio >= 0.3 ? " At this share, a staging or preview setting has probably shipped to production." : ""}`,
      evidence: { noindexUrls: noindex, examples: examples.noindex ?? [] },
      recommendation: "For each section, decide whether it should rank: remove the noindex if it should, or remove the URLs from the sitemap if it shouldn't.",
      pagesAffected: exampleUrls("noindex"),
    });
  }

  const robotsBlocked = issues.robotsBlocked ?? 0;
  if (robotsBlocked > 0) {
    drafts.push({
      category: "indexing",
      impact: organicImpactScore({
        category: "indexing",
        pagesAffected: robotsBlocked,
        isBlockingCrawl: robotsBlocked / Math.max(coverage.totalUrls, 1) >= 0.1,
        trafficShareAffected: robotsBlocked / Math.max(coverage.totalUrls, 1),
      }),
      title: "Sitemap lists URLs that robots.txt blocks for Googlebot",
      summary: `${pages(robotsBlocked, "sitemap URL")} (${share(robotsBlocked, coverage.totalUrls)}) ${robotsBlocked === 1 ? "is" : "are"} disallowed for Googlebot by robots.txt, so Google can't crawl what the sitemap asks it to index.`,
      evidence: { robotsBlockedUrls: robotsBlocked, examples: examples.robotsBlocked ?? [] },
      recommendation: "If these pages should rank, remove the Disallow rule that matches them; otherwise remove them from the sitemap.",
      pagesAffected: exampleUrls("robotsBlocked"),
    });
  }

  const canonical = issues.canonicalMismatch ?? 0;
  if (canonical > 0) {
    const canonicalExamples = examples.canonicalMismatch ?? [];
    const toHome = canonicalExamples.filter((example) => isSiteRoot(example.detail, example.url) && !isSiteRoot(example.url, undefined)).length;
    const homepageCanonical = canonicalExamples.length >= 3 && toHome / canonicalExamples.length >= 0.8;
    drafts.push({
      category: "indexing",
      impact: organicImpactScore({
        category: "indexing",
        pagesAffected: canonical,
        isBlockingCrawl: homepageCanonical || canonical / served >= 0.5,
        trafficShareAffected: canonical / served,
      }),
      title: homepageCanonical ? "Pages declare the homepage as their canonical URL" : "Sitemap URLs declare a different canonical URL",
      summary: homepageCanonical
        ? `${pages(canonical)} point their canonical tag at the homepage, which asks Google to drop them in favour of it. This usually comes from a canonical set once in a shared layout instead of per page.`
        : `${pages(canonical, "sitemap URL")} (${share(canonical, served)}) ${canonical === 1 ? "names" : "name"} another URL as canonical. Sitemaps should list only canonical URLs; otherwise Google may index a different page than the one you expect.`,
      evidence: { canonicalMismatchUrls: canonical, examples: canonicalExamples },
      recommendation: homepageCanonical
        ? "Generate the canonical URL per page from its own path (e.g. in the page's metadata function), not in the root layout."
        : "List only canonical URLs in the sitemap, or fix the canonical tags if these pages are the preferred versions.",
      pagesAffected: exampleUrls("canonicalMismatch"),
    });
  }

  if (coverage.httpErrorUrls > 0 || coverage.failedUrls > 0) {
    const affected = coverage.httpErrorUrls + coverage.failedUrls;
    const where = byFamily(families, (family) => family.errors);
    drafts.push({
      category: "indexing",
      impact: organicImpactScore({
        category: "indexing",
        pagesAffected: affected,
        isBlockingCrawl: affected / Math.max(coverage.totalUrls, 1) >= 0.05,
      }),
      title: "Sitemap URLs fail or return error responses",
      summary: `${pages(coverage.httpErrorUrls, "URL")} returned HTTP errors and ${count(coverage.failedUrls)} could not be fetched during the crawl.${where ? ` Most are in ${where}.` : ""}`,
      evidence: { coverage: { httpErrorUrls: coverage.httpErrorUrls, failedUrls: coverage.failedUrls }, families: (families ?? []).filter((family) => family.errors > 0) },
      recommendation: "Review recurring response failures by route template and remove invalid URLs from the sitemap after correcting the underlying route or data issue.",
    });
  }

  const redirected = issues.redirected ?? 0;
  if (redirected > 0) {
    drafts.push({
      category: "sitemap",
      impact: Math.min(organicImpactScore({ category: "sitemap", pagesAffected: redirected }), 45),
      title: "Sitemap lists URLs that redirect",
      summary: `${pages(redirected, "sitemap URL")} ${redirected === 1 ? "redirects" : "redirect"} to another address. Each redirect costs crawl budget and delays indexing of the destination.`,
      evidence: { redirectedUrls: redirected, examples: examples.redirected ?? [] },
      recommendation: "List each page's final URL (scheme, host, and trailing slash as served) in the sitemap.",
      pagesAffected: exampleUrls("redirected"),
    });
  }

  if (coverage.missingTitleUrls > 0) {
    drafts.push({
      category: "metadata",
      impact: Math.min(organicImpactScore({ category: "metadata", pagesAffected: coverage.missingTitleUrls }), 65),
      title: "Sitemap URLs are missing useful title tags",
      summary: `${pages(coverage.missingTitleUrls, "crawled sitemap URL")} had no title or a title shorter than 15 characters.`,
      evidence: { missingTitleUrls: coverage.missingTitleUrls },
      recommendation: "Trace the affected URLs to their page template and generate unique titles from page-specific entities and search intent.",
    });
  }

  const duplicateTitles = issues.duplicateTitle ?? 0;
  if (duplicateTitles > 0) {
    const groups = coverage.duplicateTitleGroups ?? [];
    drafts.push({
      category: "metadata",
      impact: Math.min(organicImpactScore({ category: "metadata", pagesAffected: duplicateTitles }), 45),
      title: "Several indexable pages share the same title",
      summary: `${pages(duplicateTitles)} share their title with at least one other page${groups[0] ? ` (e.g. “${groups[0].title}” on ${count(groups[0].count)} pages)` : ""}. Duplicate titles make pages compete with each other and hide what makes each one different.`,
      evidence: { duplicateTitleUrls: duplicateTitles, groups },
      recommendation: "Build each title from the page's own entity and attributes (name, location, type) in the page template.",
      pagesAffected: groups.flatMap((group) => group.examples).slice(0, 20),
    });
  }

  const missingH1 = issues.missingH1 ?? 0;
  if (missingH1 > 0) {
    drafts.push({
      category: "content",
      impact: Math.min(organicImpactScore({ category: "content", pagesAffected: missingH1 }), 45),
      title: "Pages without an H1 heading",
      summary: `${pages(missingH1)} that loaded content ${missingH1 === 1 ? "has" : "have"} no <h1> in the HTML crawlers receive (${share(missingH1, served)}). The main heading is a strong signal of what a page is about.`,
      evidence: { missingH1Urls: missingH1, examples: examples.missingH1 ?? [] },
      recommendation: "Render one <h1> per page that names its main subject, server-side in the page template.",
      pagesAffected: exampleUrls("missingH1"),
    });
  }

  const multipleH1 = issues.multipleH1 ?? 0;
  if (multipleH1 > 0) {
    drafts.push({
      category: "content",
      impact: Math.min(organicImpactScore({ category: "content", pagesAffected: multipleH1 }), 20),
      title: "Pages with more than one H1 heading",
      summary: `${pages(multipleH1)} ${multipleH1 === 1 ? "has" : "have"} several <h1> elements. This rarely hurts rankings, but it usually means a shared component (header, card, hero) renders an <h1> it shouldn't.`,
      evidence: { multipleH1Urls: multipleH1, examples: examples.multipleH1 ?? [] },
      recommendation: "Keep a single <h1> for the page's subject and demote component headings to <h2>/<h3>.",
      pagesAffected: exampleUrls("multipleH1"),
    });
  }

  const missingDescription = issues.missingDescription ?? 0;
  if (missingDescription > 0) {
    drafts.push({
      category: "metadata",
      impact: Math.min(organicImpactScore({ category: "metadata", pagesAffected: missingDescription }), 30),
      title: "Missing or very short meta descriptions",
      summary: `${pages(missingDescription)} ${missingDescription === 1 ? "has" : "have"} no meta description or one under 40 characters, so Google writes its own snippet.`,
      evidence: { missingDescriptionUrls: missingDescription, examples: examples.missingDescription ?? [] },
      recommendation: "Generate a description per page from its key facts and a reason to click (120–155 characters).",
      pagesAffected: exampleUrls("missingDescription"),
    });
  }

  const missingSchema = issues.missingStructuredData ?? 0;
  if (missingSchema > 0) {
    const where = byFamily(families, (family) => family.missingStructuredData, 5);
    drafts.push({
      category: "structured_data",
      impact: organicImpactScore({ category: "structured_data", pagesAffected: missingSchema }),
      title: "Detail pages have no structured data",
      summary: `${pages(missingSchema, "detail page")} ${missingSchema === 1 ? "has" : "have"} no JSON-LD in the HTML crawlers receive${where ? `: ${where}` : ""}. Structured data makes entity pages eligible for rich results and helps search engines understand them.`,
      evidence: { missingStructuredDataUrls: missingSchema, families: (families ?? []).filter((family) => family.missingStructuredData > 0), examples: examples.missingStructuredData ?? [] },
      recommendation: "Emit schema.org JSON-LD that matches each template (e.g. Product, LocalBusiness, Physician, MedicalProcedure, Article) in the server-rendered HTML.",
      pagesAffected: exampleUrls("missingStructuredData"),
    });
  }

  const invalidSchema = issues.invalidStructuredData ?? 0;
  if (invalidSchema > 0) {
    drafts.push({
      category: "structured_data",
      impact: Math.min(organicImpactScore({ category: "structured_data", pagesAffected: invalidSchema }) + 10, 50),
      title: "Structured data that fails to parse",
      summary: `${pages(invalidSchema)} ${invalidSchema === 1 ? "includes" : "include"} JSON-LD that isn't valid JSON, so search engines ignore it entirely.`,
      evidence: { invalidStructuredDataUrls: invalidSchema, examples: examples.invalidStructuredData ?? [] },
      recommendation: "Serialize JSON-LD with JSON.stringify (escaping `<`) instead of string templates, and validate a page per template with Google's Rich Results Test.",
      pagesAffected: exampleUrls("invalidStructuredData"),
    });
  }

  const challenged = issues.botChallenge ?? 0;
  if (challenged > 0) {
    drafts.push({
      category: "indexing",
      impact: challenged / crawled >= 0.5 ? 45 : 30,
      title: "Bot protection blocked part of the crawl",
      summary: `${pages(challenged, "URL")} (${share(challenged, crawled)}) returned a bot-protection challenge instead of the page, so they couldn't be checked. Verified search engine crawlers usually pass these rules, but a misconfigured rule can block Google too.`,
      evidence: { challengedUrls: challenged, examples: examples.botChallenge ?? [] },
      recommendation: "Spot-check a few of these URLs with URL Inspection in Search Console. If Google sees the challenge, allow verified bots in your firewall settings.",
      pagesAffected: exampleUrls("botChallenge"),
    });
  }

  const fallback = issues.botFallback ?? 0;
  if (fallback > 0) {
    drafts.push({
      category: "indexing",
      impact: 12,
      title: "Your firewall refuses unverified Googlebot requests",
      summary: `${pages(fallback, "URL")} refused a request identifying as Googlebot but loaded for a browser, so they were checked using the browser response. Real Googlebot is verified by reverse DNS and normally passes this kind of rule.`,
      evidence: { fallbackUrls: fallback, examples: examples.botFallback ?? [] },
      recommendation: "No action needed if URL Inspection in Search Console shows Google can fetch these pages.",
      pagesAffected: exampleUrls("botFallback"),
    });
  }

  const createdAt = new Date().toISOString();
  const softNotFound = issues.softNotFound ?? 0;
  if (softNotFound > 0) {
    drafts.push({
      category: "indexing",
      impact: Math.min(organicImpactScore({ category: "indexing", pagesAffected: softNotFound }), 60),
      title: "Pages that say not found but answer 200",
      summary: `${pages(softNotFound)} answer 200 but say they are missing${coverage.notFoundTitle ? `, or carry the title the site gives a page that doesn't exist (“${coverage.notFoundTitle}”)` : ""}. Google calls these soft 404s: it crawls them, indexes nothing, and comes back.`,
      evidence: { softNotFoundUrls: softNotFound, notFoundTitle: coverage.notFoundTitle ?? null, examples: examples.softNotFound ?? [] },
      recommendation: "Return 404 or 410 for pages that are gone (or redirect to the page that replaced them), and take them out of the sitemap, so Google stops spending crawls on them.",
      pagesAffected: exampleUrls("softNotFound"),
    });
  }

  const nearDuplicates = issues.nearDuplicate ?? 0;
  if (nearDuplicates > 0) {
    const groups = coverage.nearDuplicateGroups ?? [];
    const suffixed = groups.filter((group) => group.suffixed).length;
    drafts.push({
      category: "content",
      impact: Math.min(organicImpactScore({ category: "content", pagesAffected: nearDuplicates }), 55),
      title: "Pages that are the same page twice",
      summary: `${coverage.nearDuplicateTruncated ? "At least " : ""}${pages(nearDuplicates)} are near-duplicates of another indexable page: the same title and nearly the same text${suffixed ? `; ${count(suffixed)} ${suffixed === 1 ? "pair differs" : "pairs differ"} only by a code at the end of the address — the same record listed twice` : ""}. Google picks one and ignores the rest, not always the one you'd choose.`,
      evidence: { nearDuplicateUrls: nearDuplicates, suffixedGroups: suffixed, groups },
      recommendation: "Keep one page per record: merge the duplicates in the data, or give the copies a canonical pointing at the page to keep.",
      pagesAffected: groups.flatMap((group) => group.urls).slice(0, 20),
    });
  }

  // The same problem split by language version, when the crawl has more than one.
  if ((coverage.locales?.length ?? 0) > 1) {
    const split: Record<string, keyof CrawlLocaleStats> = {
      "Sitemap lists pages that are marked noindex": "noindex", "Sitemap lists URLs that redirect": "redirected", "Googlebot receives empty or thin HTML on sitemap URLs": "emptyShells",
      "Missing or very short meta descriptions": "missingDescription", "Detail pages have no structured data": "missingStructuredData", "Pages that say not found but answer 200": "softNotFound",
    };
    for (const draft of drafts) {
      const key = split[draft.title];
      if (!key) continue;
      const byLocale = Object.fromEntries(coverage.locales!.filter((entry) => Number(entry[key]) > 0).map((entry) => [entry.locale, Number(entry[key])]));
      if (!Object.keys(byLocale).length) continue;
      draft.summary = `${draft.summary.replace(/\s+$/, "")} By language: ${Object.entries(byLocale).map(([locale, n]) => `${count(n)} ${locale === "default" ? "without a prefix" : `under /${locale}/`}`).join(", ")}.`;
      draft.evidence = { ...draft.evidence, byLocale };
    }
  }

  return drafts.map((draft) => ({
    id: createId("finding"),
    siteId: input.siteId,
    analysisId: input.analysisId,
    category: draft.category,
    severity: severityFromImpact(draft.impact),
    title: draft.title,
    summary: draft.summary,
    evidence: draft.evidence,
    organicImpactScore: draft.impact,
    recommendation: draft.recommendation,
    pagesAffected: draft.pagesAffected ?? [],
    createdAt,
  }));
}
