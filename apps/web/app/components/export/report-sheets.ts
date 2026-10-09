import type { Report } from "../report-model";
import { familyLabel, urlPath } from "../report-model.ts";
import type { Leads, Payload } from "../site-data";
import type { Cell, Sheet } from "./workbook";

/*
 * Each card's data as tables, in the units the card shows (counts, shares as
 * fractions, positions to one decimal). One builder per card; a tab's export
 * is its cards' tables together. No React here, so it runs under `node --test`.
 */

type Results = Payload["results"];
const path = urlPath;
const sheet = (name: string, columns: string[], rows: Cell[][]): Sheet => ({ name, columns, rows });
const round = (value: number | null | undefined, digits = 1) => (value === null || value === undefined ? null : Number(value.toFixed(digits)));

/** The named tables from a builder, for a card that shows only some of them. */
export const pick = (sheets: Sheet[], ...names: string[]) => sheets.filter((entry) => names.includes(entry.name));

/* Overview */

export function proofSheets(results: Results): Sheet[] {
  const numbers = results.numbers;
  const compare = (label: string, value: { current: number | null; before: number | null; previous: number | null } | null): Cell[] =>
    [label, value?.current ?? null, value?.before ?? null, value?.previous ?? null];
  return [
    sheet("Google clicks per week", ["Week starting", "Whole site", "Eumon pages", "Partial week"],
      results.headline.map((week) => [week.week, week.site, week.eumon, week.partial ? "yes" : ""])),
    sheet("Key numbers", ["Metric (28 days)", "Now", "Before Eumon", "28 days before"], [
      compare("Google clicks", numbers.clicks),
      compare("Enquiries", numbers.leads),
      compare("Organic sessions", numbers.organicSessions),
      ["Pages live", numbers.pages.live, null, null],
      ["Pages indexed", numbers.pages.indexed, null, null],
    ]),
  ];
}

export function pageTypeSheets(report: Report | null): Sheet[] {
  const families = report?.coverage?.families ?? [];
  return [sheet("Where pages break", ["Page type", "URLs", "Crawled", "Empty HTML", "Errors", "Noindex", "No structured data"],
    families.map((family) => [familyLabel(family.family), family.urls, family.crawled, family.emptyShells, family.errors, family.noindex, family.missingStructuredData]))];
}

/** The growth plan's searches to push: queries near page one and snippets to rewrite. */
export function pushSheets(opportunities: Report["opportunities"]): Sheet[] {
  return [sheet("Queries to push", ["Opportunity", "Priority", "Why", "Page"], opportunities.map((entry) => [entry.title, round(entry.priorityScore), entry.rationale, entry.potentialPage ?? null]))];
}

export function backlogSheets(report: Report | null): Sheet[] {
  const opportunities = [...(report?.opportunities ?? [])].sort((a, b) => b.priorityScore - a.priorityScore);
  return [sheet("Growth plan", ["Rank", "Opportunity", "Priority", "Kind", "Why"],
    opportunities.map((entry, index) => [index + 1, entry.title, round(entry.priorityScore), entry.intent ?? null, entry.rationale]))];
}

/* Technical */

export function renderingSheets(report: Report | null): Sheet[] {
  return [sheet("Text before and after JavaScript", ["Page type", "URL", "Text in the HTML", "Text after JavaScript", "Verdict"],
    (report?.rendering?.comparisons ?? []).map((entry) => [familyLabel(entry.family), entry.url, entry.rawTextLength, entry.renderedTextLength, entry.verdict]))];
}

export function speedSheets(results: Results): Sheet[] {
  return [
    sheet("Speed (Chrome users, p75)", ["Metric", "Phones", "Phones rating", "Desktops", "Desktops rating"],
      results.speed.metrics.map((entry) => [entry.metric.toUpperCase(), entry.phone.p75, entry.phone.rating, entry.desktop.p75, entry.desktop.rating])),
    sheet("Lighthouse", ["Form factor", "Homepage", "Eumon page"],
      (["phone", "desktop"] as const).map((form) => [form, results.lab[form].home, results.lab[form].eumon])),
  ];
}

export function fixSheets(report: Report | null, category?: (category: string) => boolean): Sheet[] {
  const findings = (report?.findings ?? []).filter((finding) => !category || category(finding.category)).sort((a, b) => b.organicImpactScore - a.organicImpactScore);
  return [sheet("Findings", ["Severity", "Finding", "Category", "Impact", "Summary", "Next step"],
    findings.map((finding) => [finding.severity, finding.title, finding.category, finding.organicImpactScore, finding.summary, finding.recommendation ?? null]))];
}

export function routeSheets(repo: Report["repo"] | undefined): Sheet[] {
  return [sheet("Routes", ["Route", "Source", "Renders", "Content data in the browser", "Title and meta", "Sequential requests", "Unpaginated queries"],
    (repo?.routeInspections ?? []).map((route) => [route.pathPattern, route.source, route.rendering, route.clientDataFetching ? "yes" : "", route.metadata, route.sequentialAwaits, route.unboundedQueries.join("; ")]))];
}

