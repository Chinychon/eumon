import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findingsFromLinkGraph } from "./link-findings.js";

describe("findingsFromLinkGraph", () => {
  it("turns link graph issues into findings", () => {
    const found = findingsFromLinkGraph({ siteId: "s", analysisId: "a", linkGraph: { orphans: { count: 40, examples: ["https://x/o"] }, singleInbound: { count: 3, examples: [] }, brokenLinks: { links: 12, sources: 5, targets: [{ path: "/gone", status: 404, from: 5 }] }, depth: { deep: 7, examples: ["https://x/d"] } } });
    assert.deepEqual(found.map((f) => f.checkId), ["links.broken_internal", "links.orphan", "links.single_inbound", "links.depth"]);
    assert.equal(found[0]!.title, "12 internal links point at pages that fail");
    assert.match(found[0]!.summary, /\/gone \(404, from 5 pages\)/);
    assert.match(found[1]!.summary, /40 sitemap URLs/);
    assert.deepEqual(found[1]!.pagesAffected, ["https://x/o"]);
  });

  it("writes nothing when the crawl has no link map, or depth was skipped", () => {
    assert.deepEqual(findingsFromLinkGraph({ siteId: "s", analysisId: "a", linkGraph: undefined }), []);
    assert.deepEqual(findingsFromLinkGraph({ siteId: "s", analysisId: "a", linkGraph: { orphans: null, singleInbound: null, brokenLinks: null, depth: { deep: 0, examples: [], skipped: "x" } } }), []);
    assert.deepEqual(findingsFromLinkGraph({ siteId: "s", analysisId: "a", linkGraph: { orphans: { count: 0, examples: [] }, singleInbound: { count: 0, examples: [] }, brokenLinks: { links: 0, sources: 0, targets: [] }, depth: { deep: 0, examples: [] } } }), []);
  });
});
