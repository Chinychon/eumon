import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { notFoundProbeFinding, probeTitleForCoverage } from "./not-found-probe.js";

describe("notFoundProbeFinding", () => {
  it("reports a site that answers 200 for a page that cannot exist, and nothing for a proper 404", () => {
    const finding = notFoundProbeFinding({ url: "https://x.com/eumon-404-probe-abc123", status: 200, title: "Oops, something went wrong" }, "s", "a");
    assert.equal(finding?.title, "The site answers 200 for pages that don't exist");
    assert.equal(finding?.category, "indexing");
    assert.match(finding?.summary ?? "", /Oops, something went wrong/);
    assert.equal(notFoundProbeFinding({ url: "https://x.com/eumon-404-probe-abc123", status: 404, title: "Not found" }, "s", "a"), null);
    assert.equal(notFoundProbeFinding({ url: "https://x.com/eumon-404-probe-abc123", status: 410, title: undefined }, "s", "a"), null);
  });

  it("tells a redirect to the homepage apart, and never hands the homepage's title to the coverage rule", () => {
    const home = { url: "https://x.com/eumon-404-probe-abc123", finalUrl: "https://x.com/", status: 200, title: "Demo Clinic" };
    assert.match(notFoundProbeFinding(home, "s", "a")!.summary, /redirects to the homepage/);
    assert.equal(probeTitleForCoverage(home), null);
    assert.equal(probeTitleForCoverage({ url: "https://x.com/eumon-404-probe-abc123", finalUrl: "https://x.com/eumon-404-probe-abc123", status: 200, title: "Oops" }), "Oops");
    assert.equal(probeTitleForCoverage({ url: "https://x.com/eumon-404-probe-abc123", status: 404, title: "Not found" }), null);
  });
});
