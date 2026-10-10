import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReferringDomain } from "@organic-growth/core";
import { openSqliteD1 } from "./sqlite.js";
import { upsertSite } from "./index.js";
import { saveSnapshot } from "./snapshots.js";
import { listReferringDomains, loadReferringLists, referringDomainCounts, replaceReferringDomains } from "./referring-domains.js";

const at = "2026-10-10T04:00:00.000Z";
async function site() {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
  return db;
}
const row = (domain: string, overrides: Partial<ReferringDomain> = {}): ReferringDomain => ({
  domain, urlFrom: `https://${domain}/p`, urlTo: "https://x.com/", anchor: "x", dofollow: true,
  firstSeen: "2026-10-01", lastSeen: "2026-10-09", lost: false, broken: false, rank: 50, spamScore: 10, spam: false, spamReason: null,
  ...overrides,
});
const all = (db: ReturnType<typeof openSqliteD1>) => listReferringDomains(db, "s", { limit: 100 });

describe("referring domains store", () => {
  it("replacing writes every row and a second replace drops the old ones", async () => {
    const db = await site();
    await replaceReferringDomains(db, "s", [row("a.example"), row("b.example", { spamScore: null })]);
    const first = await all(db);
    assert.deepEqual(first.map((r) => r.domain).sort(), ["a.example", "b.example"]);
    assert.equal(first.find((r) => r.domain === "b.example")?.spamScore, null);
    await replaceReferringDomains(db, "s", [row("c.example")]);
    assert.deepEqual((await all(db)).map((r) => r.domain), ["c.example"]);
  });

  it("replacing with nothing clears", async () => {
    const db = await site();
    await replaceReferringDomains(db, "s", [row("a.example")]);
    await replaceReferringDomains(db, "s", []);
    assert.deepEqual(await all(db), []);
  });

  it("lists live first, then strongest, filtered by spam / new / lost / broken, limited", async () => {
    const db = await site();
    await replaceReferringDomains(db, "s", [
      row("a.example", { rank: 80, firstSeen: "2026-10-08" }),
      row("b.example", { rank: 80, firstSeen: "2026-09-01", lost: true, lastSeen: "2026-10-08" }),
      row("c.example", { rank: 60, spam: true, spamReason: "network", firstSeen: "2026-10-09" }),
      row("d.example", { rank: 40, broken: true }),
      row("e.example", { rank: 90, lost: true, lastSeen: "2026-09-01", broken: true }),
    ]);
    const domains = async (filter: Parameters<typeof listReferringDomains>[2]) => (await listReferringDomains(db, "s", filter)).map((r) => r.domain);
    assert.deepEqual(await domains({ limit: 100 }), ["a.example", "c.example", "d.example", "e.example", "b.example"]);
    assert.deepEqual(await domains({ limit: 3 }), ["a.example", "c.example", "d.example"]);
    assert.deepEqual(await domains({ limit: 100, spam: true }), ["c.example"]);
    assert.deepEqual(await domains({ limit: 100, spam: false }), ["a.example", "d.example", "e.example", "b.example"]);
    assert.deepEqual(await domains({ limit: 100, newSince: "2026-10-07" }), ["a.example", "c.example"]);
    assert.deepEqual(await domains({ limit: 100, lostSince: "2026-10-01" }), ["b.example"]);
    assert.deepEqual(await domains({ limit: 100, broken: true }), ["d.example"]);
  });

  it("counts in one query: live real, live spam, new real since a day (lost or not), lost real since a day, broken live real, dofollow live real, new spam since a day, every row", async () => {
    const db = await site();
    await replaceReferringDomains(db, "s", [
      row("a.example", { firstSeen: "2026-10-08", dofollow: true }),
      row("b.example", { firstSeen: "2026-09-01", lost: true, lastSeen: "2026-10-08", dofollow: true }),
      row("c.example", { spam: true, spamReason: "network", firstSeen: "2026-10-09", dofollow: true }),
      row("d.example", { firstSeen: "2026-09-01", lastSeen: "2026-09-01", broken: true, dofollow: true }),
      row("e.example", { firstSeen: "2026-09-01", lastSeen: "2026-09-01", lost: true, broken: true, dofollow: false }),
      row("f.example", { spam: true, spamReason: "network", firstSeen: "2026-09-01", lost: true }),
      row("g.example", { firstSeen: "2026-10-08", lost: true, lastSeen: "2026-10-09" }),
    ]);
    assert.deepEqual(await referringDomainCounts(db, "s", "2026-10-07"), {
      real: 2, spam: 1, newReal: 2, lostReal: 2, brokenReal: 1, dofollowReal: 2, newSpam: 1, total: 7,
    });
  });

  it("deleting the site removes the rows", async () => {
    const db = await site();
    await db.prepare("PRAGMA foreign_keys = ON").run();
    await replaceReferringDomains(db, "s", [row("a.example")]);
    await db.prepare("DELETE FROM sites WHERE id = ?").bind("s").run();
    assert.deepEqual(await all(db), []);
  });
});

describe("loadReferringLists", () => {
  it("is null with no rows, else bounded lists and the networks from the snapshot", async () => {
    const db = await site();
    assert.equal(await loadReferringLists(db, "s", "x.com", "2026-10-10"), null);
    const rows = [row("a.example", { rank: 90 }), ...Array.from({ length: 30 }, (_, i) => row(`r${i}.example`, { rank: i })), row("lost.example", { lost: true, lastSeen: "2026-10-05" }), row("bad.example", { spam: true, spamReason: "Same anchor on 10 sites" })];
    await replaceReferringDomains(db, "s", rows);
    await saveSnapshot(db, "s", { kind: "spam_networks", scope: "x.com", periodEnd: "2026-10-10", rows: [{ key: "k", kind: "anchor", label: "l", domains: 1, since: "2026-10-01", example: "bad.example" }] });
    const lists = (await loadReferringLists(db, "s", "x.com", "2026-10-10"))!;
    assert.equal(lists.top.length, 25);
    assert.equal(lists.top[0]!.domain, "a.example");
    assert.equal(lists.newReal.length, 10);
    assert.deepEqual(lists.lostReal.map((r) => r.domain), ["lost.example"]);
    assert.equal(lists.counts.spam, 1);
    assert.equal(lists.asOf, "2026-10-10");
    assert.equal(lists.networks.length, 1);
  });

  it("still shows a site whose links are all lost", async () => {
    const db = await site();
    await replaceReferringDomains(db, "s", [row("gone.example", { lost: true, lastSeen: "2026-10-05" })]);
    const lists = await loadReferringLists(db, "s", "x.com", "2026-10-10");
    assert.ok(lists, "the lost link is something to show");
    assert.deepEqual([lists.counts.real, lists.counts.total], [0, 1]);
    assert.deepEqual(lists.lostReal.map((r) => r.domain), ["gone.example"]);
  });
});
