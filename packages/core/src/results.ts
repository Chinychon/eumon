/*
 * Results math: windows, weeks, and comparisons over ledger series. Pure, so
 * the API, the client link, and the tests all compute the same numbers.
 */

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

/** Weekly sums from the week of `from` to the week of `to`; weeks ending after `complete` are partial. */
export function weekly(series: DayValue[] | undefined, from: string, to: string, complete: string) {
  const sums = new Map<string, number>();
  for (const point of series ?? []) {
    if (point.day < from || point.day > to) continue;
    const week = weekStart(point.day);
    sums.set(week, (sums.get(week) ?? 0) + point.value);
  }
  const weeks: Array<{ week: string; value: number | null; partial: boolean }> = [];
  for (let week = weekStart(from); week <= to; week = addDays(week, 7)) {
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

/** Every metric the Results view reads. */
export const RESULT_METRICS = [
  ...SEARCH, ...SEARCH.map((metric) => `${metric}@markets`), ...SEARCH.map((metric) => `eumon_${metric}`),
  ...BUCKET_METRICS, ...BUCKET_METRICS.map((metric) => `${metric}@markets`),
  "leads", "leads_eumon", "googlebot_fetches", "eumon_page_views", "eumon_cta_clicks", "published_pages",
  "ga4_sessions", "ga4_organic_sessions", "ga4_organic_engaged_sessions", "ga4_organic_key_events",
  "site_health", "crawl_urls", "crawl_empty_shells", "crawl_http_errors", "crawl_noindex",
];

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
};

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
    organicSessions: Compare | null;
    pages: { live: number; indexed: number; notIndexed: number; unchecked: number };
  };
  search: {
    weeks: Array<{ week: string; clicks: number | null; impressions: number | null; partial: boolean }>;
    clicksAllCountries: Compare | null;
    ctr: Compare;
    position: Compare;
    buckets: Array<{ top: number; queries: number | null; added: number | null; lost: number | null }>;
  } | null;
  organic: Array<{ week: string; sessions: number | null; keyEvents: number | null; partial: boolean }> | null;
  leads: {
    weeks: Array<{ week: string; eumon: number | null; other: number | null; partial: boolean }>;
    funnel: Array<{ label: string; value: number }> | null;
  };
  health: { value: number | null; day: string | null };
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
    ctr: ratio(series[clicksMetric], series[scoped("search_impressions")], google),
    position: ratio(series[scoped("search_position_weight")], series[scoped("search_impressions")], google),
    buckets: RANK_BUCKETS.map((top) => ({
      top,
      queries: latest(series[scoped(`queries_top${top}`)], today),
      added: latest(series[scoped(`queries_top${top}.new`)], today),
      lost: latest(series[scoped(`queries_top${top}.lost`)], today),
    })),
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

  const ga4Sessions = weekly(series.ga4_organic_sessions, from, today, googleComplete);
  const ga4Events = weekly(series.ga4_organic_key_events, from, today, googleComplete);

  return {
    today, goLive, searchThrough, markets: input.markets, headline,
    numbers: {
      clicks: compare(series[clicksMetric], google),
      leads: compare(series.leads, firstParty),
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
  };
}
