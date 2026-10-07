import type { SiteRecord } from "@organic-growth/core";
import { fetchGa4Daily, fetchQueryPositions, fetchSearchDaily, inspectUrl, mergePositions, rankingPoints, searchDayPoints } from "@organic-growth/agents";
import { addDays } from "@organic-growth/core";
import {
  defaultPageSettings, firstMetricDay, getPageSettings, indexStatusCounts, listSiteMarkets, pagesToInspect,
  saveIndexStatus, syncFirstPartyResults, upsertMetricPoints, type D1Like, type MetricPoint,
} from "@organic-growth/db";
import { ANALYTICS_SCOPE } from "./gsc-auth.ts";

export type GoogleAccess = { token: () => Promise<string>; scopes: string[]; fetchFn?: typeof fetch };

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
  try {
    token = await google.token();
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
    if (!google.scopes.includes(ANALYTICS_SCOPE)) notes.push("analytics: reconnect Google");
    else {
      try {
        const backfill = !(await firstMetricDay(db, site.id, "ga4_sessions"));
        const days = await fetchGa4Daily(token, site.ga4Property, addDays(today, backfill ? -BACKFILL_DAYS : -7), addDays(today, -1), google.fetchFn);
        await upsertMetricPoints(db, site.id, days.flatMap((day) => [
          { metric: "ga4_sessions", day: day.day, value: day.sessions },
          { metric: "ga4_organic_sessions", day: day.day, value: day.organicSessions },
          { metric: "ga4_organic_engaged_sessions", day: day.day, value: day.organicEngagedSessions },
          { metric: "ga4_organic_key_events", day: day.day, value: day.organicKeyEvents },
        ]));
        notes.push(`analytics: ${days.length} days`);
      } catch (error) {
        notes.push(`analytics failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return notes;
}

async function syncSearch(db: D1Like, site: SiteRecord, property: string, token: string, today: string, now: Date, fetchFn?: typeof fetch): Promise<string[]> {
  const backfill = !(await firstMetricDay(db, site.id, "search_clicks"));
  const span = backfill ? BACKFILL_DAYS : 7;
  const range = { startDate: addDays(today, -span), endDate: addDays(today, -1) };
  const settings = (await getPageSettings(db, site.id)) ?? defaultPageSettings(site.id, site.name, site.baseUrl);
  const origin = new URL(settings.publicOrigin).origin;
  const markets = await listSiteMarkets(db, site.id);
  const [all, eumon, ...perMarket] = await Promise.all([
    fetchSearchDaily(token, property, range, fetchFn),
    fetchSearchDaily(token, property, { ...range, pageContains: `${origin}${settings.mountPath}/` }, fetchFn),
    ...markets.map((country) => fetchSearchDaily(token, property, { ...range, country }, fetchFn)),
  ]);
  const points: MetricPoint[] = [
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

  // Index status: a rolling sample of published Eumon pages each day.
  const pages = await pagesToInspect(db, site.id, INSPECTIONS_PER_DAY);
  const inspected = [];
  for (const page of pages) {
    try {
      inspected.push({ pageId: page.pageId, ...await inspectUrl(token, property, `${origin}${page.path}`, fetchFn) });
    } catch {
      // One page's failure (quota, a transient error) leaves it for tomorrow.
    }
  }
  await saveIndexStatus(db, site.id, inspected);
  if (pages.length) {
    const counts = await indexStatusCounts(db, site.id);
    points.push({ metric: "pages_indexed", day: today, value: counts.indexed }, { metric: "pages_not_indexed", day: today, value: counts.notIndexed });
  }
  await upsertMetricPoints(db, site.id, points);
  return [`search: ${span} days`, `inspected ${inspected.length} pages`];
}
