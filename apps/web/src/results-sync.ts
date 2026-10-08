import type { SiteRecord } from "@organic-growth/core";
import { fetchGa4Daily, fetchQueryPositions, fetchSearchDaily, inspectUrl, mergePositions, rankingPoints, searchDayPoints, topQueries, type QueryPosition } from "@organic-growth/agents";
import { addDays } from "@organic-growth/core";
import {
  defaultPageSettings, firstMetricDay, getPageSettings, indexStatusCounts, listSiteMarkets, pagesToInspect,
  saveIndexStatus, saveTopQueriesSnapshot, syncFirstPartyResults, upsertMetricPoints, type D1Like, type MetricPoint,
} from "@organic-growth/db";
import { ANALYTICS_SCOPE } from "./gsc-auth.ts";

/** Connects to Google only when a Google step runs; the token and the scopes it was granted come together. */
export type GoogleAccess = { connect: () => Promise<{ token: string; scopes: string[] }>; fetchFn?: typeof fetch };

/** Search Console and GA4 history fetched on a site's first sync. */
const BACKFILL_DAYS = 486;
/** URL inspections per site per day (the API allows 2,000 per property). */
const INSPECTIONS_PER_DAY = 100;

/**
 * One site's daily Results sync: first-party points always, then Search
 * Console (daily series, Monday ranking buckets, index status) and GA4.
 * Each Google step fails on its own; the notes say what ran.
 */
