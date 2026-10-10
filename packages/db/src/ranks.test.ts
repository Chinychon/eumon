import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openSqliteD1 } from "./sqlite.js";
import { upsertSite } from "./index.js";
import { checkedPairsOn, listRankChecks, listTrackedKeywords, pruneRankChecks, saveRankChecks, setTrackedKeywords } from "./ranks.js";
import type { RankCheck } from "@organic-growth/core";

const at = "2026-10-07T04:15:00.000Z";
async function site() {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
  return db;
}
const check = (keyword: string, day: string, position: number | null, market = "mys"): RankCheck => ({ keyword, market, day, position, url: position ? "https://x.com/p" : null, features: position ? ["local_pack"] : [] });

describe("rank tracking store", () => {
  it("replaces the tracked list", async () => {
    const db = await site();
    await setTrackedKeywords(db, "s", ["dental implants", "braces price"]);
    await setTrackedKeywords(db, "s", ["braces price"]);
    assert.deepEqual(await listTrackedKeywords(db, "s"), ["braces price"]);
  });

  it("upserts checks: saving a day twice keeps one row, with the later values", async () => {
    const db = await site();
    await saveRankChecks(db, "s", [check("braces price", "2026-10-06", 4), check("braces price", "2026-10-07", 5)]);
    await saveRankChecks(db, "s", [check("braces price", "2026-10-07", 3)]);
    const rows = await listRankChecks(db, "s", "2026-10-01");
    assert.deepEqual(rows.map((row) => [row.day, row.position, row.features]), [["2026-10-06", 4, ["local_pack"]], ["2026-10-07", 3, ["local_pack"]]]);
    assert.deepEqual(await checkedPairsOn(db, "s", "2026-10-07"), new Set(["braces price|mys"]));
  });

  it("lists from a day, oldest first, and prunes before a day", async () => {
    const db = await site();
    await saveRankChecks(db, "s", [check("a", "2025-01-01", 1), check("a", "2026-10-06", null), check("a", "2026-10-07", 2)]);
    assert.deepEqual((await listRankChecks(db, "s", "2026-10-06")).map((row) => row.position), [null, 2]);
    await pruneRankChecks(db, "s", "2026-01-01");
    assert.equal((await listRankChecks(db, "s", "2000-01-01")).length, 2);
  });

  it("deleting the site removes keywords and checks", async () => {
    const db = await site();
    await setTrackedKeywords(db, "s", ["a"]);
    await saveRankChecks(db, "s", [check("a", "2026-10-07", 1)]);
    await db.prepare("DELETE FROM sites WHERE id = ?").bind("s").run();
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM tracked_keywords").first<{ n: number }>())!.n, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM rank_checks").first<{ n: number }>())!.n, 0);
  });
});
