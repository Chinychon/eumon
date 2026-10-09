/*
 * The sources the Results sync collects, in the order their notes read. Each
 * one knows its upstream and its points; the runner (results-sync.ts) knows
 * when to run it, writes its marker, and isolates its failures.
 */
import {
  authorityDomain, fetchAuthority, fetchCruxHistory, fetchGa4Daily, fetchLabScore, fetchQueryPositions, fetchSearchDaily, mergePositions, rankingPoints, searchDayPoints, topQueries,
  type FormFactor, type QueryPosition,
} from "@organic-growth/agents";
import { addDays, type SiteRecord } from "@organic-growth/core";
import {
  defaultPageSettings, firstMetricDay, getPageSettings, indexStatusCounts, listSiteCompetitorDomains, listSiteMarkets, pagesToInspect, saveIndexStatus, saveTopQueriesSnapshot,
  syncFirstPartyResults, topEumonPage, type D1Like, type MetricPoint,
} from "@organic-growth/db";
import { ANALYTICS_SCOPE } from "./gsc-auth.ts";
import type { Source } from "./results-sync.ts";
import { inspectSitemapUrls, inspectUrls } from "./url-inspection.ts";

/** Search Console and GA4 history fetched on a site's first sync. */
const BACKFILL_DAYS = 486;
/** URL inspections of Eumon pages per site per day (the API allows 2,000 per property). */
const INSPECTIONS_PER_DAY = 100;
const FORM_FACTORS: FormFactor[] = ["phone", "desktop"];

/** Where Eumon's pages are served. */
async function eumonOrigin(db: D1Like, site: SiteRecord): Promise<{ origin: string; mountPath: string }> {
  const settings = (await getPageSettings(db, site.id)) ?? defaultPageSettings(site.id, site.name, site.baseUrl);
  return { origin: new URL(settings.publicOrigin).origin, mountPath: settings.mountPath };
}

/** Real-user speed from CrUX: 40 weeks the first time, then the latest 2 (the API updates on Mondays). Too few Chrome visits means no points, only the marker. */
const speed: Source = {
  name: "speed", cadence: "weekly", marker: "sync.crux",
  skip: async ({ keys }) => (keys.googleApiKey ? null : "speed: no Google API key"),
  run: async ({ site, keys, fetchFn }, first) => {
    const origin = new URL(site.baseUrl).origin;
    const points = (await Promise.all(FORM_FACTORS.map((form) => fetchCruxHistory(keys.googleApiKey!, origin, form, first ? 40 : 2, fetchFn)))).flat();
    return { points, notes: [`speed: ${first ? 40 : 2} weeks`] };
  },
};

/** Lighthouse scores for the homepage and the Eumon page with the most clicks. A target that fails is left out; a run with no scores is a failure, retried tomorrow. */
const lab: Source = {
  name: "lab", cadence: "weekly", marker: "sync.lab",
  // The missing key is noted once, by speed.
  applies: ({ keys }) => Boolean(keys.googleApiKey),
  run: async ({ db, site, today, keys, fetchFn }) => {
    const { origin } = await eumonOrigin(db, site);
    const eumonPath = await topEumonPage(db, site.id, today);
    const targets = [{ name: "home", url: new URL("/", site.baseUrl).toString() }, ...(eumonPath ? [{ name: "eumon", url: `${origin}${eumonPath}` }] : [])];
    const scored = await Promise.all(targets.flatMap((target) => FORM_FACTORS.map((form) =>
      fetchLabScore(keys.googleApiKey!, target.url, form === "phone" ? "mobile" : "desktop", fetchFn)
        .then((value): MetricPoint | null => ({ metric: `lab_score_${target.name}.${form}`, day: today, value }), () => null))));
    const points = scored.filter((point) => point !== null);
    if (!points.length) throw new Error("PageSpeed Insights answered no scores.");
    return { points, notes: [`lab: ${points.length} scores`] };
  },
};

