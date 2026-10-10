import {
  createId, dropFromPeak, googlebotPace, latestAverage, peakAverage, referringDomainGap, serpCrowding, serpLookup, severityFromImpact,
  type CompetitorSuggestion, type CrawlDayRow, type CrawlLogView, type DayPoint, type Finding, type FindingCategory, type JsonObject, type LinksInput, type Opportunity, type SerpResult,
} from "@organic-growth/core";
import type { SearchConsoleReconciliation } from "@organic-growth/db";
import type { Inventory } from "@organic-growth/pages";

/*
 * What the connectors beyond Google add to an analysis: findings from the
 * site's crawl log, a link-gap opportunity, the results pages behind the
 * searches the plan names, and competitors the site hasn't listed.
 */

/** Sitemap URLs per page type that Googlebot did or didn't request in the logs' window. */
export type LogCoverage = {
  /** Days of logs the window covers (at most 30). */
  days: number;
  families: Array<{ family: string; sitemapUrls: number; unrequested: number; examples: string[] }>;
  view: CrawlLogView;
};

/** An imported Search Console Page-indexing export, reconciled with today (see `searchConsoleReconciliation`). */
export type SearchConsoleSignal = Pick<SearchConsoleReconciliation, "importedAt" | "summary" | "counts" | "reasons" | "suggestions" | "remainingChecks">;

/** The daily series the trend findings read (see `loadTrendSignals`). */
export type TrendSignals = {
  impressions: DayPoint[];
  indexed: DayPoint[];
  indexedSource: "search_console" | "inspection" | null;
  /** With the inspection sample: how many of Eumon's pages Google left out, to tell a fall Google caused from pages the user unpublished. */
  notIndexed: DayPoint[];
  crawlLog: CrawlDayRow[];
  today: string;
};

export type ConnectorSignals = {
  serp?: SerpResult[];
  suggestions?: CompetitorSuggestion[];
  links?: LinksInput;
  logCoverage?: LogCoverage | null;
  searchConsole?: SearchConsoleSignal | null;
  trends?: TrendSignals | null;
  inventory?: InventorySignal[];
};

/** Fewer days of logs than this say nothing about what Googlebot skips. */
const MIN_LOG_DAYS = 14;

type Draft = { category: FindingCategory; impact: number; title: string; summary: string; evidence: JsonObject; recommendation: string; pagesAffected?: string[] };

const share = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

/**
 * From the site's own logs: page types whose sitemap URLs Googlebot hasn't
 * requested in the window (it can't index what it doesn't fetch), and crawl
 * requests spent on redirects, errors and query-string URLs.
 */
