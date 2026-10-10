import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECKS, checkList, finding, NOT_RUN } from "./index.js";

describe("check registry", () => {
  it("has well-formed, unique, documented entries", () => {
    const ids = new Set<string>();
    for (const check of checkList()) {
      assert.match(check.id, /^[a-z]+(\.[a-z0-9_]+)+$/, check.id);
      assert.ok(!ids.has(check.id), `duplicate id ${check.id}`);
      ids.add(check.id);
      assert.equal(CHECKS[check.id], check);
      for (const field of ["what", "why", "how", "severity"] as const) assert.ok(check.docs[field].trim().length > 20, `${check.id}.docs.${field}`);
      assert.ok(check.name.length > 2 && check.name.length < 48, `${check.id}.name`);
      if (check.category !== "conversion" && !check.id.startsWith("data.")) assert.ok(check.pillars.length > 0, `${check.id} needs a pillar`);
      if (check.docs.unscored) assert.equal(check.class, "notice", `${check.id} unscored checks are notices`);
    }
    assert.equal(ids.size, 100);
  });

  it("lists checks that are deliberately not run, each with a reason", () => {
    assert.ok(NOT_RUN.length >= 7);
    for (const entry of NOT_RUN) assert.ok(entry.why.length > 20, entry.name);
  });
});

describe("finding()", () => {
  const base = { siteId: "s", analysisId: "a", title: "T", summary: "S", evidence: {}, impact: 72 };

  it("fills category, checkId, severity from impact, and the docs' fix as the default recommendation", () => {
    const result = finding(CHECKS["title.weak"]!, base);
    assert.equal(result.category, "metadata");
    assert.equal(result.checkId, "title.weak");
    assert.equal(result.severity, "HIGH");
    assert.equal(result.organicImpactScore, 72);
    assert.equal(result.recommendation, CHECKS["title.weak"]!.docs.how);
    assert.deepEqual(result.pagesAffected, []);
    assert.match(result.id, /^finding_/);
    assert.equal("scopeKey" in result, false);
  });

  it("keeps a producer's own recommendation, severity override and scope key", () => {
    const result = finding(CHECKS["server.slow"]!, { ...base, recommendation: "Cache /doctors/.", severity: "CRITICAL", scopeKey: "doctors", pagesAffected: ["https://x.com/doctors/a"] });
    assert.equal(result.recommendation, "Cache /doctors/.");
    assert.equal(result.severity, "CRITICAL");
    assert.equal(result.scopeKey, "doctors");
    assert.deepEqual(result.pagesAffected, ["https://x.com/doctors/a"]);
  });
});
