import { addDays, countryName, createId, severityFromImpact, type Finding, type JsonObject, type KeywordDemand, type Opportunity, type RankCheck, type SearchMetricRow, SERP_FEATURES } from "@organic-growth/core";
import { listRankChecks, listSiteMarkets, listTrackedKeywords, type D1Like } from "@organic-growth/db";
import { expectedCtr } from "@organic-growth/pages";
import { estimateDemand } from "./demand.js";

/*
 * What rank tracking adds to an analysis: a finding when a tracked keyword
 * falls or drops out of the ten, and an opportunity when a tracked keyword
 * is off the first page but Search Console still sees it within reach.
 */

export type RankSignals = { tracked: string[]; markets: string[]; checks: RankCheck[]; today: string };

/**
 * Thresholds, with their reasons. A finding stays while the keyword is still
 * down, so History says "Resolved" only when it recovers (or its checks leave
 * the 90 days read):
 * - Fell: today's position is FALL_PLACES or more below a check in the 90
 *   days. The best is the best position in the BEST_WINDOW_DAYS up to the
 *   latest such check, and the fall began the day after the last check at
 *   that best. Back within FALL_PLACES − 1 places of the best, it is gone.
 * - Dropped out: today's check is not in the ten, and the keyword's most
 *   recent run of ranked checks (anywhere in the 90 days) lasted HELD_DAYS
 *   or more with a best of BEST_AT_MOST or better. A fall that ends out of
 *   the ten is only this finding.
 */
export const RANKS = {
  /** Days of checks read: how long a finding can stay while the keyword is still down. */
  LOOKBACK_DAYS: 90,
  /** Days before the fall began that its best position is taken from. */
  BEST_WINDOW_DAYS: 30,
  /** A fall under this many places is noise between Google's data centres. */
  FALL_PLACES: 5,
  /** A best past this was never a real ranking to lose. With ten results fetched every best is 10 or better, so it only matters if the depth is raised. */
  BEST_AT_MOST: 20,
  /** A keyword must have held a position this many days before "dropped out" means anything. */
  HELD_DAYS: 7,
  MAX_FINDINGS: 5,
  /** Search Console average position (28 days) within which an unranked tracked keyword is worth a push. */
  GSC_POSITION_AT_MOST: 30,
};

const label = (feature: string) => SERP_FEATURES.find((entry) => entry.feature === feature)?.label ?? feature;
const path = (url: string | null) => (url ? new URL(url).pathname : "no page");

/** Reads one keyword's checks in one market, oldest first, within the lookback. */
function seriesOf(signals: RankSignals): Map<string, RankCheck[]> {
  const tracked = new Set(signals.tracked);
  const since = addDays(signals.today, -RANKS.LOOKBACK_DAYS);
  const map = new Map<string, RankCheck[]>();
  for (const row of signals.checks) {
    if (!tracked.has(row.keyword) || !signals.markets.includes(row.market) || row.day < since) continue;
    const key = `${row.keyword}|${row.market}`;
    map.set(key, [...(map.get(key) ?? []), row].sort((a, b) => a.day.localeCompare(b.day)));
  }
  return map;
}