export function findingsFromCrawlLog(input: { siteId: string; analysisId: string; coverage: LogCoverage }): Finding[] {
  const { coverage } = input;
  const drafts: Draft[] = [];
  if (coverage.days >= MIN_LOG_DAYS) {
    for (const family of coverage.families) {
      if (family.sitemapUrls < 20 || family.unrequested < 10) continue;
      const ratio = family.unrequested / family.sitemapUrls;
      if (ratio < 0.3) continue;
      // Impact grows with the share skipped and with how many pages that is.
      const impact = Math.min(85, Math.round(30 + ratio * 35 + Math.min(20, family.unrequested / 200)));
      drafts.push({
        category: "indexing", impact,
        title: `Googlebot hasn't requested ${share(family.unrequested, family.sitemapUrls)} of the /${family.family}/ pages in ${coverage.days} days`,
        summary: `Your logs show no Googlebot request for ${family.unrequested.toLocaleString("en")} of the ${family.sitemapUrls.toLocaleString("en")} /${family.family}/ URLs in the sitemap over the last ${coverage.days} days. A page Google doesn't fetch can't be indexed or refreshed.`,
        evidence: { family: family.family, sitemapUrls: family.sitemapUrls, unrequested: family.unrequested, days: coverage.days, examples: family.examples },
        recommendation: "Link these pages from pages Googlebot already visits often (hubs, related pages, the homepage), make sure each is in the sitemap with an accurate lastmod, and check Search Console's crawl stats for server slowness.",
        pagesAffected: family.examples,
      });
    }
  }
  const { statuses, totals, parameterHits } = coverage.view;
  const wasted = statuses.redirects + statuses.clientErrors + statuses.serverErrors;
  if (totals.googlebot >= 200 && wasted / totals.googlebot >= 0.2) {
    drafts.push({
      category: "indexing", impact: statuses.serverErrors / totals.googlebot >= 0.05 ? 60 : 42,
      title: `${share(wasted, totals.googlebot)} of Googlebot's requests hit redirects or errors`,
      summary: `Of ${totals.googlebot.toLocaleString("en")} Googlebot requests in 28 days, ${statuses.redirects.toLocaleString("en")} were redirected, ${statuses.clientErrors.toLocaleString("en")} got a 4xx and ${statuses.serverErrors.toLocaleString("en")} a 5xx. Each one is a request not spent on a page you want indexed${statuses.serverErrors ? "; server errors also make Google crawl more slowly" : ""}.`,
      evidence: { googlebot: totals.googlebot, redirects: statuses.redirects, clientErrors: statuses.clientErrors, serverErrors: statuses.serverErrors },
      recommendation: "Point internal links and the sitemap at final URLs, fix or remove links to missing pages, and find the server errors in the same logs.",
    });
  }
  if (totals.googlebot >= 200 && parameterHits / totals.googlebot >= 0.25) {
    drafts.push({
      category: "indexing", impact: 30,
      title: `${share(parameterHits, totals.googlebot)} of Googlebot's requests are for URLs with query strings`,
      summary: `${parameterHits.toLocaleString("en")} of ${totals.googlebot.toLocaleString("en")} Googlebot requests in 28 days asked for URLs with a query string (filters, sorting, tracking). They usually duplicate other pages.`,
      evidence: { googlebot: totals.googlebot, parameterHits },
      recommendation: "Keep parameter URLs out of internal links where possible, give them canonical tags to the clean URL, and block crawl-trap parameters (sorting, session IDs) in robots.txt.",
    });
  }
  const createdAt = new Date().toISOString();
  return drafts.map((draft) => ({
    id: createId("finding"), siteId: input.siteId, analysisId: input.analysisId, category: draft.category, severity: severityFromImpact(draft.impact),
    title: draft.title, summary: draft.summary, evidence: draft.evidence, organicImpactScore: draft.impact, recommendation: draft.recommendation,
    pagesAffected: draft.pagesAffected ?? [], createdAt,
  }));
}

/** One opportunity for the whole link gap: the sites that already link to competitors are the likeliest to link to the site. */
export function linkGapOpportunity(links: LinksInput | undefined, siteId: string, analysisId: string): Opportunity | null {
  const rows = links?.gap?.rows ?? [];
  if (rows.length < 5) return null;
  const trailing = referringDomainGap(links!);
  const strongest = [...rows].sort((a, b) => b.rank - a.rank).slice(0, 3).map((row) => row.domain);
  const weight = trailing ? 1.5 : 1;
  return {
    id: createId("opp"), siteId, analysisId,
    title: `Earn links from the ${rows.length.toLocaleString("en")} sites that link to your competitors but not to you`,
    searchDemand: 0, estimatedDifficulty: 50, intent: "link_gap", competitorStrength: trailing?.theirs ?? 0,
    businessValue: weight, conversionPotential: 0, technicalEffort: 0, contentEffort: 3,
    priorityScore: Number((8 * Math.log10(rows.length + 1) * weight).toFixed(2)),
    rationale: `${trailing ? `${trailing.leader} has ${trailing.theirs.toLocaleString("en")} referring domains to your ${trailing.yours.toLocaleString("en")}. ` : ""}${rows.length.toLocaleString("en")} sites link to ${rows[0]!.linksTo.length > 1 ? "every competitor checked" : rows[0]!.linksTo[0]} and not to you, the strongest being ${strongest.join(", ")} (DataForSEO).`,
  };
}

