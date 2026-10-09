import { authorityDomain } from "@organic-growth/agents";
import type { KeywordsInput, PricedKeyword, RankedKeyword, SiteRecord } from "@organic-growth/core";
import { firstMetricDay, listSnapshots, type D1Like } from "@organic-growth/db";

/**
 * The keyword lists the view and the growth plan read: only those fetched for
 * the current property, target markets and competitors (the scope says which),
 * so a changed setting hides the old lists until the next sync replaces them.
 */
export async function loadKeywords(db: D1Like, site: SiteRecord, scope: { markets: string[]; competitors: string[] }): Promise<KeywordsInput> {
  const own = authorityDomain(site.baseUrl);
  const domains = new Set([own, ...scope.competitors]);
  const [priced, ranked, marker] = await Promise.all([
    listSnapshots<PricedKeyword>(db, site.id, "keywords"),
    listSnapshots<RankedKeyword>(db, site.id, "competitor_keywords"),
    firstMetricDay(db, site.id, "sync.competitor_keywords"),
  ]);
  const inScope = (list: { scope: string }, first: (value: string) => boolean) => {
    const [head, market] = list.scope.split("|");
    return first(head!) && scope.markets.includes(market!);
  };
  return {
    site: own,
    competitors: scope.competitors,
    synced: marker !== null,
    priced: priced.filter((list) => inScope(list, (property) => property === site.gscProperty)).map(({ periodEnd, rows }) => ({ periodEnd, rows })),
    ranked: ranked.filter((list) => inScope(list, (domain) => domains.has(domain))).map(({ scope: key, periodEnd, rows }) => ({ domain: key.split("|")[0]!, periodEnd, rows })),
  };
}
