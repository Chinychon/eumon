/*
 * The sync sources beyond Google: who wins the site's searches and what their
 * results pages look like (DataForSEO SERP), link profiles and the link gap
 * (DataForSEO Backlinks), Bing Webmaster Tools, IndexNow submissions, and the
 * upkeep of the crawl log the site's servers send.
 */
import {
  authorityDomain, DataForSeoError, fetchBacklinkSummary, fetchBingCrawlStats, fetchBingTraffic, fetchLinkGap, fetchSerp, fetchSerpCompetitors, indexNowKey, submitIndexNow,
} from "@organic-growth/agents";
import { addDays, keywordGaps, type BacklinkSummary, type PricedKeyword, type RankedKeyword, type SerpResult } from "@organic-growth/core";
import {
  changedPagePaths, defaultPageSettings, firstCrawlLogDay, getPageSettings, listCrawlLogDays, listSiteCompetitorDomains, listSiteMarkets, listSnapshotDates, listSnapshots, listTrackedKeywords,
  pruneCrawlLog, saveSnapshot, getSnapshot, type MetricPoint,
} from "@organic-growth/db";
import type { Source, SyncContext } from "./results-sync.ts";
import { dollars, FRESH_DAYS, marketLocation, noMarkets, said } from "./source-helpers.ts";

/** Results pages fetched per sync, across markets: about $0.004 each, and well inside the Workers Free plan's 50 subrequests. */
const SERPS_PER_SYNC = 10;
/** Searches whose results page is kept per market: the site's biggest priced queries, then the biggest keyword gaps. */
const SERP_OWN = 20;
const SERP_GAPS = 10;

const pageLanguage = async ({ db, site }: SyncContext) => ((await getPageSettings(db, site.id)) ?? defaultPageSettings(site.id, site.name, site.baseUrl)).language;

/** The covered target markets, with a note for each one DataForSEO doesn't cover (competitor keywords already says so, so it's quiet here). */
async function coveredMarkets(ctx: SyncContext): Promise<string[]> {
  return (await listSiteMarkets(ctx.db, ctx.site.id)).filter((market) => marketLocation(market) !== null);
}

/** One market's keyword lists: the site's priced queries and every domain's ranked keywords. */
async function marketLists(ctx: SyncContext, market: string) {
  const own = authorityDomain(ctx.site.baseUrl);
  const competitors = await listSiteCompetitorDomains(ctx.db, ctx.site.id);
  const domains = new Set([own, ...competitors]);
  const [priced, ranked] = await Promise.all([
    listSnapshots<PricedKeyword>(ctx.db, ctx.site.id, "keywords"),
    listSnapshots<RankedKeyword>(ctx.db, ctx.site.id, "competitor_keywords"),
  ]);
  const pricedRows = priced.filter((list) => list.scope === `${ctx.site.gscProperty}|${market}`).flatMap((list) => list.rows);
  const rankedLists = ranked.filter((list) => list.scope.endsWith(`|${market}`) && domains.has(list.scope.split("|")[0]!))
    .map((list) => ({ domain: list.scope.split("|")[0]!, periodEnd: list.periodEnd, rows: list.rows }));
  return { own, competitors, pricedRows, rankedLists };
}

/**
 * The domains that rank for the site's searches in each covered market:
 * DataForSEO's `serp_competitors` over the site's 200 biggest priced queries
 * (or, without Search Console, its own ranked keywords). One call per market,
 * refreshed monthly like the keyword lists; the Competitors tab suggests the
 * strongest it doesn't list yet.
 */
