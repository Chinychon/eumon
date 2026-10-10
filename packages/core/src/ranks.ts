import { addDays } from "./dates.js";

/*
 * Rank tracking, pure: the searches the user names, checked daily per target
 * market, and what the card and the ledger make of the checks. A null
 * position means the site wasn't in the ten results fetched.
 */

export const TRACKED_KEYWORDS_MAX = 30;
/** Days of history the card's series shows. */
export const RANK_SERIES_DAYS = 90;

export const normalizeKeyword = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

export type RankCheck = { keyword: string; market: string; day: string; position: number | null; url: string | null; features: string[] };
export type RankChange = { kind: "none" | "same" | "up" | "down" | "entered" | "left"; places: number };
export type RankRow = {
  keyword: string; market: string; position: number | null; url: string | null; features: string[];
  /** At least one check exists for the pair; an unchecked row's null position means "not checked yet", not "not in the ten". */
  checked: boolean;
  change7: RankChange; change30: RankChange; best: number | null;
  series: Array<{ day: string; position: number | null }>;
};
export type RanksView = { tracked: number; checked: number; top3: number; top10: number; unranked: number; averagePosition: number | null; asOf: string | null; rows: RankRow[] };

/** The position then against now: entered or left the ten, or places gained (positive) or lost. */
function change(then: RankCheck | undefined, now: RankCheck | undefined): RankChange {
  if (!then || !now) return { kind: "none", places: 0 };
  if (then.position === null && now.position === null) return { kind: "same", places: 0 };
  if (then.position === null) return { kind: "entered", places: 0 };
  if (now.position === null) return { kind: "left", places: 0 };
  const places = then.position - now.position;
  return { kind: places > 0 ? "up" : places < 0 ? "down" : "same", places: Math.abs(places) };
}

/** The last check on or before a day (a missed sync leaves a gap). */
const at = (series: RankCheck[], day: string) => series.filter((row) => row.day <= day).at(-1);

export function ranksView(input: { tracked: string[]; markets: string[]; checks: RankCheck[]; today: string }): RanksView {
  const tracked = new Set(input.tracked);
  const markets = new Set(input.markets);
  const bySeries = new Map<string, RankCheck[]>();
  for (const row of input.checks) {
    if (!tracked.has(row.keyword) || !markets.has(row.market)) continue;
    const key = `${row.keyword}|${row.market}`;
    bySeries.set(key, [...(bySeries.get(key) ?? []), row]);
  }
  const rows: RankRow[] = [];
  for (const keyword of input.tracked) {
    for (const market of input.markets) {
      const series = (bySeries.get(`${keyword}|${market}`) ?? []).sort((a, b) => a.day.localeCompare(b.day));
      const latest = series.at(-1);
      const monthAgo = latest ? addDays(latest.day, -30) : input.today;
      const ranked = series.filter((row) => row.day > monthAgo && row.position !== null).map((row) => row.position!);
      rows.push({
        keyword, market, position: latest?.position ?? null, url: latest?.url ?? null, features: latest?.features ?? [], checked: series.length > 0,
        change7: change(latest && at(series, addDays(latest.day, -7)), latest), change30: change(latest && at(series, monthAgo), latest),
        best: ranked.length ? Math.min(...ranked) : null,
        series: series.filter((row) => row.day > addDays(input.today, -RANK_SERIES_DAYS)).map((row) => ({ day: row.day, position: row.position })),
      });
    }
  }
  // Ranked by position, then not in the ten, then never checked.
  rows.sort((a, b) => (a.position ?? (a.checked ? 99 : 100)) - (b.position ?? (b.checked ? 99 : 100)) || a.keyword.localeCompare(b.keyword) || a.market.localeCompare(b.market));
  const checked = rows.filter((row) => row.series.length);
  const positions = checked.filter((row) => row.position !== null).map((row) => row.position!);
  return {
    tracked: input.tracked.length, checked: checked.length,
    top3: positions.filter((position) => position <= 3).length, top10: positions.length, unranked: checked.length - positions.length,
    averagePosition: positions.length ? Math.round((positions.reduce((sum, value) => sum + value, 0) / positions.length) * 10) / 10 : null,
    asOf: checked.map((row) => row.series.at(-1)!.day).sort().at(-1) ?? null,
    rows,
  };
}

/** The day's ledger points from its checks: pairs checked, in the top 3 and 10, not in the ten, and the sum of ranked positions (the reader derives the average). */
export function rankCountPoints(checks: RankCheck[], tracked: string[], markets: string[], day: string): Array<{ metric: string; day: string; value: number }> {
  const view = ranksView({ tracked, markets, checks: checks.filter((row) => row.day === day), today: day });
  const sum = view.rows.filter((row) => row.position !== null).reduce((total, row) => total + row.position!, 0);
  return [
    { metric: "tracked_checked", day, value: view.checked }, { metric: "tracked_top3", day, value: view.top3 }, { metric: "tracked_top10", day, value: view.top10 },
    { metric: "tracked_unranked", day, value: view.unranked }, { metric: "tracked_position_sum", day, value: sum },
  ];
}
