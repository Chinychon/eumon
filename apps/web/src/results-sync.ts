import type { SiteRecord } from "@organic-growth/core";
import { authorityDomain, fetchAuthority, fetchCruxHistory, fetchGa4Daily, fetchLabScore, fetchQueryPositions, fetchSearchDaily, inspectUrl, mergePositions, rankingPoints, searchDayPoints, topQueries, type FormFactor, type QueryPosition } from "@organic-growth/agents";
import { addDays } from "@organic-growth/core";
import {
  defaultPageSettings, firstMetricDay, getPageSettings, indexStatusCounts, listSiteCompetitorDomains, listSiteMarkets, pagesToInspect, topEumonPage,
  saveIndexStatus, saveTopQueriesSnapshot, saveUrlIndexStatus, urlsToInspect, syncFirstPartyResults, upsertMetricPoints, type D1Like, type MetricPoint,
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
export async function syncResults(db: D1Like, site: SiteRecord, now: Date, google: GoogleAccess, keys: SignalKeys = {}, coverageLimit = SYNC_NOW_COVERAGE): Promise<string[]> {
  const today = now.toISOString().slice(0, 10);
  const notes = await syncSignals(db, site, today, now.getUTCDay() === 1, keys, google.fetchFn);
  await syncFirstPartyResults(db, site.id, now);
  if (!site.gscProperty && !site.ga4Property) return notes;
  let token: string;
  let scopes: string[];
  try {
    ({ token, scopes } = await google.connect());
  } catch (error) {
    return [...notes, `google failed: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (site.gscProperty) {
    try {
      notes.push(...await syncSearch(db, site, site.gscProperty, token, today, now, coverageLimit, google.fetchFn));
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

/** API keys for the signals that need no Google sign-in: CrUX and PageSpeed (Google API key), Open PageRank. */
export type SignalKeys = { googleApiKey?: string; openPageRankKey?: string };

const FORM_FACTORS: FormFactor[] = ["phone", "desktop"];

/**
 * Real-user speed (weekly CrUX history: 40 weeks the first time, then the
 * latest 2 on Mondays), Lighthouse lab scores, and authority (both weekly).
 * Each source fails on its own.
 */
async function syncSignals(db: D1Like, site: SiteRecord, today: string, monday: boolean, keys: SignalKeys, fetchFn?: typeof fetch): Promise<string[]> {
  const notes: string[] = [];
  const weekly = async (marker: string) => monday || !(await firstMetricDay(db, site.id, marker));
  if (!keys.googleApiKey) notes.push("speed: no Google API key");
  else {
    if (await weekly("sync.crux")) {
      try {
        const first = !(await firstMetricDay(db, site.id, "sync.crux"));
        const origin = new URL(site.baseUrl).origin;
        const points = (await Promise.all(FORM_FACTORS.map((form) => fetchCruxHistory(keys.googleApiKey!, origin, form, first ? 40 : 2, fetchFn)))).flat();
        await upsertMetricPoints(db, site.id, [...points, { metric: "sync.crux", day: today, value: points.length }]);
        notes.push(`speed: ${first ? 40 : 2} weeks`);
      } catch (error) {
        notes.push(`speed failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (await weekly("lab_score_home.phone")) {
      const settings = (await getPageSettings(db, site.id)) ?? defaultPageSettings(site.id, site.name, site.baseUrl);
      const eumonPath = await topEumonPage(db, site.id, today);
      const targets = [
        { name: "home", url: new URL("/", site.baseUrl).toString() },
        ...(eumonPath ? [{ name: "eumon", url: `${new URL(settings.publicOrigin).origin}${eumonPath}` }] : []),
      ];
      const scored = await Promise.all(targets.flatMap((target) => FORM_FACTORS.map(async (form) => {
        try {
          return { metric: `lab_score_${target.name}.${form}`, day: today, value: await fetchLabScore(keys.googleApiKey!, target.url, form === "phone" ? "mobile" : "desktop", fetchFn) };
        } catch {
          return null;
        }
      })));
      const points = scored.filter((point) => point !== null);
      await upsertMetricPoints(db, site.id, points);
      notes.push(`lab: ${points.length} scores`);
    }
  }
  if (!keys.openPageRankKey) notes.push("authority: no Open PageRank key");
  else if (await weekly("authority")) {
    try {
      const own = authorityDomain(site.baseUrl);
      const rivals = await listSiteCompetitorDomains(db, site.id);
      const scores = await fetchAuthority(keys.openPageRankKey, [own, ...rivals], fetchFn);
      await upsertMetricPoints(db, site.id, scores.map((row) => ({ metric: row.domain === own ? "authority" : `authority:${row.domain}`, day: today, value: row.score })));
      notes.push(`authority: ${scores.length} domains`);
    } catch (error) {
      notes.push(`authority failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return notes;
}

/** URL inspections per daily-workflow step (up to nine a day). */
export const COVERAGE_STEP = 200;
/** URL inspections in a "Sync now": batches of ten wait on Google's slowest answer, so 50 keeps the button to about half a minute. */
const SYNC_NOW_COVERAGE = 50;

/**
 * Asks Google about the next sitemap URLs (unchecked first, then those last
 * checked over 30 days ago), ten at a time. A URL Google won't inspect (for
 * example one outside the property) is recorded as ERROR, so it waits 30 days
 * like a checked one instead of blocking the queue. The day stops on a refusal:
 * quota (429), a revoked token (401), or a whole batch refused (403).
 */
export async function inspectSitemapUrls(
  db: D1Like, siteId: string, property: string, token: string, today: string, limit: number, fetchFn?: typeof fetch,
): Promise<{ inspected: number; refused: number | null; remaining: boolean }> {
  const queue = await urlsToInspect(db, siteId, limit, addDays(today, -30));
  let refused: number | null = null;
  let inspected = 0;
  for (let start = 0; start < queue.length && refused === null; start += 10) {
    const batch = await Promise.all(queue.slice(start, start + 10).map(async (entry) => {
      try {
        return { entry, row: { ...entry, ...await inspectUrl(token, property, entry.url, fetchFn) }, status: 0, message: "" };
      } catch (error) {
        return { entry, row: null, status: (error as { status?: number }).status ?? 0, message: error instanceof Error ? error.message : String(error) };
      }
    }));
    const rows = batch.flatMap((result) => (result.row ? [result.row] : []));
    const failed = batch.filter((result) => !result.row);
    const stop = failed.find((result) => result.status === 429 || result.status === 401)
      ?? (failed.length === batch.length && failed.every((result) => result.status === 403) ? failed[0] : undefined);
    if (stop) refused = stop.status;
    const errors = stop ? [] : failed.map((result) => ({ ...result.entry, verdict: "ERROR", coverageState: result.message.slice(0, 300), lastCrawlTime: null }));
    await saveUrlIndexStatus(db, siteId, [...rows, ...errors]);
    inspected += rows.length;
  }
  return { inspected, refused, remaining: queue.length === limit && refused === null };
}

/**
 * One of the daily workflow's extra coverage steps: true while URLs remain.
 * Any failure (revoked access, a database error) ends this site's rounds
 * quietly, so the workflow moves on to the next site.
 */
export async function coverageRound(db: D1Like, siteId: string, property: string, google: GoogleAccess, today: string, limit = COVERAGE_STEP): Promise<boolean> {
  try {
    const { token } = await google.connect();
    return (await inspectSitemapUrls(db, siteId, property, token, today, limit, google.fetchFn)).remaining;
  } catch {
    return false;
  }
}

/** Whether a source has synced before: its marker, or (for sites synced before markers existed) its data. */
async function synced(db: D1Like, siteId: string, marker: string, data: string): Promise<boolean> {
  return Boolean((await firstMetricDay(db, siteId, marker)) ?? (await firstMetricDay(db, siteId, data)));
}

async function syncSearch(db: D1Like, site: SiteRecord, property: string, token: string, today: string, now: Date, coverageLimit: number, fetchFn?: typeof fetch): Promise<string[]> {
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

  // Sitemap URLs: a short step here; the daily workflow runs more (see SearchSyncWorkflow).
  const coverageNotes: string[] = [];
  if (refused === null) {
    const coverage = await inspectSitemapUrls(db, site.id, property, token, today, coverageLimit, fetchFn);
    if (coverage.inspected || coverage.refused) coverageNotes.push(`coverage: inspected ${coverage.inspected}`);
    if (coverage.refused) coverageNotes.push(`coverage stopped: Google answered ${coverage.refused}`);
  }
  return [`search: ${span} days`, ...(markets.length ? [`markets: ${marketSpan} days`] : []), `inspected ${inspected.length} pages`, ...(refused ? [`inspection stopped: Google answered ${refused}`] : []), ...coverageNotes];
}
