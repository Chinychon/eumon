/*
 * Search results per query (DataForSEO SERP API) and the domains that win a
 * market's searches (DataForSEO Labs `serp_competitors`): who actually ranks
 * for the site's searches, which result types take the clicks, and whether an
 * AI Overview cites the site. Pure, so the view, the client link, the growth
 * plan and the tests read the lists the same way.
 */

/** Result types that sit on Google's page besides the ten blue links. */
export const SERP_FEATURES = [
  { feature: "ai_overview", label: "AI Overview" },
  { feature: "featured_snippet", label: "Featured snippet" },
  { feature: "local_pack", label: "Map pack" },
  { feature: "people_also_ask", label: "People also ask" },
  { feature: "video", label: "Videos" },
  { feature: "images", label: "Images" },
  { feature: "shopping", label: "Shopping" },
  { feature: "top_stories", label: "Top stories" },
] as const;

export type SerpFeature = (typeof SERP_FEATURES)[number]["feature"];

/** One search's results page in one market, as Google showed it on `checkedAt`. */
export type SerpResult = {
  keyword: string;
  checkedAt: string;
  /** Monthly searches, carried from the keyword list that chose this search. */
  volume: number | null;
  features: SerpFeature[];
  /** The site's best organic position in the results fetched, or null when it isn't there. */
  position: number | null;
  url: string | null;
  /** Domains the AI Overview names as its sources; empty without one. */
  aiOverviewSources: string[];
  /** The site is one of the AI Overview's sources. */
  cited: boolean;
  /** The first ten organic results. */
  organic: Array<{ position: number; domain: string; url: string; title: string }>;
};

/** A domain that ranks for a market's searches (Labs `serp_competitors`). */
export type SerpCompetitor = { domain: string; keywords: number; avgPosition: number; visibility: number; traffic: number };

/** What kind of rival a domain is: a business like the site's, a listing site, or a platform nobody competes with directly. */
export type CompetitorKind = "competitor" | "directory" | "platform";

const PLATFORMS = [
  "youtube.com", "facebook.com", "instagram.com", "tiktok.com", "reddit.com", "quora.com", "wikipedia.org", "linkedin.com", "pinterest.com",
  "x.com", "twitter.com", "medium.com", "amazon.com", "google.com", "apple.com", "microsoft.com", "github.com", "wikihow.com", "threads.net",
];
const DIRECTORIES = [
  "yelp.", "tripadvisor.", "yellowpages", "foursquare.com", "trustpilot.com", "g2.com", "capterra.com", "glassdoor.", "indeed.", "jobstreet.",
  "practo.com", "doctoralia.", "healthgrades.com", "zocdoc.com", "webmd.com", "booking.com", "agoda.com", "expedia.", "propertyguru.", "iproperty.",
  "mudah.my", "carousell.", "lazada.", "shopee.", "tokopedia.com", "alodokter.com", "halodoc.com",
];

export const bareDomain = (host: string) => host.toLowerCase().replace(/^www\./, "");

const isOrUnder = (domain: string, root: string) => domain === root || domain.endsWith(`.${root}`);

/** Platforms (social, video, encyclopedias) rank everywhere but aren't rivals; directories list businesses like the site's. */
export function competitorKind(domain: string): CompetitorKind {
  const bare = bareDomain(domain);
  if (PLATFORMS.some((root) => isOrUnder(bare, root)) || /(^|\.)wikipedia\.org$/.test(bare)) return "platform";
  if (DIRECTORIES.some((part) => (part.endsWith(".") ? bare.includes(part) : isOrUnder(bare, part)))) return "directory";
  return "competitor";
}

export type CompetitorSuggestion = SerpCompetitor & { kind: CompetitorKind; markets: string[] };

/**
 * Domains that win the site's searches and aren't on its competitor list yet:
 * the site itself and platforms are left out, a domain must rank for at least
 * two of the searches, and the most visible come first. Lists from several
 * markets merge by domain.
 */
export function suggestCompetitors(lists: Array<{ market: string; rows: SerpCompetitor[] }>, site: string, current: string[], limit = 8): CompetitorSuggestion[] {
  const own = bareDomain(site);
  const known = new Set(current.map(bareDomain));
  const merged = new Map<string, CompetitorSuggestion>();
  for (const list of lists) {
    for (const row of list.rows) {
      const domain = bareDomain(row.domain);
      if (isOrUnder(domain, own) || known.has(domain) || row.keywords < 2) continue;
      const kind = competitorKind(domain);
      if (kind === "platform") continue;
      const seen = merged.get(domain);
      merged.set(domain, seen
        ? { ...seen, keywords: seen.keywords + row.keywords, visibility: seen.visibility + row.visibility, traffic: seen.traffic + row.traffic, avgPosition: Math.min(seen.avgPosition, row.avgPosition), markets: [...seen.markets, list.market] }
        : { ...row, domain, kind, markets: [list.market] });
    }
  }
  return [...merged.values()].sort((a, b) => b.visibility - a.visibility || b.traffic - a.traffic).slice(0, limit);
}

/** The searches whose results page was checked, across markets, highest volume first, with how often each result type appears. */
export function serpView(lists: Array<{ market: string; periodEnd: string; rows: SerpResult[] }>, suggestions: CompetitorSuggestion[]) {
  const rows = lists.flatMap((list) => list.rows.map((row) => ({ ...row, market: list.market })))
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0) || a.keyword.localeCompare(b.keyword));
  const features = SERP_FEATURES.map(({ feature, label }) => ({ feature, label, searches: rows.filter((row) => row.features.includes(feature)).length }))
    .filter((entry) => entry.searches > 0);
  const withOverview = rows.filter((row) => row.features.includes("ai_overview"));
  return {
    asOf: rows.map((row) => row.checkedAt).sort().at(-1) ?? null,
    checked: rows.length,
    features,
    aiOverview: { searches: withOverview.length, citesYou: withOverview.filter((row) => row.cited).length },
    rows: rows.slice(0, 40),
    suggestions,
  };
}

export type SerpView = ReturnType<typeof serpView>;

/** A lookup from a query to its checked results page, for the growth plan's rationales. */
export function serpLookup(lists: Array<{ rows: SerpResult[] }>): (query: string) => SerpResult | null {
  const byKeyword = new Map<string, SerpResult>();
  for (const row of lists.flatMap((list) => list.rows)) {
    const key = row.keyword.toLowerCase();
    const seen = byKeyword.get(key);
    if (!seen || (row.volume ?? 0) > (seen.volume ?? 0)) byKeyword.set(key, row);
  }
  return (query) => byKeyword.get(query.toLowerCase()) ?? null;
}

/** "an AI Overview and a map pack sit above the results": the features that push organic results down, in words. */
export function serpCrowding(result: SerpResult): string | null {
  const above = (["ai_overview", "local_pack", "featured_snippet", "shopping"] as SerpFeature[]).filter((feature) => result.features.includes(feature));
  if (!above.length) return null;
  const names = above.map((feature) => {
    const label = SERP_FEATURES.find((entry) => entry.feature === feature)!.label;
    return feature === "ai_overview" ? "an AI Overview" : feature === "local_pack" ? "a map pack" : `a ${label.toLowerCase()}`;
  });
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
