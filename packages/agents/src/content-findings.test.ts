import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Opportunity } from "@organic-growth/core";
import { contentOpportunities, findingsFromContentGrades } from "./content-findings.js";
import type { ContentGradeRow } from "./content-targets.js";

const topics = (n: number, covered: number) => Array.from({ length: n }, (_, i) => ({ label: `t${i}`, covered: i < covered, coveredBy: [], evidence: null }));
const row = (query: string, grade: ContentGradeRow["grade"], score: number, n = 6, covered = 2, impressions: number | null = 400): ContentGradeRow => ({
  query, market: "mys", page: `https://x.com/${query}`, checkedAt: "2026-10-01", source: "search", impressions, competitors: [],
  score, grade, topics: topics(n, covered), covered, missing: topics(n, covered).filter((t) => !t.covered).map((t) => t.label), ownWords: 300, medianWords: 900, structure: [],
});
const find = (rows: ContentGradeRow[]) => findingsFromContentGrades({ siteId: "s", analysisId: "a", grades: rows });

describe("findingsFromContentGrades", () => {
  it("fires at two weak pages, not at one; fewer than three topics do not count", () => {
    assert.equal(find([row("a", "D", 30)]).length, 0);
    assert.equal(find([row("a", "D", 30), row("b", "F", 10, 2, 0)]).length, 0);
    assert.equal(find([row("a", "D", 30), row("b", "B", 80, 6, 4)]).length, 0, "coverage 4/6 is not under half");
    const [f] = find([row("a", "D", 30), row("b", "F", 10)]);
    assert.equal(f!.title, "2 pages cover less than half of what the top results cover");
    assert.equal(f!.checkId, "content.coverage_gap");
    assert.equal(f!.category, "content");
    assert.equal(f!.organicImpactScore, 35);
    assert.deepEqual(f!.pagesAffected, ["https://x.com/a", "https://x.com/b"]);
    assert.match(f!.summary, /“a”.*t2/);
  });
  it("caps the impact at 65", () => {
    const f = find(Array.from({ length: 9 }, (_, i) => row(`q${i}`, "D", 30)))[0]!;
    assert.equal(f.organicImpactScore, 65);
  });
});

describe("contentOpportunities", () => {
  const striking: Opportunity = { id: "o", siteId: "s", analysisId: "a", title: "Move “b” onto the first results (now position 12.0)", searchDemand: 1, intent: "x", competitorStrength: 0, estimatedDifficulty: 1, businessValue: 1, conversionPotential: 1, technicalEffort: 1, contentEffort: 1, priorityScore: 1, rationale: "Base." };
  const run = (grades: ContentGradeRow[], existing: Opportunity[] = []) => contentOpportunities({ siteId: "s", analysisId: "a", grades, existing });

  it("makes opportunities for C, D and F, not A or B, at most five", () => {
    const many = ["A", "B", "C", "D", "F"].map((g, i) => row(`q${i}`, g as ContentGradeRow["grade"], 90 - i * 20));
    const { made } = run(many);
    assert.equal(made.length, 3);
    assert.equal(made[0]!.title, "Cover what the top results cover for “q4”: t2, t3, t4");
    assert.equal(made[0]!.intent, "content_coverage");
    assert.equal(made[0]!.currentPage, "https://x.com/q4");
    assert.equal(run(Array.from({ length: 8 }, (_, i) => row(`z${i}`, "F", 10))).made.length, 5);
  });
  it("enriches a striking-distance opportunity instead of adding another", () => {
    const { made, existing } = run([row("b", "D", 30)], [striking]);
    assert.equal(made.length, 0);
    assert.equal(existing[0]!.rationale, "Base. The top results also cover: t2, t3, t4, t5.");
  });
});