const serpCompetitors: Source = {
  name: "search competitors", cadence: "daily", marker: "sync.serp_competitors",
  applies: ({ keys }) => Boolean(keys.dataForSeo),
  skip: noMarkets("search competitors"),
  run: async (ctx) => {
    const { db, site, today, keys, fetchFn } = ctx;
    const dates = await listSnapshotDates(db, site.id, "serp_competitors");
    const staleBefore = addDays(today, -FRESH_DAYS);
    const language = await pageLanguage(ctx);
    const notes: string[] = [];
    let due = 0;
    let fetched = 0;
    let cost = 0;
    const tracked = await listTrackedKeywords(db, site.id);
    for (const market of await coveredMarkets(ctx)) {
      if ((dates[market] ?? "") > staleBefore) continue;
      due++;
      const { own, pricedRows, rankedLists } = await marketLists(ctx, market);
      const seeds = (pricedRows.length
        ? pricedRows.filter((row) => (row.volume ?? 0) > 0).sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
        : (rankedLists.find((list) => list.domain === own)?.rows ?? []).sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
      ).map((row) => row.keyword.toLowerCase());
      const keywords = [...new Set(seeds)].slice(0, 200);
      if (keywords.length < 3) {
        notes.push(`search competitors skipped ${market}: too few priced keywords yet`);
        continue;
      }
      try {
        const answer = await fetchSerpCompetitors(keys.dataForSeo!, keywords, marketLocation(market)!, language, fetchFn);
        await saveSnapshot(db, site.id, { kind: "serp_competitors", scope: market, periodEnd: today, rows: answer.rows });
        fetched++;
        cost += answer.cost;
      } catch (error) {
        notes.push(`search competitors skipped ${market}: ${said(error)}`);
      }
    }
    return { notes: [due ? `search competitors: ${fetched} of ${due} markets fetched, ${dollars(cost)}` : "search competitors: lists fresh", ...notes] };
  },
};

/** The searches whose results page is worth keeping in a market: the site's biggest priced queries on the first three pages, then the biggest keyword gaps. */
export function serpTargets(lists: Awaited<ReturnType<typeof marketLists>>): Array<{ keyword: string; volume: number | null }> {
  const own = lists.pricedRows.filter((row) => (row.volume ?? 0) > 0 && row.position <= 30)
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0)).slice(0, SERP_OWN);
  const gaps = keywordGaps({ site: lists.own, competitors: lists.competitors, synced: true, priced: [{ periodEnd: "", rows: lists.pricedRows }], ranked: lists.rankedLists })
    .filter((gap) => gap.intent !== "navigational").slice(0, SERP_GAPS);
  const seen = new Set<string>();
  return [...own, ...gaps].flatMap((row) => {
    const key = row.keyword.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ keyword: row.keyword, volume: row.volume }];
  });
}

/**
 * Google's first page for the searches that matter in each market: who ranks,
 * which result types take the clicks, and whether an AI Overview cites the
 * site. Up to SERPS_PER_SYNC pages per sync, oldest first; each page is
 * checked again after FRESH_DAYS, so a month of daily syncs keeps every list
 * current. Searches no longer targeted drop out of the list; tracked keywords'
 * pages (rank tracking writes them daily) stay.
 */
const serpResults: Source = {
  name: "search results", cadence: "daily", marker: "sync.serp",
  applies: ({ keys }) => Boolean(keys.dataForSeo),
  skip: noMarkets("search results"),
  run: async (ctx) => {
    const { db, site, today, keys, fetchFn } = ctx;
    const language = await pageLanguage(ctx);
    const staleBefore = addDays(today, -FRESH_DAYS);
    const notes: string[] = [];
    let budget = SERPS_PER_SYNC;
    let targeted = 0;
    let fetched = 0;
    let cost = 0;
    const tracked = await listTrackedKeywords(db, site.id);
    for (const market of await coveredMarkets(ctx)) {
      const lists = await marketLists(ctx, market);
      const targets = serpTargets(lists);
      targeted += targets.length;
      const kept = new Map(((await getSnapshot<SerpResult>(db, site.id, "serp", market))?.rows ?? []).map((row) => [row.keyword.toLowerCase(), row]));
      const due = targets.filter((target) => (kept.get(target.keyword.toLowerCase())?.checkedAt ?? "") <= staleBefore)
        .sort((a, b) => (kept.get(a.keyword.toLowerCase())?.checkedAt ?? "").localeCompare(kept.get(b.keyword.toLowerCase())?.checkedAt ?? ""));
      let changed = false;
      for (const target of due) {
        if (budget <= 0) break;
        budget--;
        try {
          const answer = await fetchSerp(keys.dataForSeo!, { keyword: target.keyword, location: marketLocation(market)!, language, site: lists.own, checkedAt: today, volume: target.volume }, fetchFn);
          kept.set(target.keyword.toLowerCase(), answer.row);
          fetched++;
          cost += answer.cost;
          changed = true;
        } catch (error) {
          notes.push(`search results skipped “${target.keyword}” in ${market}: ${said(error)}`);
        }
      }
      const wanted = new Set([...targets.map((target) => target.keyword.toLowerCase()), ...tracked]);
      const rows = [...kept.entries()].filter(([key]) => wanted.has(key)).map(([, row]) => row);
      if (changed || rows.length !== kept.size) await saveSnapshot(db, site.id, { kind: "serp", scope: market, periodEnd: today, rows });
    }
    // Counts over every current list, so the trend holds between refreshes.
    const markets = await coveredMarkets(ctx);
    const current = (await listSnapshots<SerpResult>(db, site.id, "serp")).filter((list) => markets.includes(list.scope)).flatMap((list) => list.rows);
    const points: MetricPoint[] = current.length ? [
      { metric: "serp_ai_overviews", day: today, value: current.filter((row) => row.features.includes("ai_overview")).length },
      { metric: "serp_ai_cited", day: today, value: current.filter((row) => row.cited).length },
    ] : [];
    const summary = !targeted ? "search results: no searches to check until keyword lists are synced" : fetched ? `search results: ${fetched} pages checked, ${dollars(cost)}` : notes.length ? "search results: none checked" : "search results: pages fresh";
    return { points, notes: [summary, ...notes] };
  },
};