/** Open PageRank's 0–10 estimate for the site and each competitor. */
const authority: Source = {
  name: "authority", cadence: "weekly", marker: "sync.authority",
  skip: async ({ keys }) => (keys.openPageRankKey ? null : "authority: no Open PageRank key"),
  run: async ({ db, site, today, keys, fetchFn }) => {
    const own = authorityDomain(site.baseUrl);
    const rivals = await listSiteCompetitorDomains(db, site.id);
    const scores = await fetchAuthority(keys.openPageRankKey!, [own, ...rivals], fetchFn);
    return {
      points: scores.map((row) => ({ metric: row.domain === own ? "authority" : `authority:${row.domain}`, day: today, value: row.score })),
      notes: [`authority: ${scores.length} domains`],
    };
  },
};

/** The site's own numbers: leads, Googlebot fetches, page views, CTA clicks, pages published. */
const firstParty: Source = {
  name: "first-party", cadence: "daily",
  run: async ({ db, site, now }) => {
    await syncFirstPartyResults(db, site.id, now);
    return {};
  },
};

/** Search Console daily series: 16 months the first time, then the last 7 days (Google revises recent days). Markets set later backfill on their own marker. */
const search: Source = {
  name: "search", cadence: "daily", marker: "sync.search", google: true,
  applies: ({ site }) => Boolean(site.gscProperty),
  run: async (ctx, first) => {
    const { db, site, today, fetchFn } = ctx;
    const { token } = await ctx.google();
    const property = site.gscProperty!;
    const span = first ? BACKFILL_DAYS : 7;
    const range = { startDate: addDays(today, -span), endDate: addDays(today, -1) };
    const { origin, mountPath } = await eumonOrigin(db, site);
    const markets = await listSiteMarkets(db, site.id);
    const marketSpan = markets.length && !(await firstMetricDay(db, site.id, "sync.search@markets")) ? BACKFILL_DAYS : 7;
    const [all, eumon, ...perMarket] = await Promise.all([
      fetchSearchDaily(token, property, range, fetchFn),
      fetchSearchDaily(token, property, { ...range, pageContains: `${origin}${mountPath}/` }, fetchFn),
      ...markets.map((country) => fetchSearchDaily(token, property, { startDate: addDays(today, -marketSpan), endDate: range.endDate, country }, fetchFn)),
    ]);
    const points = [
      ...searchDayPoints(all),
      ...searchDayPoints(eumon, "eumon_"),
      ...(markets.length ? [...searchDayPoints(perMarket.flat(), "", "@markets"), { metric: "sync.search@markets", day: today, value: perMarket.flat().length }] : []),
    ];
    return { points, notes: [`search: ${span} days`, ...(markets.length ? [`markets: ${marketSpan} days`] : [])] };
  },
};

/** Queries per top-N bucket over the last finalized week beside the week before, for every country and for the target markets. */
const rankings: Source = {
  name: "rankings", cadence: "weekly", marker: "sync.rankings", google: true,
  applies: ({ site }) => Boolean(site.gscProperty),
  run: async (ctx) => {
    const { db, site, today, fetchFn } = ctx;
    const { token } = await ctx.google();
    const property = site.gscProperty!;
    const current = { startDate: addDays(today, -9), endDate: addDays(today, -3) };
    const previous = { startDate: addDays(today, -16), endDate: addDays(today, -10) };
    const markets = await listSiteMarkets(db, site.id);
    const [now7, before7] = await Promise.all([fetchQueryPositions(token, property, current, fetchFn), fetchQueryPositions(token, property, previous, fetchFn)]);
    const points = rankingPoints(now7, before7, today);
    if (markets.length) {
      const scoped = await Promise.all(markets.flatMap((country) => [
        fetchQueryPositions(token, property, { ...current, country }, fetchFn),
        fetchQueryPositions(token, property, { ...previous, country }, fetchFn),
      ]));
      points.push(...rankingPoints(mergePositions(scoped.filter((_, index) => index % 2 === 0).flat()), mergePositions(scoped.filter((_, index) => index % 2 === 1).flat()), today, "@markets"));
    }
    return { points };
  },
};

