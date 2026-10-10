import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrawlCoverage, CrawlPageResult } from "@organic-growth/core";
import { findingsFromAiContent } from "./ai-findings.js";

const coverage: CrawlCoverage = {
  totalUrls: 100, completedUrls: 100, failedUrls: 0, pendingUrls: 0, emptyShellUrls: 0, httpErrorUrls: 0, missingTitleUrls: 0,
  issues: { snippetBlocked: 2, stale: 30, noDate: 4, noAnswerStructure: 50, lowEvidence: 20, noAuthor: 25, noLandmarks: 9 }, issueExamples: {},
};
const homepage = { url: "https://x.com/", entitySchema: false } as CrawlPageResult;

describe("findingsFromAiContent", () => {
  it("writes the AI visibility content findings", () => {
    const found = findingsFromAiContent({ siteId: "s", analysisId: "a", coverage, homepage });
    assert.deepEqual(found.map((f) => f.checkId), ["ai.snippet_blocked", "ai.stale", "ai.no_date", "ai.no_answer_structure", "ai.low_evidence", "ai.no_author", "ai.semantic_html_missing", "ai.no_entity_schema"]);
    const stale = found.find((f) => f.checkId === "ai.stale")!;
    assert.equal(stale.category, "ai_visibility");
    assert.ok(stale.organicImpactScore >= 40, String(stale.organicImpactScore));
    assert.equal(stale.title, "30 articles have not been updated in over a year");
  });

  it("skips the entity schema check when the homepage was not crawled or has it", () => {
    const without = findingsFromAiContent({ siteId: "s", analysisId: "a", coverage, homepage: undefined }).map((f) => f.checkId);
    assert.ok(!without.includes("ai.no_entity_schema"));
    const has = findingsFromAiContent({ siteId: "s", analysisId: "a", coverage, homepage: { ...homepage, entitySchema: true } }).map((f) => f.checkId);
    assert.ok(!has.includes("ai.no_entity_schema"));
  });

  it("does not judge a homepage from before the content signals", () => {
    const old = findingsFromAiContent({ siteId: "s", analysisId: "a", coverage: { ...coverage, issues: {} }, homepage: { url: "https://x.com/" } as CrawlPageResult });
    assert.deepEqual(old, []);
  });
});
