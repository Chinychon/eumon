import {
  createId, referringDomainGap, serpCrowding, serpLookup, severityFromImpact,
  type CompetitorSuggestion, type CrawlLogView, type Finding, type FindingCategory, type JsonObject, type LinksInput, type Opportunity, type SerpResult,
} from "@organic-growth/core";

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

export type ConnectorSignals = {
  serp?: SerpResult[];
  suggestions?: CompetitorSuggestion[];
  links?: LinksInput;
  logCoverage?: LogCoverage | null;
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
