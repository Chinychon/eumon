import { countryName, createId, severityFromImpact, slugify, type Finding, type Opportunity, type SearchMetricRow } from "@organic-growth/core";
import { expectedCtr } from "@organic-growth/pages";

/** Query wording that usually signals purchase or booking intent, across common markets. */
export const COMMERCIAL_QUERY_PATTERN =
  /\b(cost|costs|price|prices|pricing|cheap|cheapest|affordable|quote|book|booking|appointment|buy|hire|near me|best|top|review|reviews|vs|compare|comparison|service|services|clinic|package|packages|biaya|harga|terbaik|murah|paket|kos|terdekat)\b/i;

type QueryPage = { query: string; page: string; clicks: number; impressions: number; position: number };

/** What first-party search data says about where traffic comes from and what to do next. */
export type SearchInsights = {
  totals: { clicks: number; impressions: number; ctr: number; queries: number; pages: number };
  countries: Array<{ country: string; name: string; clicks: number; impressions: number; impressionShare: number }>;
  targetMarkets: string[];
  /** Share of clicks and impressions from the target markets; null when none are set. */
  targetShare: { clicks: number; impressions: number } | null;
  brandedShare: number;
  /** Share of clicks from commercial-intent wording (cost, price, best, booking…). */
  commercialShare: number;
  /** Searches naming one specific record (a doctor's name, a product); null without collected data. */
  entityQueries: { share: number; byType: Array<{ entityType: string; clicks: number; examples: string[] }> } | null;
  /** Query × page pairs ranking 4–15: closest to page-one clicks. */
  strikingDistance: QueryPage[];
  /** Pages on page one whose click-through rate is under half what their position usually earns. */
  lowCtrPages: Array<{ page: string; clicks: number; impressions: number; ctr: number; expectedCtr: number; position: number; queries: string[] }>;
  /** Queries where several of the site's pages split impressions. */
  cannibalized: Array<{ query: string; impressions: number; pages: Array<{ page: string; position: number; impressions: number }> }>;
  /** Commercial queries ranking beyond page one. */
  commercialGaps: QueryPage[];
  narrative: string;
};

const pct = (value: number) => `${Math.round(value * 100)}%`;
const count = (value: number) => value.toLocaleString("en");

function aggregate(rows: SearchMetricRow[], key: (row: SearchMetricRow) => string) {
  const groups = new Map<string, { rows: SearchMetricRow[]; clicks: number; impressions: number; weighted: number }>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id) ?? { rows: [], clicks: 0, impressions: 0, weighted: 0 };
    group.rows.push(row);
    group.clicks += row.clicks;
    group.impressions += row.impressions;
    group.weighted += row.position * row.impressions;
    groups.set(id, group);
  }
  return groups;
}

/** Matches queries that contain a record's name (its slug), checking every run of up to five words. */
function entityMatcher(entityKeys: Array<{ key: string; entityType: string }>) {
  const keys = new Map(entityKeys.filter((entry) => entry.key.length >= 3).map((entry) => [entry.key, entry.entityType]));
  return (query: string): string | null => {
    const words = slugify(query).split("-").filter(Boolean);
    for (let size = Math.min(5, words.length); size >= 1; size--) {
      for (let start = 0; start + size <= words.length; start++) {
        const type = keys.get(words.slice(start, start + size).join("-"));
        if (type) return type;
      }
    }
    return null;
  };
}

/**
 * Analyzes Search Console rows (query × page × country × device) the way an
 * analyst would: market alignment, what kind of searches bring clicks, and
 * the pages closest to more clicks.
 */