/** Adds what Google's page for a named search holds to the opportunities about it: crowding above the links, and whether an AI Overview already cites the site. */
export function withSerpContext(opportunities: Opportunity[], rows: SerpResult[] | undefined): Opportunity[] {
  if (!rows?.length) return opportunities;
  const lookup = serpLookup([{ rows }]);
  return opportunities.map((opportunity) => {
    const query = /“(.+?)”/.exec(opportunity.title)?.[1];
    const result = query ? lookup(query) : null;
    if (!result) return opportunity;
    const crowding = serpCrowding(result);
    const leaders = result.organic.slice(0, 3).map((entry) => entry.domain).join(", ");
    const notes = [
      crowding ? `Google's page for it shows ${crowding} above the links` : null,
      result.cited ? "an AI Overview already cites you" : result.features.includes("ai_overview") ? "the AI Overview cites other sites, so answering the question directly matters" : null,
      leaders ? `the top three are ${leaders}` : null,
    ].filter(Boolean);
    return notes.length ? { ...opportunity, rationale: `${opportunity.rationale} ${notes.join("; ").replace(/^./, (first) => first.toUpperCase())} (checked ${result.checkedAt}).` } : opportunity;
  });
}

const n = (value: number) => value.toLocaleString("en");

/**
 * From an imported Search Console export: a low indexed share of what Google
 * knows, noindex'd URLs that are indexable today (Google won't revisit unasked),
 * and old URLs still crawled that are gone, with the live pages they match.
 */
export function findingsFromSearchConsoleImport(input: { siteId: string; analysisId: string; view: SearchConsoleSignal | null }): Finding[] {
  const { view } = input;
  if (!view) return [];
  const drafts: Draft[] = [];
  // The chart carries Google's indexed count; the overview table lists only the not-indexed reasons unless an Indexed row was included.
  const tableIndexed = view.summary?.rows.find((row) => row.reason === "indexed")?.pages ?? null;
  const indexed = view.counts?.indexed ?? tableIndexed;
  const known = view.counts ? view.counts.indexed + view.counts.notIndexed : tableIndexed !== null && view.summary ? view.summary.rows.reduce((total, row) => total + row.pages, 0) : 0;
  if (indexed !== null && known >= 100 && indexed / known < 0.5) {
    const rest = (view.summary?.rows ?? []).filter((row) => row.reason !== "indexed").sort((a, b) => b.pages - a.pages);
    drafts.push({
      category: "indexing", impact: Math.min(90, 55 + Math.round((0.5 - indexed / known) * 70)),
      title: `Google has indexed ${n(indexed)} of the ${n(known)} URLs it knows (${Math.round((indexed / known) * 100)}%)`,
      summary: `Search Console's Page indexing report counts ${n(known)} URLs on this site and ${n(indexed)} indexed.${rest.length ? ` The rest sit under ${rest.slice(0, 3).map((row) => `${row.reasonText} (${n(row.pages)})`).join(", ")}${rest.length > 3 ? " and more" : ""}.` : ""}`,
      evidence: { known, indexed, reasons: rest.map((row) => ({ reason: row.reasonText, pages: row.pages })) },
      recommendation: "Give Google fewer, better URLs: keep only pages with real content in the sitemap, noindex or drop thin ones, and watch the crawl log for which page types Googlebot actually requests. Index coverage follows crawl budget.",
    });
  }
  const noindex = view.reasons.find((entry) => entry.reason === "noindex");
  if (noindex && noindex.today.indexable >= 10) {
    const also = [noindex.today.noindex && `${n(noindex.today.noindex)} are still noindex`, noindex.today.redirect && `${n(noindex.today.redirect)} redirect`, noindex.today.gone && `${n(noindex.today.gone)} are gone`].filter(Boolean);
    drafts.push({
      category: "indexing", impact: Math.min(80, 40 + Math.round(Math.log10(noindex.today.indexable + 1) * 12)),
      title: `${n(noindex.today.indexable)} URLs Google excluded as noindex are indexable now`,
      summary: `Google crawled ${n(noindex.urls)} URLs it found marked noindex; today ${n(noindex.today.indexable)} of them serve an indexable page${also.length ? `, ${also.join(", ")}` : ""}. Google only revisits when told.`,
      evidence: { urls: noindex.urls, today: noindex.today, examples: noindex.examples.indexable ?? [] },
      recommendation: "In Search Console's Page indexing report open \"Excluded by 'noindex' tag\" and click Validate fix, then resubmit the sitemap. Eumon sends changed pages to IndexNow for Bing.",
      pagesAffected: noindex.examples.indexable,
    });
  }
  const gone = view.reasons.reduce((total, entry) => total + entry.today.gone, 0);
  if (gone >= 5) {
    const matched = view.suggestions.length;
    const named = [...new Set([...view.suggestions.map((entry) => entry.url), ...view.reasons.flatMap((entry) => entry.examples.gone ?? [])])];
    drafts.push({
      category: "indexing", impact: Math.min(70, 30 + Math.round(Math.log10(gone + 1) * 12)),
      title: `${n(gone)} old URLs Google still crawls return 404; ${n(matched)} match a live page`,
      summary: `Across the imported reasons, ${n(gone)} URLs Google remembers now return 404 or 410. ${matched ? `${n(matched)} of them share their words with a live page of the same type, so the redirect is obvious.` : "None matches a live page by name."}`,
      evidence: { gone, matched, suggestions: view.suggestions.slice(0, 25), examples: named.slice(0, 10) },
      recommendation: "Redirect each old URL (301) to the suggested page, and the rest to the closest list page: every redirect saves Googlebot a wasted fetch and keeps the old URL's links.",
      pagesAffected: named,
    });
  }
  return toFindings(drafts, input);
}

