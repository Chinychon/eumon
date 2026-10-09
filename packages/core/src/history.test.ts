import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findingKey, resolutions, runKeys, type KeyRow } from "./history.js";
import type { Finding } from "./types.js";

const finding = (id: string, title: string, overrides: Partial<Finding> = {}): Finding => ({
  id, siteId: "s", analysisId: "a", category: "metadata", severity: "HIGH", title, summary: "", evidence: {}, organicImpactScore: 50, createdAt: "2026-09-01T00:00:00.000Z", ...overrides,
});
const row = (id: string, title: string, pages: string[] = [], extra: Partial<KeyRow> = {}): KeyRow => ({ id, key: findingKey({ category: "metadata", title }), title, category: "metadata", severity: "HIGH", pages, ...extra });
const run = (analysisId: string, completedAt: string, keys: KeyRow[]) => ({ analysisId, completedAt, keys });

describe("findingKey", () => {
  it("names the same problem across runs: category and title with numbers blanked, case ignored", () => {
    assert.equal(findingKey(finding("f1", "Doctors wait for 3 data requests in sequence")), findingKey(finding("f2", "Doctors wait for 4 data requests in sequence")));
    assert.equal(findingKey(finding("f1", " Thin Meta Descriptions ")), "metadata|thin meta descriptions");
    assert.notEqual(findingKey(finding("f1", "Thin meta descriptions")), findingKey(finding("f1", "Thin meta descriptions", { category: "content" })), "another category is another problem");
    assert.equal(findingKey(finding("f1", "Rewrite the search snippet of /prices/kl-2")), findingKey(finding("f2", "Rewrite the search snippet of /prices/kl-7")), "two pages' snippet findings are one key");
  });
});

describe("runKeys", () => {
  it("lists the run's findings with up to 50 pages each, keeping duplicate keys as rows", () => {
    const rows = runKeys({ findings: [
      finding("f1", "Thin meta descriptions", { pagesAffected: Array.from({ length: 60 }, (_, index) => `https://x.com/p/${index}`) }),
      finding("f2", "Rewrite the search snippet of /prices/kl-2"),
      finding("f3", "Rewrite the search snippet of /prices/kl-7"),
    ] });
    assert.deepEqual(rows.map((entry) => entry.id), ["f1", "f2", "f3"]);
    assert.equal(rows[0]!.pages.length, 50);
    assert.equal(rows[0]!.vanished, undefined);
    assert.equal(rows[1]!.key, rows[2]!.key);
  });

  it("flags a previous finding as vanished only when it is gone, has pages, and every page vanished", () => {
    const previous: KeyRow[] = [
      row("p1", "Canonical mismatches detected", ["https://x.com/a", "https://x.com/b"]),
      row("p2", "Thin meta descriptions", ["https://x.com/c"]),
      row("p3", "Pages on page one that searchers skip"),
      row("p4", "Weak or missing titles on indexable pages", ["https://x.com/d"], { vanished: true }),
      row("p5", "Multilingual pages missing hreflang in HTML", ["https://x.com/e", "https://x.com/f"]),
    ];
    const gone = new Set(["https://x.com/a", "https://x.com/b", "https://x.com/c", "https://x.com/d", "https://x.com/e"]);
    const rows = runKeys({ findings: [finding("f2", "Thin meta descriptions")] }, previous, gone);
    assert.deepEqual(rows.map((entry) => [entry.id, entry.vanished ?? false]), [["f2", false], ["p1", true]],
      "still open (p2), no pages (p3), already vanished (p4) and one page still live (p5) are not flagged");
  });

  it("takes a report without findings", () => {
    assert.deepEqual(runKeys({}), []);
  });
});

