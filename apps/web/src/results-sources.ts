/*
 * The sources the Results sync collects, in the order their notes read. Each
 * one knows its upstream and its points; the runner (results-sync.ts) knows
 * when to run it, writes its marker, and isolates its failures.
 */
import {
  authorityDomain, dataForSeoLocation, fetchAuthority, fetchCruxHistory, fetchGa4AiReferrals, fetchGa4Daily, fetchKeywordOverview, fetchLabScore, fetchQueryPositions, fetchRankedKeywords, fetchSearchDaily,
  ga4AiPoints, mergePositions, questionPoints, rankingPoints, searchDayPoints, topQueries, type FormFactor, type QueryPosition,
} from "@organic-growth/agents";
import { addDays, countryNumeric, type PricedKeyword, type RankedKeyword, type SiteRecord } from "@organic-growth/core";
import {
  defaultPageSettings, firstMetricDay, getPageSettings, indexStatusCounts, listSiteCompetitorDomains, listSiteMarkets, listSnapshotDates, listSnapshots, pagesToInspect, saveIndexStatus,
  saveSnapshot, saveTopQueriesSnapshot, syncFirstPartyResults, topEumonPage, type D1Like, type MetricPoint,
} from "@organic-growth/db";
import { ANALYTICS_SCOPE } from "./gsc-auth.ts";
import type { Source, SyncContext } from "./results-sync.ts";
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

/**
 * The queries with the most clicks over the last 28 finalized days, each
 * beside the 28 before; scoped to the target markets when set. The same list
 * gives the question-search counts, at no extra request.
 */
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
    return { points: questionPoints(recent, last28.endDate) };
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

/**
 * GA4 sessions and organic key events, and sessions AI assistants sent:
 * 16 months the first time, then the last 7 days. Needs the Analytics scope,
 * granted on reconnect for older connections. A day GA4 reports with no AI
 * session is a real 0.
 */
const analytics: Source = {
  name: "analytics", cadence: "daily", marker: "sync.ga4", google: true,
  applies: ({ site }) => Boolean(site.ga4Property),
  skip: async (ctx) => ((await ctx.google()).scopes.includes(ANALYTICS_SCOPE) ? null : "analytics: reconnect Google"),
  run: async (ctx, first) => {
    const { site, today, fetchFn } = ctx;
    const { token } = await ctx.google();
    const span = first ? BACKFILL_DAYS : 7;
    const [start, end] = [addDays(today, -span), addDays(today, -1)];
    const [days, aiDays] = await Promise.all([
      fetchGa4Daily(token, site.ga4Property!, start, end, fetchFn),
      fetchGa4AiReferrals(token, site.ga4Property!, start, end, fetchFn).catch(() => null),
    ]);
    const ai = aiDays ? ga4AiPoints(aiDays) : [];
    const aiTotals = new Set(ai.filter((point) => point.metric === "ga4_ai_sessions").map((point) => point.day));
    return {
      points: [
        ...days.flatMap((day) => [
          { metric: "ga4_sessions", day: day.day, value: day.sessions },
          { metric: "ga4_organic_sessions", day: day.day, value: day.organicSessions },
          { metric: "ga4_organic_engaged_sessions", day: day.day, value: day.organicEngagedSessions },
          { metric: "ga4_organic_key_events", day: day.day, value: day.organicKeyEvents },
          ...(aiDays && !aiTotals.has(day.day) ? [{ metric: "ga4_ai_sessions", day: day.day, value: 0 }, { metric: "ga4_ai_key_events", day: day.day, value: 0 }] : []),
        ]),
        ...ai,
      ],
      notes: [`analytics: ${span} days`, ...(aiDays ? [] : ["analytics: AI referrals failed"])],
    };
  },
};

/** DataForSEO's location for a target market, or null for a country it doesn't cover. */
const marketLocation = (market: string): number | null => {
  const numeric = countryNumeric(market);
  return numeric === null ? null : dataForSeoLocation(numeric);
};

const noMarkets = (name: string) => async ({ db, site }: SyncContext) => ((await listSiteMarkets(db, site.id)).length ? null : `${name}: set target markets in Setup`);

/** A keyword list is refreshed when it is missing or this many days old, so a new competitor or market is fetched on the next sync and nothing fresh is paid for twice. */
const FRESH_DAYS = 28;
const dollars = (cost: number) => `$${cost.toFixed(2)}`;
const said = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Every domain's organic keywords in each covered target market, the site's
 * own first: the lists behind keyword gaps and share of visibility. One
 * DataForSEO call per list that is missing or FRESH_DAYS old; a domain or
 * market that fails is noted and tried again next sync. The trend points are
 * recomputed from every current list whenever one was fetched.
 *
 * Budget: up to (competitors + 1) × markets calls in one sync, in sequence;
 * the Workers Free plan allows 50 subrequests per invocation.
 */
