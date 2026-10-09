/*
 * Results math: windows, weeks, and comparisons over ledger series. Pure, so
 * the API, the client link, and the tests all compute the same numbers.
 */

import { keywordsView, type KeywordsInput } from "./keywords.js";
import { SPEED_METRICS, speedRating, type SpeedMetric, type SpeedRating } from "./signals.js";

export type DayValue = { day: string; value: number };
export type Compare = { current: number | null; before: number | null; previous: number | null };
type Range = [string, string];

export function addDays(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

/** The Monday on or before `day`; weeks run Monday to Sunday. */
export function weekStart(day: string): string {
  return addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
}

/** Sum of points inside a range, or null when the range has no points at all. */
function sum(series: DayValue[] | undefined, [from, to]: Range): number | null {
  const inside = (series ?? []).filter((point) => point.day >= from && point.day <= to);
  return inside.length ? inside.reduce((total, point) => total + point.value, 0) : null;
}

/** The latest point on or before a day (for snapshot metrics). */
function latest(series: DayValue[] | undefined, to: string): number | null {
  const points = (series ?? []).filter((point) => point.day <= to);
  return points.length ? points[points.length - 1]!.value : null;
}

/** Weekly sums from the first full week on or after `from` to the week of `to`; weeks ending after `complete` are partial. */
export function weekly(series: DayValue[] | undefined, from: string, to: string, complete: string) {
  const first = weekStart(from) === from ? from : addDays(weekStart(from), 7);
  const sums = new Map<string, number>();
  for (const point of series ?? []) {
    if (point.day < first || point.day > to) continue;
    const week = weekStart(point.day);
    sums.set(week, (sums.get(week) ?? 0) + point.value);
  }
  const weeks: Array<{ week: string; value: number | null; partial: boolean }> = [];
  for (let week = first; week <= to; week = addDays(week, 7)) {
    weeks.push({ week, value: sums.get(week) ?? null, partial: addDays(week, 6) > complete });
  }
  return weeks;
}

/** The current, previous, and before-go-live 28-day windows, ending `lag` days before today. */
function windows(today: string, goLive: string | null, lag: number) {
  const end = addDays(today, -lag);
  return {
    current: [addDays(end, -27), end] as Range,
    previous: [addDays(end, -55), addDays(end, -28)] as Range,
    before: goLive ? [addDays(goLive, -28), addDays(goLive, -1)] as Range : null,
  };
}

function compare(series: DayValue[] | undefined, w: ReturnType<typeof windows>): Compare {
  return { current: sum(series, w.current), previous: sum(series, w.previous), before: w.before ? sum(series, w.before) : null };
}

function ratio(top: DayValue[] | undefined, bottom: DayValue[] | undefined, w: ReturnType<typeof windows>): Compare {
  const one = (range: Range | null) => {
    if (!range) return null;
    const a = sum(top, range);
    const b = sum(bottom, range);
    return a === null || !b ? null : a / b;
  };
  return { current: one(w.current), previous: one(w.previous), before: one(w.before) };
}

export const RANK_BUCKETS = [3, 10, 20, 100] as const;
const SEARCH = ["search_clicks", "search_impressions", "search_position_weight"];
const BUCKET_METRICS = RANK_BUCKETS.flatMap((n) => [`queries_top${n}`, `queries_top${n}.new`, `queries_top${n}.lost`]);

/**
 * Every ledger metric, grouped by the source that writes it. A group is what
 * that source's sync may write, what the view reads, and what a changed
 * property clears. `sync.*` markers record that a source has run.
 */
export const METRICS = {
  firstParty: ["leads", "leads_eumon", "googlebot_fetches", "eumon_page_views", "eumon_cta_clicks", "published_pages"],
  analysis: ["site_health", "crawl_urls", "crawl_empty_shells", "crawl_http_errors", "crawl_noindex"],
  /** Search Console: daily series (whole site, Eumon pages, target markets), Monday ranking buckets, index status. */
  search: [
    "sync.search", "sync.search@markets", "sync.rankings",
    ...SEARCH, ...SEARCH.map((metric) => `${metric}@markets`), ...SEARCH.map((metric) => `eumon_${metric}`),
    ...BUCKET_METRICS, ...BUCKET_METRICS.map((metric) => `${metric}@markets`),
    "pages_indexed", "pages_not_indexed",
  ],
  ga4: ["sync.ga4", "ga4_sessions", "ga4_organic_sessions", "ga4_organic_engaged_sessions", "ga4_organic_key_events"],
  crux: ["sync.crux", ...["lcp", "inp", "cls"].flatMap((metric) => [`crux_${metric}_p75.phone`, `crux_${metric}_p75.desktop`])],
  lab: ["sync.lab", "lab_score_home.phone", "lab_score_home.desktop", "lab_score_eumon.phone", "lab_score_eumon.desktop"],
  /** Plus `authority:<domain>` for each current competitor. */
  authority: ["sync.authority", "authority"],
  /** DataForSEO lists live in snapshots; these are the counts that trend. Plus `kw_top10:<domain>` and `kw_traffic:<domain>` for each current competitor. */
  keywords: ["sync.competitor_keywords", "sync.keyword_volumes", "kw_top10", "kw_traffic"],
};

/** Every metric the Results view reads. */
export const RESULT_METRICS = Object.values(METRICS).flat();

/** A query's last 28 days of Search Console data, beside the 28 before (null when it had no impressions then). */
export type TopQuery = {
  query: string;
  clicks: number;
  impressions: number;
  position: number;
  before: { clicks: number; impressions: number; position: number } | null;
};

export type ResultsInput = {
  today: string;
  goLive: string | null;
  /** Target-market country codes; when set, section 1 uses the `@markets` series. */
  markets: string[];
  series: Record<string, DayValue[]>;
  index: { indexed: number; notIndexed: number; unchecked: number };
  published: number;
  searchConnected: boolean;
  ga4Connected: boolean;
  /** The latest sync's top queries, for the current property and markets. */
  topQueries?: { periodEnd: string; rows: TopQuery[] } | null;
  /** The site's current competitor domains, for `authority:<domain>` series. */
  competitors?: string[];
  /** The keyword lists, scoped to the current property, markets and competitors. */
  keywords?: KeywordsInput;
};

export type SpeedValue = { p75: number | null; rating: SpeedRating | null };

/** The Keywords card: the lists' view plus each domain's share of estimated search visits. */
export type KeywordsView = ReturnType<typeof keywordsView> & { visibility: Array<{ domain: string; traffic: number | null; top10: number | null; share: number | null }> };

export type ResultsView = {
  today: string;
  goLive: string | null;
  /** The last day Search Console has reported. */
  searchThrough: string | null;
  markets: string[];
  headline: Array<{ week: string; site: number | null; eumon: number | null; partial: boolean }>;
  numbers: {
    clicks: Compare;
    leads: Compare;
    /** The first day enquiries were tracked: "since" this when tracking began after go-live. */
    leadsSince: string | null;
    /** Googlebot requests to Eumon's pages. */
    googlebot: Compare;
    organicSessions: Compare | null;
    pages: { live: number; indexed: number; notIndexed: number; unchecked: number };
  };
  search: {
    weeks: Array<{ week: string; clicks: number | null; impressions: number | null; partial: boolean }>;
    clicksAllCountries: Compare | null;
    /** True when the figures are the target-market series, not every country. */
    scoped: boolean;
    ctr: Compare;
    position: Compare;
    buckets: Array<{ top: number; queries: number | null; added: number | null; lost: number | null }>;
    topQueries: { periodEnd: string; rows: TopQuery[] } | null;
  } | null;
  organic: Array<{ week: string; sessions: number | null; keyEvents: number | null; partial: boolean }> | null;
  leads: {
    weeks: Array<{ week: string; eumon: number | null; other: number | null; partial: boolean }>;
    funnel: Array<{ label: string; value: number }> | null;
  };
  health: { value: number | null; day: string | null };
  speed: {
    /** Whether CrUX has been asked yet; asked with no values means too few Chrome visits. */
    measured: boolean;
    metrics: Array<{ metric: SpeedMetric; phone: SpeedValue; desktop: SpeedValue; history: Array<{ day: string; phone: number | null; desktop: number | null }> }>;
  };
  lab: { phone: { home: number | null; eumon: number | null }; desktop: { home: number | null; eumon: number | null } };
  authority: { site: number | null; competitors: Array<{ domain: string; score: number | null }>; history: Array<{ day: string; value: number }> };
  keywords: KeywordsView;
};

const HISTORY_DAYS = 486;

export function resultsView(input: ResultsInput): ResultsView {
  const { series, today, goLive } = input;
  const from = addDays(today, -HISTORY_DAYS);
  const google = windows(today, goLive, 3);
  const firstParty = windows(today, goLive, 1);
  const googleComplete = addDays(today, -3);
  const scoped = (metric: string) => (input.markets.length && series[`${metric}@markets`]?.length ? `${metric}@markets` : metric);
  const searchThrough = series.search_clicks?.length ? series.search_clicks[series.search_clicks.length - 1]!.day : null;

  const siteWeeks = weekly(series.search_clicks, from, today, googleComplete);
  const eumonWeeks = weekly(series.eumon_search_clicks, from, today, googleComplete);
  const headline = siteWeeks.map((week, index) => ({
    week: week.week, site: week.value, partial: week.partial,
    eumon: goLive && addDays(week.week, 6) >= goLive ? eumonWeeks[index]!.value : null,
  }));

  const hasSearch = Boolean(series.search_clicks?.length);
  const clicksMetric = scoped("search_clicks");
  const impressionWeeks = weekly(series[scoped("search_impressions")], from, today, googleComplete);
  const search = hasSearch ? {
    weeks: weekly(series[clicksMetric], from, today, googleComplete).map((week, index) => ({
      week: week.week, clicks: week.value, partial: week.partial, impressions: impressionWeeks[index]!.value,
    })),
    clicksAllCountries: clicksMetric === "search_clicks" ? null : compare(series.search_clicks, google),
    scoped: clicksMetric !== "search_clicks",
    ctr: ratio(series[clicksMetric], series[scoped("search_impressions")], google),
    position: ratio(series[scoped("search_position_weight")], series[scoped("search_impressions")], google),
    buckets: RANK_BUCKETS.map((top) => ({
      top,
      queries: latest(series[scoped(`queries_top${top}`)], today),
      added: latest(series[scoped(`queries_top${top}.new`)], today),
      lost: latest(series[scoped(`queries_top${top}.lost`)], today),
    })),
    topQueries: input.topQueries ?? null,
  } : null;

  const leadsWeeks = weekly(series.leads, from, today, addDays(today, -1));
  const eumonLeadWeeks = weekly(series.leads_eumon, from, today, addDays(today, -1));
  const sumCurrent = (metric: string) => sum(series[metric], google.current);
  const funnelSteps = [
    { label: "Google impressions", value: sumCurrent("eumon_search_impressions") },
    { label: "Google clicks", value: sumCurrent("eumon_search_clicks") },
    { label: "Page views", value: sumCurrent("eumon_page_views") },
    { label: "CTA clicks", value: sumCurrent("eumon_cta_clicks") },
    { label: "Enquiries", value: sumCurrent("leads_eumon") },
  ];

  const speedValue = (metric: SpeedMetric, form: "phone" | "desktop"): SpeedValue => {
    const p75 = latest(series[`crux_${metric}_p75.${form}`], today);
    return { p75, rating: p75 === null ? null : speedRating(metric, p75) };
  };
  const speed = {
    measured: Boolean(series["sync.crux"]?.length),
    metrics: SPEED_METRICS.map((metric) => {
      const phone = series[`crux_${metric}_p75.phone`] ?? [];
      const desktop = series[`crux_${metric}_p75.desktop`] ?? [];
      const days = [...new Set([...phone, ...desktop].map((point) => point.day))].sort();
      const at = (points: DayValue[], day: string) => points.find((point) => point.day === day)?.value ?? null;
      return { metric, phone: speedValue(metric, "phone"), desktop: speedValue(metric, "desktop"), history: days.map((day) => ({ day, phone: at(phone, day), desktop: at(desktop, day) })) };
    }),
  };
  const lab = {
    phone: { home: latest(series["lab_score_home.phone"], today), eumon: latest(series["lab_score_eumon.phone"], today) },
    desktop: { home: latest(series["lab_score_home.desktop"], today), eumon: latest(series["lab_score_eumon.desktop"], today) },
  };
  const authority = {
    site: latest(series.authority, today),
    competitors: (input.competitors ?? []).map((domain) => ({ domain, score: latest(series[`authority:${domain}`], today) })),
    history: series.authority ?? [],
  };

  const keywordLists = input.keywords ?? { site: "", competitors: input.competitors ?? [], synced: false, priced: [], ranked: [] };
  const visibilityRows = [
    { domain: keywordLists.site, traffic: latest(series.kw_traffic, today), top10: latest(series.kw_top10, today) },
    ...(input.competitors ?? []).map((domain) => ({ domain, traffic: latest(series[`kw_traffic:${domain}`], today), top10: latest(series[`kw_top10:${domain}`], today) })),
  ];
  const visibleTotal = visibilityRows.reduce((total, row) => total + (row.traffic ?? 0), 0);
  const keywords = { ...keywordsView(keywordLists), visibility: visibilityRows.map((row) => ({ ...row, share: visibleTotal && row.traffic !== null ? row.traffic / visibleTotal : null })) };

  const ga4Sessions = weekly(series.ga4_organic_sessions, from, today, googleComplete);
  const ga4Events = weekly(series.ga4_organic_key_events, from, today, googleComplete);

  return {
    today, goLive, searchThrough, markets: input.markets, headline,
    numbers: {
      clicks: compare(series[clicksMetric], google),
      leads: compare(series.leads, firstParty),
      leadsSince: series.leads?.[0]?.day ?? null,
      googlebot: compare(series.googlebot_fetches, firstParty),
      organicSessions: input.ga4Connected && series.ga4_organic_sessions?.length ? compare(series.ga4_organic_sessions, google) : null,
      pages: { live: input.published, ...input.index },
    },
    search,
    organic: input.ga4Connected && series.ga4_organic_sessions?.length
      ? ga4Sessions.map((week, index) => ({ week: week.week, sessions: week.value, keyEvents: ga4Events[index]!.value, partial: week.partial }))
      : null,
    leads: {
      weeks: leadsWeeks.map((week, index) => {
        const eumon = eumonLeadWeeks[index]!.value;
        return { week: week.week, eumon, other: week.value === null ? null : week.value - (eumon ?? 0), partial: week.partial };
      }),
      funnel: funnelSteps[0]!.value ? funnelSteps.map((step) => ({ label: step.label, value: step.value ?? 0 })) : null,
    },
    health: {
      value: latest(series.site_health, today),
      day: series.site_health?.length ? series.site_health[series.site_health.length - 1]!.day : null,
    },
    speed, lab, authority, keywords,
  };
}