describe("resolutions", () => {
  it("resolves a key the next run no longer reports, dated from the earliest consecutive run that had it", () => {
    const { resolved, open } = resolutions([
      run("a1", "2026-09-01T00:00:00.000Z", [row("f1", "Thin meta descriptions"), row("f2", "Canonical mismatches detected", ["https://x.com/a"])]),
      run("a2", "2026-09-15T00:00:00.000Z", [row("f3", "Thin meta descriptions"), row("f4", "Canonical mismatches detected", ["https://x.com/a", "https://x.com/b"])]),
      run("a3", "2026-10-01T00:00:00.000Z", [row("f5", "Thin meta descriptions")]),
    ]);
    assert.equal(open, 1);
    assert.deepEqual(resolved, [{
      key: "metadata|canonical mismatches detected", title: "Canonical mismatches detected", category: "metadata", severity: "HIGH",
      pages: ["https://x.com/a", "https://x.com/b"], firstSeen: "2026-09-01T00:00:00.000Z", resolvedAt: "2026-10-01T00:00:00.000Z", resolvedBy: "a3", reopenedAt: undefined, vanished: false,
    }], "pages come from the last run that had the finding");
  });

  it("reads a vanished row as a resolution whose pages are gone, not as an open finding", () => {
    const { resolved, open } = resolutions([
      run("a1", "2026-09-01T00:00:00.000Z", [row("f1", "Canonical mismatches detected", ["https://x.com/a"])]),
      run("a2", "2026-09-15T00:00:00.000Z", [row("f1", "Canonical mismatches detected", ["https://x.com/a"], { vanished: true })]),
      run("a3", "2026-10-01T00:00:00.000Z", []),
    ]);
    assert.equal(open, 0);
    assert.deepEqual(resolved.map(({ resolvedBy, vanished }) => ({ resolvedBy, vanished })), [{ resolvedBy: "a2", vanished: true }], "the vanished row resolves once, at a2, and a3 adds nothing");
  });

  it("marks a resolution reopened when a later run reports the key again, and resolves it again after", () => {
    const { resolved } = resolutions([
      run("a1", "2026-09-01T00:00:00.000Z", [row("f1", "Thin meta descriptions")]),
      run("a2", "2026-09-08T00:00:00.000Z", []),
      run("a3", "2026-09-15T00:00:00.000Z", [row("f2", "Thin meta descriptions")]),
      run("a4", "2026-09-22T00:00:00.000Z", []),
    ]);
    assert.deepEqual(resolved.map(({ firstSeen, resolvedAt, reopenedAt }) => ({ firstSeen, resolvedAt, reopenedAt })), [
      { firstSeen: "2026-09-01T00:00:00.000Z", resolvedAt: "2026-09-08T00:00:00.000Z", reopenedAt: "2026-09-15T00:00:00.000Z" },
      { firstSeen: "2026-09-15T00:00:00.000Z", resolvedAt: "2026-09-22T00:00:00.000Z", reopenedAt: undefined },
    ]);
  });

  it("keeps a key open while any of its same-key findings remains, and resolves it once when all are gone", () => {
    const pair = (ids: [string, string]) => [row(ids[0], "Rewrite the search snippet of /prices/kl-2"), row(ids[1], "Rewrite the search snippet of /prices/kl-7")];
    const oneLeft = resolutions([run("a1", "2026-09-01T00:00:00.000Z", pair(["f1", "f2"])), run("a2", "2026-09-08T00:00:00.000Z", [row("f3", "Rewrite the search snippet of /prices/kl-7")])]);
    assert.deepEqual(oneLeft, { resolved: [], open: 1 }, "open counts keys, not findings");
    const bothGone = resolutions([run("a1", "2026-09-01T00:00:00.000Z", pair(["f1", "f2"])), run("a2", "2026-09-08T00:00:00.000Z", [])]);
    assert.equal(bothGone.resolved.length, 1);
    assert.equal(bothGone.open, 0);
  });

  it("resolves everything at once when a run has no findings, and nothing with fewer than two runs", () => {
    assert.deepEqual(resolutions([]), { resolved: [], open: 0 });
    assert.deepEqual(resolutions([run("a1", "2026-09-01T00:00:00.000Z", [row("f1", "Thin meta descriptions")])]), { resolved: [], open: 1 });
    const { resolved, open } = resolutions([run("a1", "2026-09-01T00:00:00.000Z", [row("f1", "A"), row("f2", "B")]), run("a2", "2026-09-02T00:00:00.000Z", [])]);
    assert.equal(resolved.length, 2);
    assert.equal(open, 0);
  });
});
