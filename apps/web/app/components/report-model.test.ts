import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { doFirst, gapsFirst, pageTypeHealth, resolveLink, servedShare, type Finding } from "./report-model.ts";

const finding = (title: string, severity: string, impact: number, category = "rendering"): Finding =>
  ({ id: title, category, severity, title, summary: "", organicImpactScore: impact });

describe("report model", () => {
  it("takes the backlog from the opportunities, urgent fixes first, each pointing at the area that explains it", () => {
    const actions = doFirst({
      findings: [finding("No analytics or conversion tracking found", "MEDIUM", 45, "conversion"), finding("Empty prices", "HIGH", 77)],
      opportunities: [
        { title: "Resolve: Empty prices", rationale: "", priorityScore: 59, intent: "technical_enabler" },
        { title: "Push implants", rationale: "", priorityScore: 156, intent: "commercial (query-pattern heuristic)" },
        { title: "Resolve: No analytics or conversion tracking found", rationale: "", priorityScore: 20, intent: "technical_enabler" },
        { title: "Rank for “veneers”", rationale: "", priorityScore: 31, intent: "keyword_gap" },
        { title: "Resolve: A finding from an older run", rationale: "", priorityScore: 10, intent: "technical_enabler" },
      ],
    }, 6);
    assert.deepEqual(actions.map((action) => [action.title, action.area]), [
      ["Resolve: Empty prices", "technical"],
      ["Push implants", "search"],
      ["Rank for “veneers”", "competitors"],
      ["Resolve: No analytics or conversion tracking found", "leads"],
      ["Resolve: A finding from an older run", "technical"],
    ]);
    assert.equal(doFirst({ findings: [], opportunities: [] }).length, 0);
  });

  it("sends old links to the page that now holds their content", () => {
    assert.deepEqual(resolveLink("overview", "search"), { view: "results", tab: "search" });
    assert.deepEqual(resolveLink("overview", "leads"), { view: "results", tab: "enquiries" });
    assert.deepEqual(resolveLink("overview", "competitors"), { view: "keywords", tab: null });
    assert.deepEqual(resolveLink("overview", "technical"), { view: "overview", tab: "technical" });
    assert.deepEqual(resolveLink("connections", null), { view: "setup", tab: null });
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
