/*
 * Backlinks from DataForSEO's Backlinks API: each domain's link profile, and
 * the link gap (sites that link to the competitors but not to the site).
 * Pure: the view, the client link and the growth plan read the lists alike.
 */

/** One domain's live link profile (`backlinks/summary`). Rank is DataForSEO's 0–1,000 scale. */
export type BacklinkSummary = { domain: string; rank: number; backlinks: number; referringDomains: number; referringMainDomains: number; brokenBacklinks: number; spamScore: number | null };

/** A site linking to every competitor checked and not to the site (`backlinks/domain_intersection`). */
export type LinkGap = { domain: string; rank: number; backlinks: number; linksTo: string[] };

export type LinksInput = {
  site: string;
  competitors: string[];
  synced: boolean;
  summaries: Array<{ periodEnd: string; row: BacklinkSummary }>;
  gap: { periodEnd: string; rows: LinkGap[] } | null;
};

/** The Backlinks card: the site and each competitor side by side, and the 25 strongest gap domains. */
export function linksView(input: LinksInput) {
  const byDomain = new Map(input.summaries.map((entry) => [entry.row.domain, entry.row]));
  const domains = [input.site, ...input.competitors].map((domain) => ({ domain, summary: byDomain.get(domain) ?? null }));
  const asOf = [...input.summaries.map((entry) => entry.periodEnd), ...(input.gap ? [input.gap.periodEnd] : [])].sort().at(-1) ?? null;
  return {
    asOf,
    synced: input.synced,
    domains,
    gap: input.gap ? [...input.gap.rows].sort((a, b) => b.rank - a.rank).slice(0, 25) : null,
    gapTotal: input.gap?.rows.length ?? 0,
  };
}

export type LinksView = ReturnType<typeof linksView>;

/** How far the site trails its strongest competitor in referring domains, or null when either is unknown or the site leads. */
export function referringDomainGap(input: LinksInput): { leader: string; theirs: number; yours: number } | null {
  const own = input.summaries.find((entry) => entry.row.domain === input.site)?.row;
  const rivals = input.summaries.filter((entry) => input.competitors.includes(entry.row.domain)).map((entry) => entry.row);
  if (!own || !rivals.length) return null;
  const leader = rivals.sort((a, b) => b.referringMainDomains - a.referringMainDomains)[0]!;
  return leader.referringMainDomains > own.referringMainDomains ? { leader: leader.domain, theirs: leader.referringMainDomains, yours: own.referringMainDomains } : null;
}
