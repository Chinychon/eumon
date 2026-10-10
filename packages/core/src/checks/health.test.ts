import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECKS, checkList, healthScore, PAGE_ERROR_CHECKS, UNSCORED_PAGE_ERRORS } from "./index.js";

describe("healthScore", () => {
  it("is the share of healthy indexable pages, null without pages, zero with a site error", () => {
    assert.equal(healthScore({ indexable: 100, unhealthy: 3, siteErrors: 0 }), 97);
    assert.equal(healthScore({ indexable: 3, unhealthy: 1, siteErrors: 0 }), 66.7);
    assert.equal(healthScore({ indexable: 0, unhealthy: 0, siteErrors: 0 }), null);
    assert.equal(healthScore({ indexable: 100, unhealthy: 0, siteErrors: 1 }), 0);
    assert.equal(healthScore({ indexable: 5, unhealthy: 9, siteErrors: 0 }), 0, "never below zero");
  });
});

describe("PAGE_ERROR_CHECKS", () => {
  it("names only error-class page checks of the right pillar", () => {
    for (const pillar of ["seo", "ai"] as const) {
      for (const id of PAGE_ERROR_CHECKS[pillar]) {
        const check = CHECKS[id];
        assert.ok(check, id);
        assert.equal(check.class, "error", id);
        assert.equal(check.scope, "page", id);
        assert.ok(check.pillars.includes(pillar), `${id} is not a ${pillar} check`);
      }
    }
  });

  it("covers every error-class page check from the crawl, or says why not", () => {
    const expected = checkList().filter((check) => check.class === "error" && check.scope === "page" && check.sources.includes("crawl")).map((check) => check.id);
    for (const id of expected) {
      assert.ok(PAGE_ERROR_CHECKS.seo.includes(id) || PAGE_ERROR_CHECKS.ai.includes(id) || id in UNSCORED_PAGE_ERRORS, `${id} is an error-class page check the score ignores without saying why`);
    }
  });
});
