import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { doFirst, gapsFirst, pageTypeHealth, servedShare, type Finding } from "./report-model.ts";

const finding = (title: string, severity: string, impact: number, category = "rendering"): Finding =>
  ({ id: title, category, severity, title, summary: "", organicImpactScore: impact });

describe("report model", () => {
  it("puts urgent findings first, then the best opportunity, then the rest", () => {
    const actions = doFirst({
      findings: [finding("Low thing", "LOW", 90), finding("Empty prices", "HIGH", 77), finding("Skipped titles", "MEDIUM", 55, "search")],
      opportunities: [{ title: "Push implants", rationale: "", priorityScore: 156 }, { title: "Weaker", rationale: "", priorityScore: 10, intent: "content_gap" }],
    });
    assert.deepEqual(actions.map((action) => [action.title, action.tab]), [["Empty prices", "technical"], ["Push implants", "search"], ["Skipped titles", "search"]]);
  });

  it("measures each problem against the pages it applies to, and skips schema on top-level pages", () => {
    const [prices, page] = pageTypeHealth([
      { family: "page", urls: 13, crawled: 12, emptyShells: 0, errors: 0, noindex: 0, missingStructuredData: 12 },
      { family: "prices", urls: 660, crawled: 660, emptyShells: 140, errors: 0, noindex: 0, missingStructuredData: 0 },
    ]);
    assert.equal(prices!.label, "/prices/");
    assert.deepEqual(prices!.cells[0], { key: "emptyShells", label: "Empty HTML", count: 140, share: 140 / 660, applies: true });
    assert.equal(page!.cells[3]!.applies, false);
    assert.equal(page!.cells[3]!.count, 0);
  });

  it("counts only intact pages as served, and orders gaps by the competitor's lead", () => {
    assert.equal(servedShare({ totalUrls: 100, completedUrls: 98, emptyShellUrls: 8, httpErrorUrls: 2 }), 0.88);
    assert.equal(servedShare(null), null);
    const rows = gapsFirst({ rows: [
      { key: "blog", label: "Blog", status: "advantage", you: { pages: 900 }, competitors: [{ domain: "a", pages: 400, examples: [] }] },
      { key: "prices", label: "Prices", status: "shared", you: { pages: 660 }, competitors: [{ domain: "a", pages: 1500, examples: [] }] },
      { key: "reviews", label: "Reviews", status: "gap", you: { pages: 0 }, competitors: [{ domain: "b", pages: 400, examples: [] }] },
    ], competitors: [], insights: [], aiLabels: false });
    assert.deepEqual(rows.map((row) => row.key), ["prices", "reviews", "blog"]);
  });
});
