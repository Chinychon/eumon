import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INITIAL_WORKSPACE_ID, setLimitOverrides, type D1Like } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { charge, featureRefusal, FREE_LIMITS, keysForLimits, limitsFor, mergeOverrides, refund } from "./limits.ts";

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

  it("frees a refunded charge for the same day", async () => {
    const d = await db();
    const now = new Date(AT);
    for (let i = 0; i < 3; i++) assert.equal(await charge(d, "w", "analysesPerDay", 1, now), null);
    assert.notEqual(await charge(d, "w", "analysesPerDay", 1, now), null);
    await refund(d, "w", "analysesPerDay", 1, now);
    assert.equal(await charge(d, "w", "analysesPerDay", 1, now), null);
  });

  it("merges an admin's change into the overrides and drops values equal to the free default", () => {
    const current = { askPerDay: 100, dataForSeo: true };
    assert.deepEqual(mergeOverrides(current, { sites: 5 }), { askPerDay: 100, dataForSeo: true, sites: 5 }, "keys left out keep their value");
    assert.deepEqual(mergeOverrides(current, { askPerDay: null }), { askPerDay: null, dataForSeo: true }, "null is unlimited, not a reset");
    assert.deepEqual(mergeOverrides(current, { ...FREE_LIMITS, sites: 5 }), { sites: 5 }, "the admin form sends every limit; defaults are no override");
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
