import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { insertConversionEvent, isProblemNote, listRecentEvents, listSyncRuns, recordLandingSession, recordSyncRun, upsertSite } from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

const now = "2026-10-09T00:00:00.000Z";

describe("activity", async () => {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });

  it("keeps the latest syncs newest first, with their notes, and drops the oldest past 30", async () => {
    for (let i = 0; i < 32; i++) {
      const at = new Date(Date.parse(now) + i * 60_000).toISOString();
      await recordSyncRun(db, { id: `run${i}`, siteId: "s", trigger: i % 2 ? "manual" : "daily", startedAt: at, finishedAt: at, notes: i === 31 ? ["speed: 2 weeks", "analytics failed: 403"] : ["speed: 2 weeks"] });
    }
    const runs = await listSyncRuns(db, "s", 50);
    assert.equal(runs.length, 30);
    assert.equal(runs[0]!.id, "run31");
    assert.deepEqual(runs[0]!.notes, ["speed: 2 weeks", "analytics failed: 403"]);
    assert.equal(runs.at(-1)!.id, "run2");
    assert.equal(isProblemNote("analytics failed: 403"), true);
    assert.equal(isProblemNote("inspection stopped: Google answered 429"), true);
    assert.equal(isProblemNote("speed: no Google API key"), false);
  });

  it("lists the latest events and whether the visitor first landed on an Eumon page", async () => {
    await recordLandingSession(db, { siteId: "s", sessionId: "a".repeat(16), pageId: "p1", source: "search" });
    await insertConversionEvent(db, { id: "e1", siteId: "s", event: "whatsapp_click", occurredAt: "2026-10-08T01:00:00Z", sessionId: "a".repeat(16), pageUrl: "https://x.com/contact" });
    await insertConversionEvent(db, { id: "e2", siteId: "s", event: "form_submit", occurredAt: "2026-10-08T03:00:00Z" });
    const events = await listRecentEvents(db, "s");
    assert.deepEqual(events.map((event) => [event.id, event.landedOnEumon]), [["e2", false], ["e1", true]]);
  });
});