export function analyzeSearch(rows: SearchMetricRow[], options: {
  brandTerms?: string[];
  targetMarkets?: string[];
  entityKeys?: Array<{ key: string; entityType: string }>;
} = {}): SearchInsights {
  const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
  const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  const byCountry = aggregate(rows, (row) => row.country.toLowerCase());
  const countries = [...byCountry.entries()]
    .map(([country, group]) => ({ country, name: countryName(country), clicks: group.clicks, impressions: group.impressions, impressionShare: group.impressions / Math.max(impressions, 1) }))
    .sort((a, b) => b.impressions - a.impressions);
  const targets = (options.targetMarkets ?? []).map((country) => country.toLowerCase());
  const targetRows = rows.filter((row) => targets.includes(row.country.toLowerCase()));
  const targetShare = targets.length
    ? { clicks: targetRows.reduce((sum, row) => sum + row.clicks, 0) / Math.max(clicks, 1), impressions: targetRows.reduce((sum, row) => sum + row.impressions, 0) / Math.max(impressions, 1) }
    : null;

  const brands = (options.brandTerms ?? []).map((term) => term.toLowerCase()).filter((term) => term.length >= 3);
  const isBranded = (query: string) => brands.some((brand) => query.toLowerCase().includes(brand));
  const brandedShare = rows.filter((row) => isBranded(row.query)).reduce((sum, row) => sum + row.clicks, 0) / Math.max(clicks, 1);
  const commercialShare = rows.filter((row) => COMMERCIAL_QUERY_PATTERN.test(row.query)).reduce((sum, row) => sum + row.clicks, 0) / Math.max(clicks, 1);

  let entityQueries: SearchInsights["entityQueries"] = null;
  if (options.entityKeys?.length) {
    const match = entityMatcher(options.entityKeys);
    const byType = new Map<string, { clicks: number; examples: Map<string, number> }>();
    for (const [query, group] of aggregate(rows, (row) => row.query)) {
      if (isBranded(query)) continue;
      const type = match(query);
      if (!type) continue;
      const entry = byType.get(type) ?? { clicks: 0, examples: new Map<string, number>() };
      entry.clicks += group.clicks;
      entry.examples.set(query, group.clicks);
      byType.set(type, entry);
    }
    const entityClicks = [...byType.values()].reduce((sum, entry) => sum + entry.clicks, 0);
    entityQueries = {
      share: entityClicks / Math.max(clicks, 1),
      byType: [...byType.entries()].map(([entityType, entry]) => ({
        entityType,
        clicks: entry.clicks,
        examples: [...entry.examples.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([query]) => query),
      })).sort((a, b) => b.clicks - a.clicks),
    };
  }

  const queryPages: QueryPage[] = [...aggregate(rows, (row) => `${row.query}\n${row.page}`).values()].map((group) => ({
    query: group.rows[0]!.query,
    page: group.rows[0]!.page,
    clicks: group.clicks,
    impressions: group.impressions,
    position: group.weighted / Math.max(group.impressions, 1),
  }));
  const ctrOf = (entry: { clicks: number; impressions: number }) => entry.clicks / Math.max(entry.impressions, 1);

  const strikingDistance = queryPages
    .filter((entry) => entry.position >= 4 && entry.position <= 15 && entry.impressions >= 30 && !isBranded(entry.query))
    .sort((a, b) => b.impressions * (expectedCtr(3) - ctrOf(b)) - a.impressions * (expectedCtr(3) - ctrOf(a)))
    .slice(0, 15);

  const lowCtrPages = [...aggregate(rows, (row) => row.page).values()]
    .map((group) => {
      const position = group.weighted / Math.max(group.impressions, 1);
      const queries = [...aggregate(group.rows, (row) => row.query).entries()].sort((a, b) => b[1].impressions - a[1].impressions).slice(0, 3).map(([query]) => query);
      return { page: group.rows[0]!.page, clicks: group.clicks, impressions: group.impressions, ctr: ctrOf(group), expectedCtr: expectedCtr(position), position, queries };
    })
    .filter((page) => page.impressions >= 200 && page.position <= 10 && page.ctr < page.expectedCtr * 0.5)
    .sort((a, b) => b.impressions * (b.expectedCtr - b.ctr) - a.impressions * (a.expectedCtr - a.ctr))
    .slice(0, 10);

  const cannibalized: SearchInsights["cannibalized"] = [];
  for (const [query, group] of aggregate(rows, (row) => row.query)) {
    if (group.impressions < 50 || isBranded(query)) continue;
    const pages = [...aggregate(group.rows, (row) => row.page).values()]
      .map((page) => ({ page: page.rows[0]!.page, impressions: page.impressions, position: page.weighted / Math.max(page.impressions, 1) }))
      .filter((page) => page.impressions >= 10 && page.position <= 30)
      .sort((a, b) => b.impressions - a.impressions);
    if (pages.length >= 2 && pages[0]!.impressions < group.impressions * 0.85) cannibalized.push({ query, impressions: group.impressions, pages: pages.slice(0, 4) });
  }
  cannibalized.sort((a, b) => b.impressions - a.impressions);

  const commercialGaps = queryPages
    .filter((entry) => COMMERCIAL_QUERY_PATTERN.test(entry.query) && entry.position > 10)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 25);

  const insights: SearchInsights = {
    totals: { clicks, impressions, ctr: clicks / Math.max(impressions, 1), queries: new Set(rows.map((row) => row.query)).size, pages: new Set(rows.map((row) => row.page)).size },
    countries: countries.slice(0, 8),
    targetMarkets: targets,
    targetShare,
    brandedShare,
    commercialShare,
    entityQueries,
    strikingDistance,
    lowCtrPages,
    cannibalized: cannibalized.slice(0, 10),
    commercialGaps,
    narrative: "",
  };
  insights.narrative = searchNarrative(insights);
  return insights;
}