/** DataForSEO answers 40204 (and 402 or 403 over HTTP) when the Backlinks API isn't active on the account. */
const notActive = (error: unknown) => error instanceof DataForSeoError && (error.code === 40204 || error.code === 402 || error.code === 403);

/**
 * Link profiles for the site and each competitor, and the link gap: sites
 * linking to the competitors (up to three) but not to the site. Each list is
 * refreshed monthly; about $0.03 per profile and $0.03 for the gap.
 */
const backlinks: Source = {
  name: "backlinks", cadence: "daily", marker: "sync.backlinks",
  applies: ({ keys }) => Boolean(keys.dataForSeo),
  run: async ({ db, site, today, keys, fetchFn }) => {
    const own = authorityDomain(site.baseUrl);
    const competitors = await listSiteCompetitorDomains(db, site.id);
    const dates = await listSnapshotDates(db, site.id, "backlinks");
    const staleBefore = addDays(today, -FRESH_DAYS);
    const points: MetricPoint[] = [];
    const notes: string[] = [];
    let due = 0;
    let fetched = 0;
    let cost = 0;
    for (const domain of [own, ...competitors]) {
      if ((dates[domain] ?? "") > staleBefore) continue;
      due++;
      try {
        const answer = await fetchBacklinkSummary(keys.dataForSeo!, domain, fetchFn);
        await saveSnapshot<BacklinkSummary>(db, site.id, { kind: "backlinks", scope: domain, periodEnd: today, rows: [answer.row] });
        const suffix = domain === own ? "" : `:${domain}`;
        points.push(
          { metric: `backlinks${suffix}`, day: today, value: answer.row.backlinks },
          { metric: `ref_domains${suffix}`, day: today, value: answer.row.referringMainDomains },
          { metric: `backlink_rank${suffix}`, day: today, value: answer.row.rank },
        );
        fetched++;
        cost += answer.cost;
      } catch (error) {
        if (notActive(error)) return { notes: ["backlinks: the Backlinks API isn't active on this DataForSEO account (app.dataforseo.com → Backlinks API)"] };
        notes.push(`backlinks skipped ${domain}: ${said(error)}`);
      }
    }
    const gapScope = competitors.slice(0, 3).sort().join(",");
    if (gapScope && ((await listSnapshotDates(db, site.id, "link_gap"))[gapScope] ?? "") <= staleBefore) {
      due++;
      try {
        const answer = await fetchLinkGap(keys.dataForSeo!, competitors, own, fetchFn);
        await saveSnapshot(db, site.id, { kind: "link_gap", scope: gapScope, periodEnd: today, rows: answer.rows });
        fetched++;
        cost += answer.cost;
      } catch (error) {
        if (notActive(error)) return { points, notes: ["backlinks: the Backlinks API isn't active on this DataForSEO account (app.dataforseo.com → Backlinks API)"] };
        notes.push(`link gap skipped: ${said(error)}`);
      }
    }
    return { points, notes: [due ? `backlinks: ${fetched} of ${due} lists fetched, ${dollars(cost)}` : "backlinks: lists fresh", ...notes] };
  },
};

/** Bing's name for a site: the address it was verified with, with its trailing slash. */
export const bingSiteUrl = (baseUrl: string) => `${new URL(baseUrl).origin}/`;

/**
 * Bing Webmaster Tools: clicks and impressions per day (about six months the
 * first time, then the last 14 days, which Bing revises) and crawl counts.
 * The key belongs to a Bing account in which the site is verified.
 */
