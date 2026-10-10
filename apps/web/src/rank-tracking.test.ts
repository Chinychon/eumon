import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SerpResult } from "@organic-growth/core";
import { getSite, getSnapshot, listMetricSeries, listRankChecks, saveRankChecks, setSiteMarkets, setTrackedKeywords, upsertSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { checkRanks, rankQueue, slices, RANK_STEP, writeRankCounts } from "./rank-tracking.ts";

const today = "2026-10-07";
const at = `${today}T04:15:00.000Z`;
const auth = { login: "me", password: "pw" };

async function site(markets: string[], keywords: string[]) {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
  await setSiteMarkets(db, "s", markets);
  await setTrackedKeywords(db, "s", keywords);
  return { db, record: (await getSite(db, "s"))! };
}

/** DataForSEO stand-in: the site ranks at the position the keyword's trailing number says, or not at all; `fails` names a keyword that errors. */
function serpStub(fails?: string) {
  const asked: string[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const task = JSON.parse(String(init?.body))[0] as { keyword: string; location_code: number };
    asked.push(`${task.keyword}@${task.location_code}`);
    if (task.keyword === fails) return new Response(JSON.stringify({ status_code: 40000, status_message: "bad", tasks: [] }));
    const position = Number(/(\d+)$/.exec(task.keyword)?.[1] ?? 0);
    const items = Array.from({ length: 10 }, (_, index) => ({ type: "organic", rank_group: index + 1, domain: index + 1 === position ? "x.com" : `r${index}.example`, url: `https://${index + 1 === position ? "x.com" : `r${index}.example`}/p`, title: "t" }));
    return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, cost: 0.004, result: [{ item_types: ["organic", "local_pack"], items }] }] }));
  }) as typeof fetch;
  return { asked, fetchFn };
}

describe("rank tracking steps", () => {
  it("queues every tracked keyword in every covered market, skipping an uncovered market with a note and pairs already checked today", async () => {
    const { db, record } = await site(["mys", "mmr"], ["kw 3", "kw 0"]);
    await saveRankChecks(db, "s", [{ keyword: "kw 0", market: "mys", day: today, position: null, url: null, features: [] }]);
    const queue = await rankQueue(db, record, today);
    assert.deepEqual(queue.targets, [{ keyword: "kw 3", market: "mys" }]);
    assert.ok(queue.notes.some((note) => note.includes("mmr")), queue.notes.join("; "));
  });

  it("checks a slice, saves the day's rows, refreshes the serp snapshot row, and goes on past a failing keyword", async () => {
    const { db, record } = await site(["mys"], ["kw 3", "kw 0", "kw bad"]);
    const { asked, fetchFn } = serpStub("kw bad");
    const result = await checkRanks(db, record, auth, today, [{ keyword: "kw 3", market: "mys" }, { keyword: "kw 0", market: "mys" }, { keyword: "kw bad", market: "mys" }], fetchFn);
    assert.equal(result.checked, 2);
    assert.ok(result.notes.some((note) => note.includes("kw bad")), result.notes.join("; "));
    assert.equal(asked.length, 3);
    const rows = await listRankChecks(db, "s", today);
    assert.deepEqual(rows.map((row) => [row.keyword, row.position, row.url, row.features]), [["kw 0", null, null, ["local_pack"]], ["kw 3", 3, "https://x.com/p", ["local_pack"]]]);
    const serp = (await getSnapshot<SerpResult>(db, "s", "serp", "mys"))!;
    assert.deepEqual(serp.rows.map((row) => [row.keyword, row.position, row.checkedAt]).sort(), [["kw 0", null, today], ["kw 3", 3, today]]);
  });

  it("writes the day's counts and the marker", async () => {
    const { db, record } = await site(["mys"], ["kw 3", "kw 0"]);
    await checkRanks(db, record, auth, today, [{ keyword: "kw 3", market: "mys" }, { keyword: "kw 0", market: "mys" }], serpStub().fetchFn);
    await writeRankCounts(db, record, today);
    const series = await listMetricSeries(db, "s", ["sync.ranks", "tracked_checked", "tracked_top3", "tracked_top10", "tracked_unranked", "tracked_position_sum"], today, today);
    assert.deepEqual(Object.fromEntries(Object.entries(series).map(([metric, points]) => [metric, points[0]?.value])), { "sync.ranks": 5, tracked_checked: 2, tracked_top3: 1, tracked_top10: 1, tracked_unranked: 1, tracked_position_sum: 3 });
  });

  it("cuts slices that never mix markets, so a step's subrequests don't grow with the market count", async () => {
    const { db, record } = await site(["mys", "sgp"], ["kw 1", "kw 2", "kw 3"]);
    const cut = slices((await rankQueue(db, record, today)).targets);
    assert.equal(cut.length, 2);
    assert.ok(cut.every((slice) => new Set(slice.map((target) => target.market)).size === 1));
    const many = Array.from({ length: 41 }, (_, index) => ({ keyword: `k${index}`, market: "mys" }));
    assert.deepEqual(slices(many).map((slice) => slice.length), [40, 1]);
  });

  it("the step size is 40", () => { assert.equal(RANK_STEP, 40); });
});
