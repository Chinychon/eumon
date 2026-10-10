import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BacklinksInput, ReferringDomain } from "@organic-growth/core";
import { findingsFromReferring } from "./link-findings.js";

const row = (i: number, over: Partial<ReferringDomain> = {}): ReferringDomain => ({
  domain: `d${i}.com`, urlFrom: `https://d${i}.com/p`, urlTo: `https://x.com/gone${i}`, anchor: "a", dofollow: true,
  firstSeen: "2026-09-01", lastSeen: "2026-10-05", lost: false, broken: false, rank: 100 - i, spamScore: 0, spam: false, spamReason: null, ...over,
});
const input = (over: { brokenReal?: number; lostReal?: number; newSpam?: number; broken?: ReferringDomain[]; lost?: ReferringDomain[] } = {}): BacklinksInput => ({
  asOf: "2026-10-10",
  counts: { real: 50, spam: 0, newReal: 0, lostReal: over.lostReal ?? 0, brokenReal: over.brokenReal ?? 0, dofollowReal: 40, newSpam: over.newSpam ?? 0, total: 50 },
  top: [], newReal: [], lostReal: over.lost ?? [], brokenReal: over.broken ?? [], anchors: [],
  networks: [{ key: "k", kind: "anchor", label: "anchor “cheap pills”", domains: 25, since: "2026-10-01", example: "https://s.com" }],
});
const run = (referring: BacklinksInput | null) => findingsFromReferring({ siteId: "s", analysisId: "a", referring });

describe("findingsFromReferring", () => {
  it("broken fires at 3, not 2, with exact title and distinct targets", () => {
    assert.equal(run(input({ brokenReal: 2 })).length, 0);
    const broken = Array.from({ length: 4 }, (_, i) => row(i, { broken: true, urlTo: i < 2 ? "https://x.com/a" : `https://x.com/b${i}` }));
    const [f] = run(input({ brokenReal: 3, broken }));
    assert.equal(f!.title, "3 sites link to pages on your site that are missing");
    assert.equal(f!.category, "search");
    assert.equal(f!.organicImpactScore, 42);
    assert.deepEqual(f!.pagesAffected, ["https://x.com/a", "https://x.com/b2", "https://x.com/b3"]);
    assert.match(f!.summary, /d0\.com → \/a/);
  });
  it("lost fires at 3, not 2; n comes from the counts", () => {
    assert.equal(run(input({ lostReal: 2 })).length, 0);
    const [f] = run(input({ lostReal: 3, lost: [row(1, { lost: true, lastSeen: "2026-09-20" })] }));
    assert.equal(f!.title, "You lost links from 3 sites in 30 days");
    assert.equal(f!.organicImpactScore, 34);
    assert.match(f!.summary, /2026-09-20/);
  });
  it("spam wave fires at 20, not 19; impact 15", () => {
    assert.equal(run(input({ newSpam: 19 })).length, 0);
    const [f] = run(input({ newSpam: 20 }));
    assert.equal(f!.title, "20 spam sites started linking to you in 30 days");
    assert.equal(f!.organicImpactScore, 15);
    assert.match(f!.summary, /cheap pills/);
  });
  it("impacts are capped", () => {
    assert.equal(run(input({ brokenReal: 50 }))[0]!.organicImpactScore, 70);
    assert.equal(run(input({ lostReal: 50 }))[0]!.organicImpactScore, 60);
  });
  it("a clean profile gives no findings; null gives none", () => {
    assert.equal(run(input()).length, 0);
    assert.equal(run(null).length, 0);
  });
});