export async function syncResults(db: D1Like, site: SiteRecord, now: Date, google: GoogleAccess): Promise<string[]> {
  const notes: string[] = [];
  await syncFirstPartyResults(db, site.id, now);
  if (!site.gscProperty && !site.ga4Property) return notes;
  let token: string;
  let scopes: string[];
  try {
    ({ token, scopes } = await google.connect());
  } catch (error) {
    return [...notes, `google failed: ${error instanceof Error ? error.message : String(error)}`];
  }
  const today = now.toISOString().slice(0, 10);
  if (site.gscProperty) {
    try {
      notes.push(...await syncSearch(db, site, site.gscProperty, token, today, now, google.fetchFn));
    } catch (error) {
      notes.push(`search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (site.ga4Property) {
    if (!scopes.includes(ANALYTICS_SCOPE)) notes.push("analytics: reconnect Google");
    else {
      try {
        const span = (await synced(db, site.id, "sync.ga4", "ga4_sessions")) ? 7 : BACKFILL_DAYS;
        const days = await fetchGa4Daily(token, site.ga4Property, addDays(today, -span), addDays(today, -1), google.fetchFn);
        await upsertMetricPoints(db, site.id, [...days.flatMap((day) => [
          { metric: "ga4_sessions", day: day.day, value: day.sessions },
          { metric: "ga4_organic_sessions", day: day.day, value: day.organicSessions },
          { metric: "ga4_organic_engaged_sessions", day: day.day, value: day.organicEngagedSessions },
          { metric: "ga4_organic_key_events", day: day.day, value: day.organicKeyEvents },
        ]), { metric: "sync.ga4", day: today, value: days.length }]);
        notes.push(`analytics: ${span} days`);
      } catch (error) {
        notes.push(`analytics failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return notes;
}

/** Whether a source has synced before: its marker, or (for sites synced before markers existed) its data. */
async function synced(db: D1Like, siteId: string, marker: string, data: string): Promise<boolean> {
  return Boolean((await firstMetricDay(db, siteId, marker)) ?? (await firstMetricDay(db, siteId, data)));
}

async function syncSearch(db: D1Like, site: SiteRecord, property: string, token: string, today: string, now: Date, fetchFn?: typeof fetch): Promise<string[]> {
  const span = (await synced(db, site.id, "sync.search", "search_clicks")) ? 7 : BACKFILL_DAYS;
  const range = { startDate: addDays(today, -span), endDate: addDays(today, -1) };
  const settings = (await getPageSettings(db, site.id)) ?? defaultPageSettings(site.id, site.name, site.baseUrl);
  const origin = new URL(settings.publicOrigin).origin;
  const markets = await listSiteMarkets(db, site.id);
  // Markets can be set (or changed, which clears them) after the first sync, so their history backfills on its own.
  const marketSpan = markets.length && !(await synced(db, site.id, "sync.search@markets", "search_clicks@markets")) ? BACKFILL_DAYS : 7;
  const marketRange = { startDate: addDays(today, -marketSpan), endDate: range.endDate };
  const [all, eumon, ...perMarket] = await Promise.all([
    fetchSearchDaily(token, property, range, fetchFn),
    fetchSearchDaily(token, property, { ...range, pageContains: `${origin}${settings.mountPath}/` }, fetchFn),
    ...markets.map((country) => fetchSearchDaily(token, property, { ...marketRange, country }, fetchFn)),
  ]);
  const points: MetricPoint[] = [
    // "Synced" markers, so a property with no rows yet doesn't re-run the 16-month backfill every day.
    { metric: "sync.search", day: today, value: all.length },
    ...(markets.length ? [{ metric: "sync.search@markets", day: today, value: perMarket.flat().length }] : []),
    ...searchDayPoints(all),
    ...searchDayPoints(eumon, "eumon_"),
    ...(markets.length ? searchDayPoints(perMarket.flat(), "", "@markets") : []),
  ];

  // Ranking buckets weekly (Mondays), or now if none exist yet; finalized data only.
  if (now.getUTCDay() === 1 || !(await firstMetricDay(db, site.id, "queries_top10"))) {
    const current = { startDate: addDays(today, -9), endDate: addDays(today, -3) };
    const previous = { startDate: addDays(today, -16), endDate: addDays(today, -10) };
    const [now7, before7] = await Promise.all([fetchQueryPositions(token, property, current, fetchFn), fetchQueryPositions(token, property, previous, fetchFn)]);
    points.push(...rankingPoints(now7, before7, today));
    if (markets.length) {
      const scoped = await Promise.all(markets.flatMap((country) => [
        fetchQueryPositions(token, property, { ...current, country }, fetchFn),
        fetchQueryPositions(token, property, { ...previous, country }, fetchFn),
      ]));
      points.push(...rankingPoints(mergePositions(scoped.filter((_, index) => index % 2 === 0).flat()), mergePositions(scoped.filter((_, index) => index % 2 === 1).flat()), today, "@markets"));
    }
  }

  // Top queries: the last 28 finalized days beside the 28 before, scoped to target markets when set.
  const last28 = { startDate: addDays(today, -30), endDate: addDays(today, -3) };
  const prior28 = { startDate: addDays(today, -58), endDate: addDays(today, -31) };
  const queriesIn = async (range: typeof last28): Promise<QueryPosition[]> => (markets.length
    ? mergePositions((await Promise.all(markets.map((country) => fetchQueryPositions(token, property, { ...range, country }, fetchFn)))).flat())
    : fetchQueryPositions(token, property, range, fetchFn));
  const [recent, earlier] = await Promise.all([queriesIn(last28), queriesIn(prior28)]);
  await saveTopQueriesSnapshot(db, site.id, { property, markets, periodEnd: last28.endDate, rows: topQueries(recent, earlier) });

  // Index status: a rolling sample of published Eumon pages each day.
  // Pages already checked today are skipped, so a second Sync now spends no quota.
  const pages = await pagesToInspect(db, site.id, INSPECTIONS_PER_DAY, today);
  const inspected = [];
  let refused: number | null = null;
  // Ten at a time: well under the API's 600 a minute, and "Sync now" answers in seconds rather than minutes.
  for (let start = 0; start < pages.length && refused === null; start += 10) {
    const batch = await Promise.all(pages.slice(start, start + 10).map(async (page) => {
      try {
        return { pageId: page.pageId, ...await inspectUrl(token, property, `${origin}${page.path}`, fetchFn) };
      } catch (error) {
        // Quota or permission refusals stop the run; any other failure leaves that page for tomorrow.
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 403 || status === 429) refused = status;
        return null;
      }
    }));
    inspected.push(...batch.filter((result) => result !== null));
  }
  await saveIndexStatus(db, site.id, inspected);
  if (pages.length) {
    const counts = await indexStatusCounts(db, site.id);
    points.push({ metric: "pages_indexed", day: today, value: counts.indexed }, { metric: "pages_not_indexed", day: today, value: counts.notIndexed });
  }
  await upsertMetricPoints(db, site.id, points);
  return [`search: ${span} days`, ...(markets.length ? [`markets: ${marketSpan} days`] : []), `inspected ${inspected.length} pages`, ...(refused ? [`inspection stopped: Google answered ${refused}`] : [])];
}