export function findingsFromRanks(input: { siteId: string; analysisId: string; ranks: RankSignals | null | undefined }): Finding[] {
  if (!input.ranks) return [];
  const drafts: Array<{ impact: number; title: string; summary: string; evidence: JsonObject; pagesAffected: string[] }> = [];
  for (const series of seriesOf(input.ranks).values()) {
    if (series.length < 2) continue;
    const latest = series.at(-1)!;
    const market = countryName(latest.market);
    // The checks the best is taken from: before the fall, or the run that ended out of the ten.
    let window: RankCheck[];
    if (latest.position !== null) {
      const now = latest.position;
      const lastGood = [...series].reverse().find((row) => row.position !== null && now - row.position >= RANKS.FALL_PLACES);
      if (!lastGood) continue;
      window = series.filter((row) => row.day >= addDays(lastGood.day, -RANKS.BEST_WINDOW_DAYS) && row.day <= lastGood.day);
    } else {
      const lastRanked = [...series].reverse().find((row) => row.position !== null);
      if (!lastRanked) continue;
      const end = series.indexOf(lastRanked);
      let start = end;
      while (start > 0 && series[start - 1]!.position !== null) start--;
      window = series.slice(start, end + 1);
    }
    const ranked = window.filter((row) => row.position !== null);
    const best = Math.min(...ranked.map((row) => row.position!));
    if (best > RANKS.BEST_AT_MOST) continue;
    const bestRow = ranked.find((row) => row.position === best)!;
    const lastBest = [...ranked].reverse().find((row) => row.position === best)!;
    const since = series[series.indexOf(lastBest) + 1]!.day;
    const appeared = latest.features.filter((feature) => !bestRow.features.includes(feature)).map(label);
    const pages = `The page was ${path(bestRow.url)} then and ${path(latest.url)} now${bestRow.url && latest.url && bestRow.url !== latest.url ? ": Google swapped the page it shows" : ""}.`;
    const since_ = appeared.length ? ` Since then the results page gained ${appeared.join(", ")}, which pushes the links down.` : "";
    const evidence: JsonObject = { keyword: latest.keyword, market: latest.market, best, now: latest.position, since, pageThen: bestRow.url, pageNow: latest.url };
    if (latest.position !== null) {
      const places = latest.position - best;
      drafts.push({
        impact: Math.min(80, 35 + 2 * places + (best <= 3 ? 15 : 0)),
        title: `“${latest.keyword}” fell from ${best} to ${latest.position} in ${market} since ${since}`,
        summary: `Google's position for “${latest.keyword}” in ${market} was ${best} on ${bestRow.day} and is ${latest.position} on ${latest.day}. ${pages}${since_}`,
        evidence, pagesAffected: [latest.url ?? bestRow.url].filter((url): url is string => Boolean(url)),
      });
    } else {
      const held = window.length;
      if (held < RANKS.HELD_DAYS) continue;
      const lastRanked = window.at(-1)!;
      const left = series[series.indexOf(lastRanked) + 1]!.day;
      drafts.push({
        impact: Math.min(80, 35 + 2 * (11 - best) + (best <= 3 ? 15 : 0)),
        title: `“${latest.keyword}” dropped out of the top 10 in ${market} since ${left}`,
        summary: `Google's position for “${latest.keyword}” in ${market} was ${best} at best (${lastRanked.position} on ${lastRanked.day}) and the site is not in the ten results on ${latest.day}. ${pages}${since_}`,
        evidence: { ...evidence, since: left, held }, pagesAffected: [lastRanked.url].filter((url): url is string => Boolean(url)),
      });
    }
  }
  const createdAt = new Date().toISOString();
  return drafts.sort((a, b) => b.impact - a.impact).slice(0, RANKS.MAX_FINDINGS).map((draft) => ({
    id: createId("finding"), siteId: input.siteId, analysisId: input.analysisId, category: "search", severity: severityFromImpact(draft.impact),
    title: draft.title, summary: draft.summary, evidence: draft.evidence, organicImpactScore: draft.impact,
    recommendation: "Compare the page with the top three on today's results page (the Keywords tab shows them), check that it still answers the search and loads quickly, and strengthen its title and the internal links to it. History records the recovery.",
    pagesAffected: draft.pagesAffected, createdAt,
  }));
}

/** Tracked keywords not in today's ten that Search Console still sees at 30 or better, unless an opportunity already names them. */
export function rankOpportunities(input: { siteId: string; analysisId: string; ranks: RankSignals | null | undefined; searchMetrics: SearchMetricRow[]; existing: Opportunity[]; demand?: KeywordDemand }): Opportunity[] {
  if (!input.ranks) return [];
  const named = new Set(input.existing.map((opportunity) => /“(.+?)”/.exec(opportunity.title)?.[1]?.toLowerCase()).filter(Boolean));
  const made: Opportunity[] = [];
  for (const [key, series] of seriesOf(input.ranks)) {
    const [keyword, market] = key.split("|") as [string, string];
    if (series.at(-1)!.position !== null || named.has(keyword)) continue;
    const rows = input.searchMetrics.filter((row) => row.query.toLowerCase() === keyword && row.country.toLowerCase() === market);
    const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
    if (!impressions) continue;
    const position = rows.reduce((sum, row) => sum + row.position * row.impressions, 0) / impressions;
    if (position > RANKS.GSC_POSITION_AT_MOST) continue;
    const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
    const estimate = estimateDemand({ kind: "ranking", query: keyword, position, impressions }, input.demand);
    made.push({
      id: createId("opp"), siteId: input.siteId, analysisId: input.analysisId,
      title: `Move “${keyword}” onto the first page in ${countryName(market)} (tracked; Search Console average position ${position.toFixed(1)})`,
      searchDemand: estimate.searchDemand, estimatedDifficulty: estimate.estimatedDifficulty, intent: "ranking (tracked keyword)",
      currentRank: Math.round(position * 10) / 10, competitorStrength: 0, currentPage: rows.sort((a, b) => b.impressions - a.impressions)[0]?.page,
      businessValue: 1.2, conversionPotential: 1, technicalEffort: 1, contentEffort: 2,
      priorityScore: Number((impressions * expectedCtr(3) / 2).toFixed(2)),
      rationale: `You chose to track “${keyword}”; Google's page for it in ${countryName(market)} doesn't show the site in the top 10, while Search Console reports ${impressions.toLocaleString("en")} impressions and ${clicks.toLocaleString("en")} clicks at average position ${position.toFixed(1)} over 28 days. A page already in reach of the first page.${estimate.priced ? ` ${estimate.priced}` : ""}`,
    });
  }
  return made;
}

/** What the analysis reads: the tracked list, the target markets, and 90 days of checks; null when nothing is tracked. */
export async function loadRankSignals(db: D1Like, siteId: string, today = new Date().toISOString().slice(0, 10)): Promise<RankSignals | null> {
  const tracked = await listTrackedKeywords(db, siteId);
  if (!tracked.length) return null;
  const [markets, checks] = await Promise.all([listSiteMarkets(db, siteId), listRankChecks(db, siteId, addDays(today, -RANKS.LOOKBACK_DAYS))]);
  return { tracked, markets, checks, today };
}
