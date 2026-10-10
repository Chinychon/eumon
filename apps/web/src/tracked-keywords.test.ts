import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTrackedKeywords } from "./tracked-keywords.ts";

describe("parseTrackedKeywords", () => {
  it("normalises and de-duplicates", () => {
    assert.deepEqual(parseTrackedKeywords({ keywords: ["Dental  Implants ", "dental implants", "Braces\nprice"] }), { keywords: ["dental implants", "braces price"] });
  });
  it("refuses a missing list, too many, and bad lengths", () => {
    assert.ok("error" in parseTrackedKeywords({}));
    assert.ok("error" in parseTrackedKeywords({ keywords: Array.from({ length: 31 }, (_, index) => `kw ${index}`) }));
    assert.ok("error" in parseTrackedKeywords({ keywords: ["a"] }));
    assert.ok("error" in parseTrackedKeywords({ keywords: ["x".repeat(81)] }));
    assert.ok("error" in parseTrackedKeywords({ keywords: [42] }));
  });
  it("an empty list clears tracking", () => {
    assert.deepEqual(parseTrackedKeywords({ keywords: [] }), { keywords: [] });
  });
});
