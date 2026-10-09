import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crawledPathsSince, firstCrawlLogDay, listCrawlLogDays, pruneCrawlLog, recordCrawlLog } from "./server-logs.js";
import { openSqliteD1 } from "./sqlite.js";

describe("crawl log store", () => {
  it("adds deliveries together, keeps the latest request per path, and prunes", async () => {
    const db = openSqliteD1();
    const day = { day: "2026-10-08", bot: "googlebot", family: "doctors", statusClass: "2xx", query: false, hits: 3 };
    await recordCrawlLog(db, "s1", { days: [day], paths: [{ group: "google", path: "/doctors/a?x=1", lastSeen: "2026-10-08T05:00:00Z", lastStatus: 200, hits: 3 }] });
    await recordCrawlLog(db, "s1", { days: [{ ...day, hits: 2 }, { ...day, day: "2026-06-01" }], paths: [{ group: "google", path: "/doctors/a?x=1", lastSeen: "2026-10-07T05:00:00Z", lastStatus: 500, hits: 1 }] });
    assert.deepEqual((await listCrawlLogDays(db, "s1", "2026-10-01")).map((row) => row.hits), [5]);
    assert.equal(await firstCrawlLogDay(db, "s1"), "2026-06-01");
    const row = await db.prepare("SELECT last_seen, last_status, hits FROM crawl_log_paths").first<{ last_seen: string; last_status: number; hits: number }>();
    assert.deepEqual({ ...row }, { last_seen: "2026-10-08T05:00:00Z", last_status: 200, hits: 4 }, "an older request doesn't replace the latest");
    assert.deepEqual([...await crawledPathsSince(db, "s1", "google", "2026-10-01")], ["/doctors/a"]);
    assert.equal((await crawledPathsSince(db, "s1", "bing", "2026-10-01")).size, 0);
    await pruneCrawlLog(db, "s1", { pathsBefore: "2026-10-08T06:00:00Z", daysBefore: "2026-07-01" });
    assert.equal((await crawledPathsSince(db, "s1", "google", "2000-01-01")).size, 0);
    assert.equal(await firstCrawlLogDay(db, "s1"), "2026-10-08");
  });
});