const toFindings = (drafts: Draft[], input: { siteId: string; analysisId: string }): Finding[] => {
  const createdAt = new Date().toISOString();
  return drafts.map((draft) => ({
    id: createId("finding"), siteId: input.siteId, analysisId: input.analysisId, category: draft.category, severity: severityFromImpact(draft.impact),
    title: draft.title, summary: draft.summary, evidence: draft.evidence, organicImpactScore: draft.impact, recommendation: draft.recommendation, pagesAffected: draft.pagesAffected, createdAt,
  }));
};

/** Thresholds for the trend findings, with their reasons. */
const TREND = {
  /** A week smooths weekday and weekend. */
  window: 7,
  /** Under 100 impressions a day, a week's swing is noise. */
  peakLevel: 100,
  /** A current week at 60% of the peak week or less is a fall worth a finding. */
  fallTo: 0.6,
  /** The indexed count must be 10% and 50 pages under its 90-day maximum. */
  indexedShare: 0.1, indexedCount: 50,
  /** Googlebot needing more than two months for one pass of a 200+ URL sitemap means pages wait. */
  paceDays: 60, minSitemap: 200,
};
const DAY_MS = 86_400_000;
const shortDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * From the ledger and the crawl log: impressions that fell from a peak (and
 * the indexed-count fall that happened with them), an indexed count that
 * fell, and a Googlebot pace that can't get round the sitemap.
 */
