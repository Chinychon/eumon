import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, RESULT_METRICS, resultsView } from "@organic-growth/core";
import { getAnalysisJob, getCrawlProgress, getLinkGraph, getSite, getTopQueriesSnapshot, indexStatusCounts, listMetricSeries, publishedPages } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { advanceDemoRun, DEMO_SITE_ID, isLocalHost, seedDemoSite, startDemoRun } from "./demo.js";

describe("demo site", () => {
  it("is only served to this machine", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "LOCALHOST"]) assert.equal(isLocalHost(host), true, host);
    for (const host of ["eumon.app", "localhost.example.com", "10.0.0.2", "192.168.1.5"]) assert.equal(isLocalHost(host), false, host);
  });

  it("seeds two analyses through the real pipeline and plays a simulated run to the end", async () => {
    const db = openSqliteD1();
    // Stage changes are stamped with the real clock, so the simulated clock starts from it.
    const now = Date.now();
    await seedDemoSite(db, now);
    assert.match((await getSite(db, DEMO_SITE_ID))!.name, /demo/i);

    const older = await getAnalysisJob(db, "analysis_demo_1");
    const latest = await getAnalysisJob(db, "analysis_demo_2");
    type Report = { coverage: { totalUrls: number; emptyShellUrls: number; httpErrorUrls: number; families: unknown[] }; findings: unknown[]; competition: { rows: unknown[] } | null; search: unknown };
    const [before, after] = [older!.report as Report, latest!.report as Report];
    assert.equal(latest!.status, "completed");
    assert.ok(after.coverage.totalUrls > 1_700, `crawled ${after.coverage.totalUrls}`);
    assert.ok(after.coverage.families.length >= 6);
    assert.ok(before.coverage.emptyShellUrls > after.coverage.emptyShellUrls && after.coverage.emptyShellUrls > 0, "fewer empty pages a month later");
    assert.ok(after.coverage.httpErrorUrls > 0);
    assert.ok(after.findings.length > 3);
    assert.ok(after.competition?.rows.length, "competitor content compared");
    assert.ok(after.search, "search insights");
    const links = await getLinkGraph(db, DEMO_SITE_ID);
    assert.ok(links.orphans!.count > 300, `orphans ${links.orphans?.count}: price pages outside five cities`);
    assert.deepEqual(links.landingPages, { published: 60, linkedFromSite: 2 });
    const live = await db.prepare("SELECT COUNT(*) AS n FROM generated_pages WHERE site_id = ? AND status = 'published'").bind(DEMO_SITE_ID).first<{ n: number }>();
    assert.ok(Number(live?.n) > 20, `published ${live?.n}`);

    // An update re-fetches only the changed price and dentist pages, then finishes with a report.
    await startDemoRun(db, { analysisId: "analysis_demo_run", full: false, now });
    let at = now;
    for (let poll = 0; poll < 400; poll++) {
      at += 3_000;
      await advanceDemoRun(db, "analysis_demo_run", at);
      if ((await getAnalysisJob(db, "analysis_demo_run"))!.status !== "running") break;
    }
    const run = await getAnalysisJob(db, "analysis_demo_run");
    assert.equal(run!.status, "completed");
    const progress = await getCrawlProgress(db, "analysis_demo_run");
    assert.ok(progress.reused > 500 && progress.crawled > 500, `reused ${progress.reused}, crawled ${progress.crawled}`);
    assert.equal((run!.report as Report).coverage.emptyShellUrls, 0, "the fix landed");
  });

  it("gives the demo 16 months of Results history with a go-live 80 days ago", async () => {
    const db = openSqliteD1();
    const now = Date.now();
    await seedDemoSite(db, now);
    const today = new Date(now).toISOString().slice(0, 10);
    const pages = await publishedPages(db, DEMO_SITE_ID);
    assert.equal(pages.goLive, addDays(today, -80));
    assert.ok((await getSite(db, DEMO_SITE_ID))?.ga4Property, "the demo has an Analytics property, so the view shows organic sessions");
    const view = resultsView({
      today, goLive: pages.goLive, markets: ["mys", "sgp"], published: pages.published,
      series: await listMetricSeries(db, DEMO_SITE_ID, RESULT_METRICS, addDays(today, -500), today),
      index: await indexStatusCounts(db, DEMO_SITE_ID), searchConnected: true, ga4Connected: true,
    });
    assert.ok(view.numbers.clicks.current! > view.numbers.clicks.before!, "clicks grew after go-live");
    assert.deepEqual(view.numbers.pages, { live: 60, indexed: 40, notIndexed: 12, unchecked: 8 });
    assert.ok(view.search!.buckets[1]!.queries! > 0);
    assert.ok(view.organic!.length > 60);
    const top = await getTopQueriesSnapshot(db, DEMO_SITE_ID, { property: "sc-domain:demo-clinic.example", markets: ["mys", "sgp"] });
    assert.ok(top && top.rows.length >= 8 && top.rows.some((row) => row.before === null), "a top-queries table with a new query");
  });
});