/* Search */

export function googleSearchSheets(results: Results): Sheet[] {
  const search = results.search;
  if (!search) return [];
  return [
    sheet("Search per week", ["Week starting", "Clicks", "Impressions", "Partial week"], search.weeks.map((week) => [week.week, week.clicks, week.impressions, week.partial ? "yes" : ""])),
    sheet("Queries by position", ["Position", "Queries", "New", "Lost"], search.buckets.map((bucket) => [`Top ${bucket.top}`, bucket.queries, bucket.added, bucket.lost])),
    sheet("Top queries", ["Query", "Clicks", "Impressions", "CTR", "Position", "Clicks before", "Impressions before", "Position before"],
      (search.topQueries?.rows ?? []).map((row) => [row.query, row.clicks, row.impressions, row.impressions ? round(row.clicks / row.impressions, 4) : null, round(row.position),
        row.before?.clicks ?? null, row.before?.impressions ?? null, round(row.before?.position)])),
    ...(results.organic ? [sheet("Organic sessions per week", ["Week starting", "Organic sessions", "GA4 key events", "Partial week"],
      results.organic.map((week) => [week.week, week.sessions, week.keyEvents, week.partial ? "yes" : ""]))] : []),
  ];
}

export function searchAnalysisSheets(report: Report | null): Sheet[] {
  const search = report?.search;
  if (!search) return [];
  return [
    sheet("Near page one", ["Query", "Page", "Position", "Impressions", "Clicks"], search.strikingDistance.map((entry) => [entry.query, path(entry.page), round(entry.position), entry.impressions, entry.clicks])),
    sheet("Skipped on page one", ["Page", "Position", "Impressions", "CTR", "Typical CTR", "Queries"],
      search.lowCtrPages.map((entry) => [path(entry.page), round(entry.position), entry.impressions, round(entry.ctr, 4), round(entry.expectedCtr, 4), entry.queries.join("; ")])),
    sheet("Competing pages", ["Query", "Impressions", "Pages"], search.cannibalized.map((entry) => [entry.query, entry.impressions, entry.pages.map((page) => `${path(page.page)} (#${page.position.toFixed(0)})`).join("; ")])),
    sheet("Where searchers are", ["Country", "Share of impressions"], search.countries.map((country) => [country.name, round(country.impressionShare, 4)])),
  ];
}

export function coverageSheets(coverage: { families: Array<{ family: string; total: number; checked: number; byClass: Record<string, number> }> } | null): Sheet[] {
  if (!coverage) return [];
  const classes = ["indexed", "crawled", "discovered", "unknown", "excluded"];
  return [sheet("Google crawl coverage", ["Page type", "URLs", "Checked", "Indexed", "Crawled, not indexed", "Discovered, not crawled", "Unknown to Google", "Excluded"],
    coverage.families.map((family) => [familyLabel(family.family), family.total, family.checked, ...classes.map((name) => family.byClass[name] ?? 0)]))];
}

/* Enquiries */

export function enquirySheets(results: Results): Sheet[] {
  return [
    sheet("Search to enquiry", ["Step", "Count"], (results.leads.funnel ?? []).map((step) => [step.label, step.value])),
    sheet("Enquiries per week", ["Week starting", "From Eumon pages", "Everything else", "Partial week"], results.leads.weeks.map((week) => [week.week, week.eumon, week.other, week.partial ? "yes" : ""])),
  ];
}

export function conversionSheets(report: Report | null, leads: Leads): Sheet[] {
  const conversion = report?.conversion;
  return [
    sheet("Conversion events", ["Metric", "Value"], [["Events in the last 28 days", leads?.events28 ?? null], ["Landing page views", leads?.views ?? null], ["CTA clicks", leads?.ctaClicks ?? null], ["Leads", leads?.conversions ?? null]]),
    sheet("How each template asks", ["Template", "URL", "Ways to convert", "Prices shown", "Tracking"],
      (conversion?.templates ?? []).map((template) => [familyLabel(template.family), template.url, template.paths.join("; "), template.prices ? "yes" : "no", template.tracking.join("; ")])),
    sheet("Events worth tracking", ["Event", "When it fires"], (conversion?.suggestedEvents ?? []).map((entry) => [entry.event, entry.trigger])),
  ];
}

/* Keywords and competitors */

export function keywordSheets(keywords: Results["keywords"], host: string): Sheet[] {
  return [
    sheet("Top keywords", ["Keyword", "Searches per month", "Difficulty", "Intent", "Position", "Clicks"],
      keywords.top.map((row) => [row.keyword, row.volume, row.difficulty, row.intent, round(row.position), row.clicks])),
    sheet("Keyword gaps", ["Keyword", "Searches per month", "Difficulty", "Intent", "Who ranks", "Their position", "Their page"],
      keywords.gaps.map((gap) => [gap.keyword, gap.volume, gap.difficulty, gap.intent, gap.domain, gap.position, `https://${gap.domain}${gap.url}`])),
    sheet("Share of visibility", ["Domain", "Estimated visits per month", "Share", "Keywords in the top 10"],
      keywords.visibility.map((row, index) => [index === 0 ? host : row.domain, row.traffic, round(row.share, 4), row.top10])),
  ];
}