const bing: Source = {
  name: "bing", cadence: "daily", marker: "sync.bing",
  applies: ({ keys }) => Boolean(keys.bingApiKey),
  run: async ({ site, today, keys, fetchFn }, first) => {
    const siteUrl = bingSiteUrl(site.baseUrl);
    const [traffic, crawl] = await Promise.all([
      fetchBingTraffic(keys.bingApiKey!, siteUrl, fetchFn),
      fetchBingCrawlStats(keys.bingApiKey!, siteUrl, fetchFn).catch(() => null),
    ]);
    const since = first ? "0000" : addDays(today, -14);
    const points: MetricPoint[] = [
      ...traffic.filter((row) => row.day >= since && row.day < today).flatMap((row) => [
        { metric: "bing_clicks", day: row.day, value: row.clicks },
        { metric: "bing_impressions", day: row.day, value: row.impressions },
      ]),
      ...(crawl ?? []).filter((row) => row.day >= since && row.day < today).flatMap((row) => [
        { metric: "bing_crawled_pages", day: row.day, value: row.crawledPages },
        { metric: "bing_crawl_errors", day: row.day, value: row.crawlErrors },
        { metric: "bing_in_index", day: row.day, value: row.inIndex },
      ]),
    ];
    return { points, notes: [`bing: ${first ? `${traffic.length} days` : "14 days"}`, ...(crawl ? [] : ["bing: crawl stats failed"])] };
  },
};

/**
 * Tells IndexNow (Bing, Yandex, Seznam, Naver and others) about Eumon pages
 * published, changed or taken down since the last submission; every live
 * page the first time (and for a new public origin). The key file is served inside Eumon's mount path, so
 * it vouches only for Eumon's pages, and only once the proxy is verified.
 */
const indexNow: Source = {
  name: "indexnow", cadence: "daily", marker: "sync.indexnow",
  applies: ({ keys }) => Boolean(keys.indexNowSecret),
  skip: async ({ db, site }) => ((await getPageSettings(db, site.id))?.verifiedAt ? null : "indexnow: waiting for the proxy to be verified in Setup"),
  run: async ({ db, site, today, now, keys, fetchFn }) => {
    const settings = (await getPageSettings(db, site.id))!;
    const origin = new URL(settings.publicOrigin).origin;
    // The last submission's moment, kept as a snapshot's date: page changes carry timestamps, the ledger only days.
    const since = (await getSnapshot(db, site.id, "indexnow", origin))?.periodEnd ?? null;
    const paths = await changedPagePaths(db, site.id, since);
    if (!paths.length) return { notes: ["indexnow: nothing changed"] };
    const key = await indexNowKey(keys.indexNowSecret!, site.id);
    const sent = await submitIndexNow({ host: new URL(origin).host, key, keyLocation: `${origin}${settings.mountPath}/${key}.txt`, urls: paths.map((path) => `${origin}${path}`) }, fetchFn);
    await saveSnapshot(db, site.id, { kind: "indexnow", scope: origin, periodEnd: now.toISOString(), rows: [] });
    return { points: [{ metric: "indexnow_submitted", day: today, value: sent.submitted }], notes: [`indexnow: ${sent.submitted} URLs submitted`] };
  },
};

/** Day rows are kept 16 months, like the ledger; a path not requested for 120 days is forgotten. */
const LOG_DAYS = 486;
const LOG_PATH_DAYS = 120;

/** The crawl log needs no fetching (servers send it); the sync says what yesterday brought and prunes old rows. */
const crawlLog: Source = {
  name: "crawl log", cadence: "daily",
  run: async ({ db, site, today }) => {
    if (!(await firstCrawlLogDay(db, site.id))) return {};
    const yesterday = addDays(today, -1);
    const rows = await listCrawlLogDays(db, site.id, yesterday);
    const count = (bot: string) => rows.filter((row) => row.day === yesterday && row.bot === bot).reduce((sum, row) => sum + row.hits, 0);
    await pruneCrawlLog(db, site.id, { pathsBefore: addDays(today, -LOG_PATH_DAYS), daysBefore: addDays(today, -LOG_DAYS) });
    return { notes: [`crawl log: ${count("googlebot")} Googlebot and ${count("bingbot")} Bingbot requests yesterday`] };
  },
};

export const CONNECTOR_SOURCES: Source[] = [serpCompetitors, serpResults, backlinks, bing, indexNow, crawlLog];