/** The analyst's summary: where visibility comes from, what kind of searches bring clicks, and how much demand is close. */
function searchNarrative(insights: SearchInsights): string {
  const { totals } = insights;
  if (!totals.impressions) return "Search Console returned no impressions for this period.";
  const parts = [`Organic search brought ~${count(totals.clicks)} clicks from ~${count(totals.impressions)} impressions in the synced window.`];
  const top = insights.countries[0];
  if (insights.targetShare) {
    const names = insights.targetMarkets.map(countryName).join(", ");
    const outside = insights.countries.find((country) => !insights.targetMarkets.includes(country.country));
    parts.push(`Your target market${insights.targetMarkets.length > 1 ? "s" : ""} (${names}) account${insights.targetMarkets.length > 1 ? "" : "s"} for ${pct(insights.targetShare.impressions)} of impressions and ${pct(insights.targetShare.clicks)} of clicks${outside && outside.impressionShare > insights.targetShare.impressions ? `, while ${outside.name} accounts for ${pct(outside.impressionShare)} of impressions` : ""}.`);
  } else if (top) {
    parts.push(`${pct(top.impressionShare)} of impressions come from ${top.name}; set your target markets to check that matches who you sell to.`);
  }
  const entity = insights.entityQueries?.byType[0];
  if (insights.entityQueries && insights.entityQueries.share >= 0.2 && entity) {
    parts.push(`${pct(insights.entityQueries.share)} of clicks come from searches naming a specific ${entity.entityType}${entity.examples[0] ? ` (e.g. “${entity.examples[0]}”)` : ""}.`);
  }
  if (insights.brandedShare > 0.5) parts.push(`About ${pct(insights.brandedShare)} of clicks are branded searches, so non-brand discovery is still small.`);
  if (totals.clicks >= 50 && insights.commercialShare < 0.15) parts.push(`Only ${pct(insights.commercialShare)} of clicks come from commercial-intent searches (prices, costs, best, booking).`);
  if (insights.strikingDistance.length) parts.push(`${insights.strikingDistance.length} queries rank between positions 4 and 15 — the closest demand to win.`);
  if (insights.commercialGaps.length) parts.push(`${insights.commercialGaps.length} commercial-intent queries rank beyond page one.`);
  return parts.join(" ");
}

/** Market alignment, intent mix, snippets that don't earn clicks, and pages competing with each other. */
export function findingsFromSearch(insights: SearchInsights, siteId: string, analysisId: string): Finding[] {
  const drafts: Array<Pick<Finding, "title" | "summary" | "recommendation" | "evidence" | "organicImpactScore" | "pagesAffected">> = [];
  const { totals } = insights;
  if (insights.targetShare && totals.impressions >= 500 && insights.targetShare.impressions < 0.3) {
    const outside = insights.countries.filter((country) => !insights.targetMarkets.includes(country.country)).slice(0, 3);
    drafts.push({
      title: "Most search visibility comes from outside your target market",
      summary: `${insights.targetMarkets.map(countryName).join(", ")} ${insights.targetMarkets.length > 1 ? "account" : "accounts"} for ${pct(insights.targetShare.impressions)} of impressions and ${pct(insights.targetShare.clicks)} of clicks; ${outside.map((country) => `${country.name} ${pct(country.impressionShare)}`).join(", ")}. More pages of the same kind are unlikely to change who finds you; content in the market's language and for its searches will.`,
      recommendation: "Set the page language to your market's language, scope datasets around what that market searches for (treatments, costs, cities), and add hreflang if you publish several languages.",
      evidence: { targetMarkets: insights.targetMarkets, targetShare: insights.targetShare, countries: insights.countries },
      // A strategic constraint rather than a defect: the further below 30% the target share, the higher it ranks.
      organicImpactScore: Math.round(55 + 30 * (1 - insights.targetShare.impressions / 0.3)),
      pagesAffected: [],
    });
  }
  const entity = insights.entityQueries;
  if (entity && entity.share >= 0.5 && insights.commercialShare < 0.15 && totals.clicks >= 50) {
    const top = entity.byType[0]!;
    drafts.push({
      title: `Search traffic is mostly people looking up a ${top.entityType} by name`,
      summary: `${pct(entity.share)} of clicks come from searches naming a specific ${top.entityType} (e.g. ${top.examples.slice(0, 2).map((query) => `“${query}”`).join(", ")}), and only ${pct(insights.commercialShare)} from commercial-intent searches. Name lookups convert poorly; the demand that produces customers (costs, treatments, comparisons) isn't being captured.`,
      recommendation: "Build landing pages around commercial intent — cost, comparison, and service × location pages — and link to them from the pages that already rank for names.",
      evidence: { entityQueries: entity, commercialShare: insights.commercialShare },
      organicImpactScore: 55,
      pagesAffected: [],
    });
  }
  if (insights.lowCtrPages.length >= 2) {
    const lost = insights.lowCtrPages.reduce((sum, page) => sum + page.impressions * (page.expectedCtr - page.ctr), 0);
    drafts.push({
      title: "Pages on page one that searchers skip",
      summary: `${insights.lowCtrPages.length} pages rank in the top 10 but get under half the clicks their position usually earns — roughly ${count(Math.round(lost))} clicks a month left on the table. Their titles and descriptions don't match what people searched for.`,
      recommendation: "Rewrite the title and meta description of each page around its top queries and the most compelling concrete fact (price, location, rating).",
      evidence: { pages: insights.lowCtrPages },
      organicImpactScore: Math.min(35 + Math.round(Math.log10(lost + 1) * 8), 70),
      pagesAffected: insights.lowCtrPages.map((page) => page.page),
    });
  }
  if (insights.cannibalized.length >= 3) {
    drafts.push({
      title: "Several pages compete for the same searches",
      summary: `${insights.cannibalized.length} queries split their impressions across two or more of your pages (e.g. “${insights.cannibalized[0]!.query}” across ${insights.cannibalized[0]!.pages.length} pages). Google picks between them, and neither ranks as well as one strong page would.`,
      recommendation: "For each query, pick the page that should rank: merge or redirect the weaker one, or differentiate it and link from it to the main page.",
      evidence: { queries: insights.cannibalized },
      organicImpactScore: 35,
      pagesAffected: insights.cannibalized.flatMap((entry) => entry.pages.map((page) => page.page)).slice(0, 20),
    });
  }
  const createdAt = new Date().toISOString();
  return drafts.map((draft) => ({
    id: createId("finding"),
    siteId,
    analysisId,
    category: "search" as const,
    severity: severityFromImpact(draft.organicImpactScore),
    ...draft,
    createdAt,
  }));
}

