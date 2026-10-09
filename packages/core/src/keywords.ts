/*
 * Keyword lists from DataForSEO, and what the Performance card and the growth
 * plan derive from them. Pure: the API, the client link, the analysis and the
 * tests compute the same gaps.
 */

/** One of a domain's ranked keywords in a market (DataForSEO `ranked_keywords`). */
export type RankedKeyword = { keyword: string; volume: number | null; difficulty: number | null; intent: string | null; position: number; url: string; traffic: number };
/** One of the site's Search Console queries with DataForSEO's figures (`keyword_overview`); volume is null when DataForSEO doesn't know it. */
export type PricedKeyword = { keyword: string; volume: number | null; difficulty: number | null; intent: string | null; position: number; clicks: number; impressions: number };

export type KeywordsInput = {
  /** The site's domain without `www.`, as its own ranked list is scoped. */
  site: string;
  competitors: string[];
  /** Whether the keyword sources have run (their markers exist). */
  synced: boolean;
  /** The site's priced queries, one list per market. */
  priced: Array<{ periodEnd: string; rows: PricedKeyword[] }>;
  /** Ranked lists for the site and each competitor, one per domain and market. */
  ranked: Array<{ domain: string; periodEnd: string; rows: RankedKeyword[] }>;
};

export type KeywordGap = { keyword: string; volume: number | null; difficulty: number | null; intent: string | null; domain: string; position: number; url: string };

export type KeywordDemand = { lookup(query: string): { volume: number | null; difficulty: number | null; intent: string | null } | null };

const byVolume = <T extends { volume: number | null }>(a: T, b: T) => (b.volume ?? 0) - (a.volume ?? 0);

/** The site's priced queries across markets: one row per keyword, the higher volume winning. */
function ownKeywords(input: KeywordsInput): Map<string, PricedKeyword> {
  const own = new Map<string, PricedKeyword>();
  for (const row of input.priced.flatMap((list) => list.rows)) {
    const key = row.keyword.toLowerCase();
    const seen = own.get(key);
    if (!seen || (row.volume ?? -1) > (seen.volume ?? -1)) own.set(key, row);
  }
  return own;
}

/** Competitor keywords the site appears for in neither of its lists; the best-placed competitor stands for each. Highest volume first. */
export function keywordGaps(input: KeywordsInput): KeywordGap[] {
  const has = new Set([...ownKeywords(input).keys(), ...input.ranked.filter((list) => list.domain === input.site).flatMap((list) => list.rows.map((row) => row.keyword.toLowerCase()))]);
  const gaps = new Map<string, KeywordGap>();
  for (const list of input.ranked) {
    if (list.domain === input.site) continue;
    for (const row of list.rows) {
      const key = row.keyword.toLowerCase();
      if (has.has(key)) continue;
      const seen = gaps.get(key);
      if (!seen || row.position < seen.position) gaps.set(key, { keyword: row.keyword, volume: row.volume, difficulty: row.difficulty, intent: row.intent, domain: list.domain, position: row.position, url: row.url });
    }
  }
  return [...gaps.values()].sort(byVolume);
}

/** What the Keywords card shows from the lists: the 25 queries with the most clicks, the 25 biggest gaps, and the data's date. */
export function keywordsView(input: KeywordsInput) {
  const asOf = [...input.priced, ...input.ranked].map((list) => list.periodEnd).sort().at(-1) ?? null;
  const top = [...ownKeywords(input).values()].sort((a, b) => b.clicks - a.clicks || byVolume(a, b)).slice(0, 25);
  // No gaps means nothing only when some competitor list has keywords in it.
  const gapsKnown = input.ranked.some((list) => list.domain !== input.site && list.rows.length > 0);
  return { asOf, synced: input.synced, gapsKnown, top, gaps: keywordGaps(input).slice(0, 25) };
}

/** A lookup from the site's priced queries, for the growth plan. */
export function demandFromSnapshots(priced: PricedKeyword[]): KeywordDemand {
  const own = ownKeywords({ site: "", competitors: [], synced: true, priced: [{ periodEnd: "", rows: priced }], ranked: [] });
  return {
    lookup(query) {
      const row = own.get(query.toLowerCase());
      return row ? { volume: row.volume, difficulty: row.difficulty, intent: row.intent } : null;
    },
  };
}