export function competitorSheets(report: Report | null, results: Results | null, host: string): Sheet[] {
  const competition = report?.competition;
  const domains = competition?.competitors.filter((competitor) => competitor.analyzed).map((competitor) => competitor.domain) ?? [];
  return [
    sheet("Pages per section", ["Section", "Status", host, ...domains, "Your data"], (competition?.rows ?? []).map((row) => [
      row.label, row.status, row.you.pages, ...domains.map((domain) => row.competitors.find((entry) => entry.domain === domain)?.pages ?? 0),
      row.data ? `${row.data.dataset}: ${row.data.records} records, ${row.data.livePages} live` : null,
    ])),
    sheet("Competitors", ["Domain", "Overlap", "Summary"], (report?.competitors ?? []).map((competitor) => [competitor.domain, round(competitor.relevanceScore, 2), competitor.summary])),
    sheet("What stands out", ["Insight"], (competition?.insights ?? []).map((insight) => [insight])),
    ...(results ? [sheet("Authority", ["Domain", "Open PageRank (0–10)"], [[host, results.authority.site], ...results.authority.competitors.map((entry): Cell[] => [entry.domain, entry.score])])] : []),
  ];
}

/* AI visibility */

export function aiSheets(results: Results): Sheet[] {
  const ai = results.ai;
  if (!ai) return [];
  return [
    sheet("AI fetches by company", ["Company", "Crawls (28 days)", "Crawls (28 days before)", "Live fetches (28 days)", "Live fetches (28 days before)"],
      ai.engines.map((entry) => [entry.label, entry.crawler.current, entry.crawler.previous, entry.live.current, entry.live.previous])),
    sheet("AI fetches per week", ["Week starting", "Crawls", "Live fetches", "Partial week"], ai.weeks.map((week) => [week.week, week.crawler, week.live, week.partial ? "yes" : ""])),
    sheet("Visits from AI answers", ["Assistant", "To Eumon pages (28 days)", "To the whole site (28 days)"],
      ai.referrals.byAssistant.map((entry) => [entry.label, entry.visits, ai.ga4?.byAssistant.find((row) => row.assistant === entry.assistant)?.sessions ?? null])),
    sheet("Enquiries by source", ["Source", "Enquiries (28 days)"], ai.leadsBySource ? [["Search engines", ai.leadsBySource.search], ["AI assistants", ai.leadsBySource.ai], ["Other or unknown", ai.leadsBySource.other]] : []),
    sheet("Question searches", ["Metric", "Value"], ai.questions ? [["Question searches", ai.questions.queries], ["Their clicks", ai.questions.clicks], ["Their impressions", ai.questions.impressions], ["Window ends", ai.questions.day]] : []),
  ];
}

export function aiReadinessSheets(report: Report | null): Sheet[] {
  const readiness = report?.aiReadiness;
  if (!readiness) return [];
  return [sheet("AI agents in robots.txt", ["Agent", "What it does", "Kind", "robots.txt"],
    readiness.crawlers.map((crawler) => [crawler.agent, crawler.purpose, crawler.kind, crawler.allowed ? "allowed" : "blocked"]))];
}

/** Every table on a Dashboard tab, for "Export tab". Empty tables are left out. */
export function tabSheets(tab: string, input: { results: Results | null; report: Report | null; leads: Leads; host: string }): Sheet[] {
  const { results, report, leads, host } = input;
  const all: Sheet[] = (() => {
    switch (tab) {
      case "technical": return [...pageTypeSheets(report), ...renderingSheets(report), ...(results ? speedSheets(results) : []), ...fixSheets(report, (category) => !["search", "competitors", "conversion", "ai_visibility"].includes(category)), ...routeSheets(report?.repo)];
      case "search": return [...(results ? googleSearchSheets(results) : []), ...searchAnalysisSheets(report), ...fixSheets(report, (category) => category === "search")];
      case "enquiries": return [...(results ? enquirySheets(results) : []), ...conversionSheets(report, leads), ...fixSheets(report, (category) => category === "conversion")];
      case "keywords": return results ? keywordSheets(results.keywords, host) : [];
      case "competitors": return results ? competitorSheets(report, results, host) : [];
      case "ai": return [...(results ? aiSheets(results) : []), ...aiReadinessSheets(report), ...fixSheets(report, (category) => category === "ai_visibility")];
      default: return [...(results ? proofSheets(results) : []), ...pageTypeSheets(report), ...backlogSheets(report)];
    }
  })();
  return all.filter((entry) => entry.rows.length > 0);
}
