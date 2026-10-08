import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coverageClass, speedRating } from "./signals.js";

describe("site signals", () => {
  it("rates speed on Google's thresholds, inclusive at each edge", () => {
    assert.equal(speedRating("lcp", 2500), "good");
    assert.equal(speedRating("lcp", 2501), "needs-work");
    assert.equal(speedRating("lcp", 4000), "needs-work");
    assert.equal(speedRating("lcp", 4001), "poor");
    assert.equal(speedRating("inp", 200), "good");
    assert.equal(speedRating("inp", 500), "needs-work");
    assert.equal(speedRating("inp", 1042), "poor");
    assert.equal(speedRating("cls", 0.1), "good");
    assert.equal(speedRating("cls", 0.25), "needs-work");
    assert.equal(speedRating("cls", 0.26), "poor");
  });

  it("sorts URL Inspection results into what Google did with the page", () => {
    assert.equal(coverageClass("PASS", "Submitted and indexed"), "indexed");
    assert.equal(coverageClass("NEUTRAL", "Crawled - currently not indexed"), "crawled");
    assert.equal(coverageClass("NEUTRAL", "Discovered - currently not indexed"), "discovered");
    assert.equal(coverageClass("NEUTRAL", "URL is unknown to Google"), "unknown");
    assert.equal(coverageClass("NEUTRAL", "Excluded by ‘noindex’ tag"), "excluded");
    assert.equal(coverageClass("FAIL", null), "excluded");
  });
});
