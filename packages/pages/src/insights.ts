import { probabilityBest } from "./bandit.js";

export type PagePerformance = {
  pageId: string;
  templateId: string;
  path: string;
  title: string;
  publishedAt?: string;
  views: number;
  ctaClicks: number;
  /** Conversions from sessions that landed on this page. */
  conversions: number;
  googlebotHits: number;
  clicks: number;
  impressions: number;
  position: number | null;
};

export type PageQuery = { pageUrl: string; query: string; clicks: number; impressions: number; position: number };

export type SuggestionKind =
  | "rewrite_snippet"
  | "target_queries"
  | "not_crawled"
  | "no_visibility"
  | "weak_cta"
  | "expand_template"
  | "start_cta_test"
  | "cta_winner";

export type Suggestion = {
  kind: SuggestionKind;
  title: string;
  detail: string;
  /** Rough size of the prize (clicks or conversions per period) for ranking — not a forecast. */
  impact: number;
  pageId?: string;
  templateId?: string;
  queries?: string[];
  examples?: string[];
};

export type TemplateStats = {
  templateId: string;
  name: string;
  pages: number;
  pagesWithImpressions: number;
  impressions: number;
  clicks: number;
  views: number;
  ctaClicks: number;
  conversions: number;
  ctaRate: number;
  conversionRate: number;
};

export type PerformanceReport = {
  totals: { pages: number; impressions: number; clicks: number; views: number; ctaClicks: number; conversions: number; googlebotHits: number };
  templates: TemplateStats[];
  topPages: Array<PagePerformance & { score: number }>;
  suggestions: Suggestion[];
};

/**
 * Typical organic click-through rate by position (blended desktop/mobile).
 * Only used to spot pages that under-perform their ranking.
 */
const CTR_BY_POSITION = [0.28, 0.157, 0.11, 0.08, 0.072, 0.051, 0.04, 0.032, 0.028, 0.025];

export function expectedCtr(position: number): number {
  if (!Number.isFinite(position) || position < 1) return CTR_BY_POSITION[0]!;
  if (position <= 10) return CTR_BY_POSITION[Math.round(position) - 1] ?? 0.025;
  if (position <= 20) return 0.01;
  return 0.003;
}

const STOPWORDS = new Set(["the", "a", "an", "in", "of", "for", "and", "to", "at", "on", "with", "near", "me", "di", "dan", "yang", "best"]);

function missingTerms(query: string, title: string): string[] {
  const titleText = title.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter((term) => term.length > 2 && !STOPWORDS.has(term) && !titleText.includes(term));
}

const daysSince = (iso: string | undefined, now: Date) =>
  iso ? (now.getTime() - Date.parse(iso)) / 86_400_000 : 0;

const conversionsOf = (page: PagePerformance) => page.conversions;

/**
 * Turns page performance into a ranked list of concrete next actions. Every
 * suggestion carries the evidence it was derived from; thresholds are
 * deliberately conservative so low-traffic noise does not trigger rewrites.
 */