/** The pages and queries closest to more clicks, as prioritized opportunities. */
export function searchOpportunities(insights: SearchInsights, siteId: string, analysisId: string): Opportunity[] {
  const striking = insights.strikingDistance.slice(0, 8).map((entry): Opportunity => {
    const commercial = COMMERCIAL_QUERY_PATTERN.test(entry.query);
    const gain = entry.impressions * Math.max(expectedCtr(3) - entry.clicks / Math.max(entry.impressions, 1), 0);
    return {
      id: createId("opp"), siteId, analysisId,
      title: `Move “${entry.query}” onto the first results (now position ${entry.position.toFixed(1)})`,
      searchDemand: entry.impressions,
      intent: commercial ? "commercial (query-pattern heuristic)" : "informational or mixed (verify manually)",
      currentRank: entry.position, competitorStrength: 0, estimatedDifficulty: Math.min(100, Math.round(entry.position * 5)),
      currentPage: entry.page, businessValue: commercial ? 1.5 : 1, conversionPotential: commercial ? 1 : 0.5,
      technicalEffort: 1, contentEffort: 2,
      priorityScore: Number(((gain * (commercial ? 1.5 : 1)) / 2).toFixed(2)),
      rationale: `${count(entry.impressions)} impressions and ${count(entry.clicks)} clicks at average position ${entry.position.toFixed(1)}. Positions 1–3 typically earn several times the clicks; strengthen the page's coverage of this query, its title, and internal links to it. A prioritization aid, not a traffic forecast.`,
    };
  });
  const snippets = insights.lowCtrPages.slice(0, 5).map((page): Opportunity => ({
    id: createId("opp"), siteId, analysisId,
    title: `Rewrite the search snippet of ${page.page.replace(/^https?:\/\/[^/]+/, "") || "/"}`,
    searchDemand: page.impressions, intent: "snippet", currentRank: page.position, competitorStrength: 0, estimatedDifficulty: 10,
    currentPage: page.page, businessValue: 1, conversionPotential: 1, technicalEffort: 1, contentEffort: 1,
    priorityScore: Number((page.impressions * (page.expectedCtr - page.ctr) / 1.5).toFixed(2)),
    rationale: `Position ${page.position.toFixed(1)} with a ${(page.ctr * 100).toFixed(1)}% click-through rate; pages there typically get ~${(page.expectedCtr * 100).toFixed(0)}%. Top queries: ${page.queries.map((query) => `“${query}”`).join(", ")}.`,
  }));
  return [...striking, ...snippets];
}
