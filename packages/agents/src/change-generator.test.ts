import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPlainRobotsTxt, SAFE_SEO_CONFIG_PATHS } from "./change-generator.js";

describe("pull request allowlist", () => {
  it("only proposes changes to the static robots.txt", () => {
    assert.deepEqual([...SAFE_SEO_CONFIG_PATHS], ["public/robots.txt"]);
  });

  it("accepts only robots.txt directives and comments", () => {
    assert.equal(isPlainRobotsTxt("# Eumon\nUser-agent: *\nDisallow: /admin\nAllow: /\n\nSitemap: https://x.com/sitemap.xml\n"), true);
    assert.equal(isPlainRobotsTxt("User-agent: *\nimport fs from 'fs'\n"), false);
    assert.equal(isPlainRobotsTxt("<script>alert(1)</script>"), false);
    assert.equal(isPlainRobotsTxt("Crawl-delay: 10\nHost: x.com"), true);
  });
});
