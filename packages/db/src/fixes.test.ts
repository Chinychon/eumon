import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countOpenFixes, findFixByHeadSha, findFixByPr, getFixSettings, hasLiveFix, listFixes, listPageHeads, setFixSettings, stageFix, updateFix, type FixRecord } from "./fixes.js";
import { upsertSite } from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

const AT = "2026-10-10T00:00:00.000Z";
async function setup() {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT, githubOwner: "acme", githubRepo: "web" });
  await db.prepare("INSERT INTO analyses (id, site_id, status, created_at) VALUES ('a', 's', 'completed', ?)").bind(AT).run();
  return db;
}
const fix = (over: Partial<FixRecord> = {}): FixRecord => ({
  id: "f1", siteId: "s", analysisId: "a", kind: "head", route: "/procedures/:slug", filePath: "app/procedures/[slug]/page.tsx", fileSha: "sha1",
  title: "Fix titles on /procedures/:slug", reason: "40 pages", files: { "app/procedures/[slug]/page.tsx": "new" }, original: { "app/procedures/[slug]/page.tsx": "old" },
  urls: ["https://x.com/procedures/a"], problems: ["title-missing"], warnings: [], score: 120, status: "staged", createdAt: AT, updatedAt: AT, ...over,
});

describe("fix storage", () => {
  it("stages, lists, updates and finds fixes", async () => {
    const db = await setup();
    await stageFix(db, fix());
    assert.equal((await listFixes(db, "s"))[0]?.files["app/procedures/[slug]/page.tsx"], "new");
    assert.equal(await hasLiveFix(db, "s", "/procedures/:slug", "head"), true);
    await updateFix(db, "f1", { status: "draft", prNumber: 7, headSha: "abc", prUrl: "https://github.com/acme/web/pull/7" });
    assert.equal(await countOpenFixes(db, "s"), 1);
    assert.equal((await findFixByPr(db, "s", 7))?.id, "f1");
    assert.equal((await findFixByHeadSha(db, "abc"))?.status, "draft");
    await updateFix(db, "f1", { status: "merged" });
    assert.equal(await hasLiveFix(db, "s", "/procedures/:slug", "head"), false, "merged fixes don't block a new one");
  });

  it("keeps settings with defaults", async () => {
    const db = await setup();
    assert.deepEqual(await getFixSettings(db, "s"), { allowAiSearch: false, budget: 3, autopilot: true });
    await setFixSettings(db, "s", { allowAiSearch: true, budget: 5, autopilot: false });
    assert.deepEqual(await getFixSettings(db, "s"), { allowAiSearch: true, budget: 5, autopilot: false });
  });

  it("reads head tags from crawled pages", async () => {
    const db = await setup();
    await db.prepare("INSERT INTO pages (analysis_id, url, status, title, is_empty_shell, crawl_state, result_json, created_at) VALUES ('a', 'https://x.com/p', 200, 'P', 0, 'complete', ?, ?)")
      .bind(JSON.stringify({ description: "D", canonical: "https://x.com/p", hreflang: [], jsonLdTypes: ["WebPage"], headingOutline: ["h1:Hello", "h2:x"] }), AT).run();
    assert.deepEqual(await listPageHeads(db, "a"), [{ url: "https://x.com/p", status: 200, title: "P", description: "D", canonical: "https://x.com/p", hreflang: [], jsonLdTypes: ["WebPage"], heading: "Hello" }]);
  });
});
