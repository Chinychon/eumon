import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INITIAL_WORKSPACE_ID, setLimitOverrides, type D1Like } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { charge, featureRefusal, FREE_LIMITS, keysForLimits, limitsFor } from "./limits.ts";

const AT = "2026-10-10T00:00:00.000Z";
async function db(): Promise<D1Like> {
  const db = openSqliteD1();
  await db.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('w', 'w', 'w', ?)`).bind(AT).run();
  return db;
}

describe("limits", () => {
  it("applies the free limits until an override says otherwise", async () => {
    const d = await db();
    assert.deepEqual(await limitsFor(d, "w"), FREE_LIMITS);
    await setLimitOverrides(d, "w", { askPerDay: 100, dataForSeo: true });
    assert.equal((await limitsFor(d, "w")).askPerDay, 100);
    assert.equal((await limitsFor(d, "w")).sites, FREE_LIMITS.sites);
  });

  it("refuses the 21st question of a day with a message, and the initial workspace never", async () => {
    const d = await db();
    const now = new Date(AT);
    for (let i = 0; i < 20; i++) assert.equal(await charge(d, "w", "askPerDay", 1, now), null);
    assert.match((await charge(d, "w", "askPerDay", 1, now))!, /20 .*resets at midnight UTC/);
    for (let i = 0; i < 50; i++) assert.equal(await charge(d, INITIAL_WORKSPACE_ID, "askPerDay", 1, now), null);
  });

  it("keeps paid features off for free workspaces", async () => {
    const d = await db();
    assert.match((await featureRefusal(d, "w", "pullRequests"))!, /pull requests/i);
    assert.equal(await featureRefusal(d, INITIAL_WORKSPACE_ID, "pullRequests"), null);
  });

  it("drops the DataForSEO credentials for a workspace without DataForSEO", () => {
    const keys = { googleApiKey: "g", dataForSeo: { login: "l", password: "p" } };
    assert.equal(keysForLimits(keys, FREE_LIMITS).dataForSeo, undefined);
    assert.equal(keysForLimits(keys, FREE_LIMITS).googleApiKey, "g");
    assert.deepEqual(keysForLimits(keys, { ...FREE_LIMITS, dataForSeo: true }).dataForSeo, keys.dataForSeo);
  });
});