const competitorKeywords: Source = {
  name: "competitor keywords", cadence: "daily", marker: "sync.competitor_keywords",
  applies: ({ keys }) => Boolean(keys.dataForSeo),
  skip: noMarkets("competitor keywords"),
  run: async ({ db, site, today, keys, fetchFn }) => {
    const notes: string[] = [];
    const markets = (await listSiteMarkets(db, site.id)).filter((market) => {
      if (marketLocation(market) !== null) return true;
      notes.push(`competitor keywords skipped ${market}: not covered by DataForSEO`);
      return false;
    });
    const own = authorityDomain(site.baseUrl);
    const domains = [...new Set([own, ...(await listSiteCompetitorDomains(db, site.id))])];
    const dates = await listSnapshotDates(db, site.id, "competitor_keywords");
    const staleBefore = addDays(today, -FRESH_DAYS);
    let fetched = 0;
    let cost = 0;
    for (const market of markets) {
      for (const domain of domains) {
        const scope = `${domain}|${market}`;
        if ((dates[scope] ?? "") > staleBefore) continue;
        try {
          const answer = await fetchRankedKeywords(keys.dataForSeo!, domain, marketLocation(market)!, fetchFn);
          await saveSnapshot(db, site.id, { kind: "competitor_keywords", scope, periodEnd: today, rows: answer.rows });
          fetched++;
          cost += answer.cost;
        } catch (error) {
          notes.push(`competitor keywords skipped ${domain} in ${market}: ${said(error)}`);
        }
      }
    }
    if (!markets.length) return { notes: ["competitor keywords: no covered markets", ...notes] };
    if (!fetched) return { notes: ["competitor keywords: lists fresh", ...notes] };
    // Trend points from every current list, so a month with one failed list still sums what it has.
    const totals = new Map<string, { top10: number; traffic: number }>();
    for (const list of await listSnapshots<RankedKeyword>(db, site.id, "competitor_keywords")) {
      const [domain, market] = list.scope.split("|") as [string, string];
      if (!domains.includes(domain) || !markets.includes(market)) continue;
      const sum = totals.get(domain) ?? { top10: 0, traffic: 0 };
      sum.top10 += list.rows.filter((row) => row.position <= 10).length;
      sum.traffic += list.rows.reduce((total, row) => total + row.traffic, 0);
      totals.set(domain, sum);
    }
    const points = [...totals].flatMap(([domain, sum]) => {
      const suffix = domain === own ? "" : `:${domain}`;
      return [{ metric: `kw_top10${suffix}`, day: today, value: sum.top10 }, { metric: `kw_traffic${suffix}`, day: today, value: Math.round(sum.traffic) }];
    });
    return { points, notes: [`competitor keywords: ${fetched} lists fetched, ${domains.length} domains in ${markets.length} markets, ${dollars(cost)}`, ...notes] };
  },
};

/**
 * The site's Search Console queries of the last 28 finalized days in each
 * covered market, up to 700 by impressions, priced by DataForSEO in the page
 * language. One list per market, refreshed when missing or FRESH_DAYS old; a
 * market with no queries yet, or whose call fails, is noted and tried again
 * next sync. Every query is kept; one DataForSEO doesn't know has no volume.
 */
const keywordVolumes: Source = {
  name: "keyword volumes", cadence: "daily", marker: "sync.keyword_volumes", google: true,
  applies: ({ keys, site }) => Boolean(keys.dataForSeo && site.gscProperty),
  skip: noMarkets("keyword volumes"),
  run: async (ctx) => {
    const { db, site, today, keys, fetchFn } = ctx;
    const { token } = await ctx.google();
    const property = site.gscProperty!;
    const { language } = (await getPageSettings(db, site.id)) ?? defaultPageSettings(site.id, site.name, site.baseUrl);
    const range = { startDate: addDays(today, -30), endDate: addDays(today, -3) };
    const dates = await listSnapshotDates(db, site.id, "keywords");
    const staleBefore = addDays(today, -FRESH_DAYS);
    const notes: string[] = [];
    let due = 0;
    let listed = 0;
    let priced = 0;
    let cost = 0;
    for (const market of await listSiteMarkets(db, site.id)) {
      const location = marketLocation(market);
      if (location === null) continue; // noted by competitor keywords
      if ((dates[`${property}|${market}`] ?? "") > staleBefore) continue;
      due++;
      try {
        const queries = (await fetchQueryPositions(token, property, { ...range, country: market }, fetchFn)).sort((a, b) => b.impressions - a.impressions).slice(0, 700);
        if (!queries.length) {
          notes.push(`keyword volumes skipped ${market}: no Search Console queries yet`);
          continue;
        }
        const answer = await fetchKeywordOverview(keys.dataForSeo!, queries.map((query) => query.query.toLowerCase()), location, language, fetchFn);
        const prices = new Map(answer.rows.map((row) => [row.keyword, row]));
        const rows: PricedKeyword[] = queries.map((query) => {
          const price = prices.get(query.query.toLowerCase());
          return { keyword: query.query, volume: price?.volume ?? null, difficulty: price?.difficulty ?? null, intent: price?.intent ?? null, position: query.position, clicks: query.clicks, impressions: query.impressions };
        });
        await saveSnapshot(db, site.id, { kind: "keywords", scope: `${property}|${market}`, periodEnd: range.endDate, rows });
        listed += rows.length;
        priced += prices.size;
        cost += answer.cost;
      } catch (error) {
        notes.push(`keyword volumes skipped ${market}: ${said(error)}`);
      }
    }
    return { notes: [due ? `keyword volumes: ${listed} queries listed, ${priced} priced, ${dollars(cost)}` : "keyword volumes: lists fresh", ...notes] };
  },
};

export const SOURCES: Source[] = [speed, lab, authority, firstParty, search, rankings, topQueryList, inspection, analytics, competitorKeywords, keywordVolumes];