export function findingsFromTrends(input: { siteId: string; analysisId: string; trends: TrendSignals | null; sitemapUrls: number | null; discovered: number | null }): Finding[] {
  const { trends } = input;
  if (!trends) return [];
  const drafts: Draft[] = [];
  let indexedFall = dropFromPeak(trends.indexed, TREND.indexedShare, TREND.indexedCount);
  if (indexedFall && trends.indexedSource === "inspection") {
    // The sample counts published Eumon pages: unpublishing lowers it with no change at Google. A fall Google caused shows up as pages it left out.
    const leftOut = (day: string) => trends.notIndexed.filter((point) => point.day <= day).at(-1)?.value ?? 0;
    if (leftOut(indexedFall.latestDay) - leftOut(indexedFall.peakDay) < (indexedFall.peak - indexedFall.latest) / 2) indexedFall = null;
  }
  const peak = peakAverage(trends.impressions, TREND.window, TREND.peakLevel);
  const current = latestAverage(trends.impressions, TREND.window);
  if (peak && current && current.average <= peak.average * TREND.fallTo) {
    const share = Math.round((1 - current.average / peak.average) * 100);
    const together = indexedFall && Math.abs(Date.parse(indexedFall.peakDay) - Date.parse(peak.to)) <= 7 * DAY_MS ? indexedFall : null;
    drafts.push({
      category: "search", impact: Math.min(90, 50 + Math.round(share * 0.4)),
      title: `Search impressions fell ${share}% since ${shortDay(peak.to)}`,
      summary: `Search Console impressions averaged ${n(Math.round(peak.average))} a day in the week to ${shortDay(peak.to)} and ${n(Math.round(current.average))} a day in the week to ${shortDay(current.to)}.${together ? ` That is when Google's indexed count fell from ${n(together.peak)} to ${n(together.latest)}.` : ""}`,
      evidence: { peak, current, indexedFall },
      recommendation: "Open Search Console's Page indexing report (or import it in Setup) and look at what changed on the site in the days before the fall: a sitemap, a redirect rule, a noindex. History records the day this number recovers.",
    });
  }
  if (indexedFall) {
    drafts.push({
      category: "indexing", impact: Math.min(85, 45 + Math.round(indexedFall.share * 100)),
      title: `Google's indexed count fell from ${indexedFall.peak} to ${indexedFall.latest} since ${shortDay(indexedFall.peakDay)}`,
      summary: `${trends.indexedSource === "search_console" ? "Search Console's Page indexing chart" : "Eumon's URL inspection sample"} had ${n(indexedFall.peak)} pages indexed on ${shortDay(indexedFall.peakDay)} and ${n(indexedFall.latest)} on ${shortDay(indexedFall.latestDay)}: ${Math.round(indexedFall.share * 100)}% fewer.`,
      evidence: { ...indexedFall, source: trends.indexedSource },
      recommendation: "The Search Console import names the reasons Google gives for each page it dropped; the crawl's noindex, redirect and error counts say which of them the site caused.",
    });
  }
  const pace = googlebotPace(trends.crawlLog, trends.today);
  if (pace && input.sitemapUrls && input.sitemapUrls >= TREND.minSitemap) {
    const days = Math.ceil(input.sitemapUrls / pace.perDay);
    if (days > TREND.paceDays) {
      drafts.push({
        category: "indexing", impact: Math.min(80, 40 + Math.min(40, Math.round(days / 10))),
        title: `At Googlebot's pace the sitemap takes ${days} days to crawl once`,
        summary: `Googlebot made about ${n(Math.round(pace.perDay))} requests a day over the last ${pace.days} days of logs, and the sitemap lists ${n(input.sitemapUrls)} URLs.${input.discovered ? ` Search Console lists ${n(input.discovered)} of them as discovered but not yet crawled.` : ""}`,
        evidence: { perDay: pace.perDay, logDays: pace.days, sitemapUrls: input.sitemapUrls, discovered: input.discovered },
        recommendation: "Give Googlebot fewer URLs and better paths: keep only pages with real content in the sitemap, link the important ones from pages it already visits, and read the crawl-log card for where its requests go.",
      });
    }
  }
  return toFindings(drafts, input);
}

/** A dataset's inventory (`loadInventories`), as the findings read it. */
export type InventorySignal = { dataset: { id: string; name: string; entityType: string; records: number }; inventory: Inventory };

/** Datasets with fewer records say little; a field, a duplicate group or a thin-page count below these is noise. */
const INVENTORY = { minRecords: 50, minMissing: 50, plainFillBelow: 0.5, minDuplicateRecords: 4, minThin: 10, minThinShare: 0.05, thinChars: 250 };

/** "Doctors" as the dataset is named; failing a plural name, the entity type with an s (or ies). */
const plural = (name: string, entity: string) => (/s$/i.test(name.trim()) ? name.trim().toLowerCase() : /y$/i.test(entity) ? `${entity.slice(0, -1)}ies` : `${entity}s`);
/** Rounded, but a field with records missing is never "100%": 99.9% filled and 50 short reads 99%. */
const filledShare = (filled: number, whole: number) => `${Math.min(Math.round((filled / whole) * 100), filled < whole ? 99 : 100)}%`;

/**
 * What the client's own data says about the site's content: a field most
 * records lack (by language where fields come in language variants), records
 * listed more than once, and record pages with almost nothing on them.
 */