/** The queries with the most clicks over the last 28 finalized days, each beside the 28 before; scoped to the target markets when set. */
const topQueryList: Source = {
  name: "top queries", cadence: "daily", google: true,
  applies: ({ site }) => Boolean(site.gscProperty),
  run: async (ctx) => {
    const { db, site, today, fetchFn } = ctx;
    const { token } = await ctx.google();
    const property = site.gscProperty!;
    const markets = await listSiteMarkets(db, site.id);
    const queriesIn = async (range: { startDate: string; endDate: string }): Promise<QueryPosition[]> => (markets.length
      ? mergePositions((await Promise.all(markets.map((country) => fetchQueryPositions(token, property, { ...range, country }, fetchFn)))).flat())
      : fetchQueryPositions(token, property, range, fetchFn));
    const last28 = { startDate: addDays(today, -30), endDate: addDays(today, -3) };
    const [recent, earlier] = await Promise.all([queriesIn(last28), queriesIn({ startDate: addDays(today, -58), endDate: addDays(today, -31) })]);
    await saveTopQueriesSnapshot(db, site.id, { property, markets, periodEnd: last28.endDate, rows: topQueries(recent, earlier) });
    return {};
  },
};

/**
 * Google's index status: a rolling sample of published Eumon pages (those
 * checked today are skipped, so a second Sync now spends no quota), then a
 * short pass over sitemap URLs. The daily workflow runs more sitemap rounds.
 */
const inspection: Source = {
  name: "inspection", cadence: "daily", google: true,
  applies: ({ site }) => Boolean(site.gscProperty),
  run: async (ctx) => {
    const { db, site, today, fetchFn, coverageLimit } = ctx;
    const { token } = await ctx.google();
    const property = site.gscProperty!;
    const { origin } = await eumonOrigin(db, site);
    const pages = await pagesToInspect(db, site.id, INSPECTIONS_PER_DAY, today);
    // A page Google wouldn't inspect today has no row, so it comes up again tomorrow.
    const checked = await inspectUrls(pages, (page) => `${origin}${page.path}`, token, property, fetchFn, (batch) =>
      saveIndexStatus(db, site.id, batch.flatMap(({ entry, result }) => (result ? [{ pageId: entry.pageId, ...result }] : []))));
    const points: MetricPoint[] = [];
    if (pages.length) {
      const counts = await indexStatusCounts(db, site.id);
      points.push({ metric: "pages_indexed", day: today, value: counts.indexed }, { metric: "pages_not_indexed", day: today, value: counts.notIndexed });
    }
    const notes = [`inspected ${checked.inspected} pages`];
    if (checked.refused) return { points, notes: [...notes, `inspection stopped: Google answered ${checked.refused}`] };
    const coverage = await inspectSitemapUrls(db, site.id, property, token, today, coverageLimit, fetchFn);
    if (coverage.inspected || coverage.refused) notes.push(`coverage: inspected ${coverage.inspected}`);
    if (coverage.refused) notes.push(`coverage stopped: Google answered ${coverage.refused}`);
    return { points, notes };
  },
};

/** GA4 sessions and organic key events: 16 months the first time, then the last 7 days. Needs the Analytics scope, granted on reconnect for older connections. */
const analytics: Source = {
  name: "analytics", cadence: "daily", marker: "sync.ga4", google: true,
  applies: ({ site }) => Boolean(site.ga4Property),
  skip: async (ctx) => ((await ctx.google()).scopes.includes(ANALYTICS_SCOPE) ? null : "analytics: reconnect Google"),
  run: async (ctx, first) => {
    const { site, today, fetchFn } = ctx;
    const { token } = await ctx.google();
    const span = first ? BACKFILL_DAYS : 7;
    const days = await fetchGa4Daily(token, site.ga4Property!, addDays(today, -span), addDays(today, -1), fetchFn);
    return {
      points: days.flatMap((day) => [
        { metric: "ga4_sessions", day: day.day, value: day.sessions },
        { metric: "ga4_organic_sessions", day: day.day, value: day.organicSessions },
        { metric: "ga4_organic_engaged_sessions", day: day.day, value: day.organicEngagedSessions },
        { metric: "ga4_organic_key_events", day: day.day, value: day.organicKeyEvents },
      ]),
      notes: [`analytics: ${span} days`],
    };
  },
};

export const SOURCES: Source[] = [speed, lab, authority, firstParty, search, rankings, topQueryList, inspection, analytics];
