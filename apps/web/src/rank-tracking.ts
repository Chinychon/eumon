import { authorityDomain, DEMO_SITE_ID, fetchSerp } from "@organic-growth/agents";
import { addDays, rankCountPoints, type RankCheck, type SerpResult, type SiteRecord } from "@organic-growth/core";
import {
  checkedPairsOn, defaultPageSettings, getPageSettings, getSnapshot, listRankChecks, listSiteMarkets, listTrackedKeywords, pruneRankChecks, saveRankChecks, saveSnapshot, upsertMetricPoints, type D1Like,
} from "@organic-growth/db";
import { dollars, marketLocation, said } from "./source-helpers.ts";
import type { StepOptions } from "./sync-steps.ts";

/*
 * Rank tracking's daily steps: the queue of (keyword, market) pairs not yet
 * checked today, SERP fetches 40 a step (the Free plan allows 50 subrequests
 * a step), and the day's counts. Each check also refreshes the `serp`
 * snapshot row, so the Search results card and the growth plan see today's
 * page without a second fetch.
 */

export const RANK_STEP = 40;
/** Days of checks kept. */
const KEEP_DAYS = 400;
const RANK: StepOptions = { retries: { limit: 1, delay: 30_000 }, timeout: 3 * 60_000 };

export type RankTarget = { keyword: string; market: string };
type Auth = { login: string; password: string };

/** Every tracked keyword in every covered market, minus the pairs already checked today. */
export async function rankQueue(db: D1Like, site: SiteRecord, today: string): Promise<{ targets: RankTarget[]; notes: string[] }> {
  const [keywords, markets, done] = await Promise.all([listTrackedKeywords(db, site.id), listSiteMarkets(db, site.id), checkedPairsOn(db, site.id, today)]);
  const notes: string[] = [];
  const covered = markets.filter((market) => {
    if (marketLocation(market) !== null) return true;
    notes.push(`ranks skipped ${market}: DataForSEO doesn't cover it`);
    return false;
  });
  const targets = keywords.flatMap((keyword) => covered.map((market) => ({ keyword, market }))).filter((target) => !done.has(`${target.keyword}|${target.market}`));
  return { targets, notes };
}

/** One slice of checks: fetch each page, save the rows, and put each page into its market's `serp` list. */
export async function checkRanks(db: D1Like, site: SiteRecord, auth: Auth, today: string, targets: RankTarget[], fetchFn: typeof fetch = fetch): Promise<{ checked: number; cost: number; notes: string[] }> {
  const language = ((await getPageSettings(db, site.id)) ?? defaultPageSettings(site.id, site.name, site.baseUrl)).language;
  const own = authorityDomain(site.baseUrl);
  const notes: string[] = [];
  const rows: RankCheck[] = [];
  const pages = new Map<string, SerpResult[]>();
  let cost = 0;
  for (const target of targets) {
    try {
      const answer = await fetchSerp(auth, { keyword: target.keyword, location: marketLocation(target.market)!, language, site: own, checkedAt: today, volume: null }, fetchFn);
      rows.push({ keyword: target.keyword, market: target.market, day: today, position: answer.row.position, url: answer.row.url, features: answer.row.features });
      pages.set(target.market, [...(pages.get(target.market) ?? []), answer.row]);
      cost += answer.cost;
    } catch (error) {
      notes.push(`ranks skipped “${target.keyword}” in ${target.market}: ${said(error)}`);
    }
  }
  await saveRankChecks(db, site.id, rows);
  for (const [market, results] of pages) {
    const kept = new Map(((await getSnapshot<SerpResult>(db, site.id, "serp", market))?.rows ?? []).map((row) => [row.keyword.toLowerCase(), row]));
    // The keyword list's volume is kept when the page was already there; a tracked keyword outside the lists has none.
    for (const row of results) kept.set(row.keyword.toLowerCase(), { ...row, volume: kept.get(row.keyword.toLowerCase())?.volume ?? null });
    await saveSnapshot(db, site.id, { kind: "serp", scope: market, periodEnd: today, rows: [...kept.values()] });
  }
  return { checked: rows.length, cost, notes };
}

/** The day's ledger points and the marker, then the prune. */
export async function writeRankCounts(db: D1Like, site: SiteRecord, today: string): Promise<void> {
  const [checks, keywords, markets] = await Promise.all([listRankChecks(db, site.id, today), listTrackedKeywords(db, site.id), listSiteMarkets(db, site.id)]);
  const points = rankCountPoints(checks, keywords, markets, today);
  await upsertMetricPoints(db, site.id, [...points, { metric: "sync.ranks", day: today, value: points.length }]);
  await pruneRankChecks(db, site.id, addDays(today, -KEEP_DAYS));
}

type Safe = <T>(name: string, fn: () => Promise<T>, options?: StepOptions) => Promise<{ ok: T } | { error: string }>;

/** The step group for one site: queue, 40 checks a step, counts. Returns the run's notes. */
export async function trackRanks(db: D1Like, safe: Safe, site: SiteRecord, auth: Auth, today: string, fetchFn?: typeof fetch): Promise<string[]> {
  if (site.id === DEMO_SITE_ID) return [];
  const queue = await safe("ranks-queue", () => rankQueue(db, site, today));
  if ("error" in queue) return [`ranks failed: ${queue.error}`];
  const notes = [...queue.ok.notes];
  if (!queue.ok.targets.length) return notes;
  let checked = 0;
  let cost = 0;
  let steps = 0;
  for (let offset = 0, round = 1; offset < queue.ok.targets.length; offset += RANK_STEP, round++) {
    const slice = queue.ok.targets.slice(offset, offset + RANK_STEP);
    const result = await safe(`ranks-${round}`, () => checkRanks(db, site, auth, today, slice, fetchFn), RANK);
    if ("error" in result) { notes.push(`ranks failed: ${result.error}`); break; }
    steps++;
    checked += result.ok.checked;
    cost += result.ok.cost;
    notes.push(...result.ok.notes);
  }
  if (checked) {
    notes.unshift(`ranks: ${checked} checked in ${steps} step${steps === 1 ? "" : "s"}, ${dollars(cost)}`);
    const counts = await safe("ranks-counts", () => writeRankCounts(db, site, today));
    if ("error" in counts) notes.push(`ranks counts failed: ${counts.error}`);
  }
  return notes;
}