export function findingsFromInventory(input: { siteId: string; analysisId: string; inventories: InventorySignal[] }): Finding[] {
  const drafts: Draft[] = [];
  for (const { dataset, inventory } of input.inventories) {
    if (inventory.records < INVENTORY.minRecords) continue;
    const entities = plural(dataset.name, dataset.entityType);
    const records = inventory.records;
    // One field finding per dataset: the language variant most records lack, else the emptiest plain field under half filled.
    const variants = inventory.languages.flatMap((group) => group.variants.map((variant) => ({ ...variant, base: group.base, missing: records - variant.filled })))
      .filter((variant) => variant.missing >= INVENTORY.minMissing).sort((a, b) => a.share - b.share);
    const plain = inventory.fields.filter((field) => !field.language && field.share < INVENTORY.plainFillBelow && records - field.filled >= INVENTORY.minMissing).sort((a, b) => a.share - b.share);
    const gap = variants[0] ? { label: `${variants[0].base} (${variants[0].language})`, filled: variants[0].filled, language: variants[0].language } : plain[0] ? { label: plain[0].label, filled: plain[0].filled } : null;
    if (gap) {
      const missing = records - gap.filled;
      drafts.push({
        category: "content", impact: Math.min(75, 40 + Math.round((missing / records) * 60)),
        title: `${n(missing)} of ${n(records)} ${entities} have no ${gap.label}`,
        summary: `${filledShare(gap.filled, records)} of the ${n(records)} ${entities} in ${dataset.name} have ${gap.label} filled; ${n(missing)} don't. A page built from one of those records has nothing to say${gap.language ? ` in ${gap.language}` : ""}, so it is thin${gap.language ? ` in ${gap.language} search results` : ""} or left out.`,
        evidence: { dataset: dataset.id, field: gap.label, records, filled: gap.filled, missing },
        recommendation: `Fill the ${gap.label} in the source data; the pages follow the records. Until then leave those pages out of the sitemap${gap.language ? ` for ${gap.language}` : ""}, or give them a noindex, so Google spends its visits on pages with content.`,
      });
    }
    const duplicates = inventory.duplicates;
    if (duplicates.records >= INVENTORY.minDuplicateRecords) {
      drafts.push({
        category: "content", impact: Math.min(70, 35 + Math.round(Math.log10(duplicates.records + 1) * 10)),
        title: `${n(duplicates.records)} ${entities} are listed more than once`,
        summary: `${n(duplicates.groups)} name${duplicates.groups === 1 ? "" : "s"} in ${dataset.name} appear${duplicates.groups === 1 ? "s" : ""} on more than one record${duplicates.examples[0] ? ` (${duplicates.examples.slice(0, 3).map((group) => `${group.name} ×${group.keys.length}`).join(", ")})` : ""}. Those records may be the same ${dataset.entityType} listed twice, each with its own page saying the same thing: Google keeps one and the clicks split.`,
        evidence: { dataset: dataset.id, groups: duplicates.groups, records: duplicates.records, examples: duplicates.examples },
        recommendation: "Review the groups in the Data section: two people can share a name. Merge duplicates there applies the merges it finds (it deletes the extra records), so check before running it, then redirect each dropped page to the one kept.",
      });
    }
    const pages = inventory.pages;
    if (pages && pages.thin >= INVENTORY.minThin && pages.thin >= pages.linked * INVENTORY.minThinShare) {
      drafts.push({
        category: "content", impact: Math.min(80, 40 + Math.round((pages.thin / pages.linked) * 60)),
        title: `${n(pages.thin)} ${dataset.entityType} pages have almost no content`,
        summary: `Of the ${n(pages.linked)} ${dataset.entityType} pages the records point to, ${n(pages.thin)} answered with an empty shell or under ${INVENTORY.thinChars} characters of text in the crawl${pages.gone ? `, ${n(pages.gone)} answer 404 or 410` : ""}${pages.unreached ? `, and ${n(pages.unreached)} were not reached` : ""}. Google indexes few thin pages and ranks fewer.`,
        evidence: { dataset: dataset.id, linked: pages.linked, thin: pages.thin, gone: pages.gone, unreached: pages.unreached, examples: pages.examples },
        recommendation: "Fill the record so the page has something to say, or leave the page out of the sitemap until it does.",
        pagesAffected: pages.examples.thin,
      });
    }
  }
  const createdAt = new Date().toISOString();
  return drafts.map((draft) => ({
    id: createId("finding"), siteId: input.siteId, analysisId: input.analysisId, category: draft.category, severity: severityFromImpact(draft.impact),
    title: draft.title, summary: draft.summary, evidence: draft.evidence, organicImpactScore: draft.impact, recommendation: draft.recommendation,
    pagesAffected: draft.pagesAffected ?? [], createdAt,
  }));
}