export function buildPerformanceReport(input: {
  pages: PagePerformance[];
  queries: PageQuery[];
  templates: Array<{ id: string; name: string }>;
  publicOrigin: string;
  variants?: Array<{ id: string; label: string; impressions: number; clicks: number; active: boolean }>;
  now?: Date;
}): PerformanceReport {
  const now = input.now ?? new Date();
  const origin = input.publicOrigin.replace(/\/$/, "");
  const suggestions: Suggestion[] = [];
  const queriesByPath = new Map<string, PageQuery[]>();
  for (const row of input.queries) {
    if (!row.pageUrl.startsWith(origin)) continue;
    const path = row.pageUrl.slice(origin.length) || "/";
    queriesByPath.set(path, [...(queriesByPath.get(path) ?? []), row]);
  }

  const totals = input.pages.reduce((sum, page) => ({
    pages: sum.pages + 1,
    impressions: sum.impressions + page.impressions,
    clicks: sum.clicks + page.clicks,
    views: sum.views + page.views,
    ctaClicks: sum.ctaClicks + page.ctaClicks,
    conversions: sum.conversions + conversionsOf(page),
    googlebotHits: sum.googlebotHits + page.googlebotHits,
  }), { pages: 0, impressions: 0, clicks: 0, views: 0, ctaClicks: 0, conversions: 0, googlebotHits: 0 });

  for (const page of input.pages) {
    // Pages that rank but are not chosen: the snippet is the problem.
    if (page.impressions >= 100 && page.position != null && page.position <= 12) {
      const ctr = page.clicks / page.impressions;
      const expected = expectedCtr(page.position);
      if (ctr < expected * 0.5) {
        const queries = (queriesByPath.get(page.path) ?? []).sort((a, b) => b.impressions - a.impressions).slice(0, 5).map((row) => row.query);
        suggestions.push({
          kind: "rewrite_snippet",
          pageId: page.pageId,
          templateId: page.templateId,
          title: `Rewrite the title for ${page.path}`,
          detail: `Ranks around position ${page.position.toFixed(1)} with ${page.impressions.toLocaleString()} impressions but a ${(ctr * 100).toFixed(1)}% click-through rate; pages at that position typically get ~${(expected * 100).toFixed(0)}%.`,
          impact: Math.round(page.impressions * (expected - ctr)),
          queries,
        });
      }
    }

    // Queries just off page one, not reflected in the title.
    const striking = (queriesByPath.get(page.path) ?? [])
      .filter((row) => row.position >= 8 && row.position <= 20 && row.impressions >= 30 && missingTerms(row.query, page.title).length > 0)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 3);
    if (striking.length) {
      suggestions.push({
        kind: "target_queries",
        pageId: page.pageId,
        templateId: page.templateId,
        title: `Target near-miss searches on ${page.path}`,
        detail: `${striking.map((row) => `“${row.query}” (position ${row.position.toFixed(0)}, ${row.impressions} impressions)`).join("; ")}. Working these terms into the title and FAQ can move the page onto page one.`,
        impact: Math.round(striking.reduce((sum, row) => sum + row.impressions * (expectedCtr(5) - expectedCtr(row.position)), 0)),
        queries: striking.map((row) => row.query),
      });
    }
  }

  const templates = input.templates.map((template): TemplateStats => {
    const pages = input.pages.filter((page) => page.templateId === template.id);
    const views = pages.reduce((sum, page) => sum + page.views, 0);
    const ctaClicks = pages.reduce((sum, page) => sum + page.ctaClicks, 0);
    const conversions = pages.reduce((sum, page) => sum + conversionsOf(page), 0);
    return {
      templateId: template.id,
      name: template.name,
      pages: pages.length,
      pagesWithImpressions: pages.filter((page) => page.impressions > 0).length,
      impressions: pages.reduce((sum, page) => sum + page.impressions, 0),
      clicks: pages.reduce((sum, page) => sum + page.clicks, 0),
      views,
      ctaClicks,
      conversions,
      ctaRate: views ? ctaClicks / views : 0,
      conversionRate: views ? conversions / views : 0,
    };
  });

  for (const template of templates) {
    const pages = input.pages.filter((page) => page.templateId === template.templateId);
    const uncrawled = pages.filter((page) => daysSince(page.publishedAt, now) >= 7 && page.googlebotHits === 0 && page.impressions === 0);
    if (uncrawled.length >= Math.max(3, pages.length * 0.2)) {
      suggestions.push({
        kind: "not_crawled",
        templateId: template.templateId,
        title: `Google hasn't fetched ${uncrawled.length.toLocaleString()} “${template.name}” pages`,
        detail: "These pages were published at least a week ago and no Googlebot request has reached them. Submit the guides sitemap in Search Console and link to the guides hub from your main navigation or footer.",
        impact: uncrawled.length,
        examples: uncrawled.slice(0, 5).map((page) => page.path),
      });
    }
    const invisible = pages.filter((page) => daysSince(page.publishedAt, now) >= 45 && page.impressions === 0 && page.googlebotHits > 0);
    if (invisible.length >= 3) {
      suggestions.push({
        kind: "no_visibility",
        templateId: template.templateId,
        title: `${invisible.length.toLocaleString()} “${template.name}” pages have no search impressions after 45 days`,
        detail: "Google has crawled them but is not showing them. Add more distinctive facts to these records, strengthen internal links from your main pages, or unpublish the weakest ones so they don't dilute the set.",
        impact: invisible.length * 0.5,
        examples: invisible.slice(0, 5).map((page) => page.path),
      });
    }
    if (template.views >= 100 && template.ctaRate < 0.01) {
      suggestions.push({
        kind: "weak_cta",
        templateId: template.templateId,
        title: `Visitors read “${template.name}” pages but rarely act`,
        detail: `${template.views.toLocaleString()} views produced ${template.ctaClicks} CTA clicks (${(template.ctaRate * 100).toFixed(1)}%). Test a more specific call to action, e.g. one that names the item on the page or offers a quick quote.`,
        impact: Math.round(template.views * 0.02),
      });
    }
  }

  const siteRate = totals.views ? totals.conversions / totals.views : 0;
  for (const template of templates) {
    if (template.views >= 100 && siteRate > 0 && template.conversionRate >= siteRate * 1.5 && templates.length > 1) {
      suggestions.push({
        kind: "expand_template",
        templateId: template.templateId,
        title: `“${template.name}” converts ${(template.conversionRate / siteRate).toFixed(1)}× better than average`,
        detail: "Pages of this type produce the most conversions per visit. Add sources or records to this dataset so it covers more of the searches it already wins.",
        impact: Math.round(template.conversions * 0.5),
      });
    }
  }

  const active = (input.variants ?? []).filter((variant) => variant.active);
  if (active.length < 2 && totals.views >= 200) {
    suggestions.push({
      kind: "start_cta_test",
      title: "Start a call-to-action test",
      detail: "Pages have enough traffic to compare CTAs. Add a second variant; traffic shifts toward the better one automatically.",
      impact: Math.round(totals.views * 0.01),
    });
  } else if (active.length >= 2 && active.reduce((sum, variant) => sum + variant.impressions, 0) >= 500) {
    const odds = probabilityBest(active);
    const [leaderId, leaderOdds] = [...odds].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    const leader = active.find((variant) => variant.id === leaderId);
    if (leader && leaderOdds >= 0.95) {
      suggestions.push({
        kind: "cta_winner",
        title: `“${leader.label}” is the winning CTA`,
        detail: `${(leaderOdds * 100).toFixed(0)}% probability it has the best click-through rate (${leader.clicks} clicks from ${leader.impressions} views). Pause the others and test a new challenger against it.`,
        impact: Math.round(leader.clicks * 0.2),
      });
    }
  }

  const topPages = input.pages
    .map((page) => ({ ...page, score: conversionsOf(page) * 10 + page.ctaClicks * 3 + page.clicks + page.views * 0.1 }))
    .filter((page) => page.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 25);

  return {
    totals,
    templates,
    topPages,
    suggestions: suggestions.sort((a, b) => b.impact - a.impact).slice(0, 30),
  };
}
