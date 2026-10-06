// Runs the site analysis from the command line: the same steps as the
// SiteAnalysisWorkflow (sitemap, robots.txt, full Googlebot crawl, coverage,
// sampled checks, findings, growth plan), with an in-memory SQLite database
// in place of D1. Useful for checking analyzer changes against real sites.
//
//   npm run audit -- https://example.com [--max 500] [--competitor other.com] [--market idn] [--json]
//
// Fetches go to the live site; keep --max modest on sites you don't own.

import { createId } from "@organic-growth/core";
import {
  GOOGLEBOT_TOKEN, GOOGLEBOT_UA, auditSitemap, classifyUrlType, crawlGooglebotBatch, defaultFetcher, parseRobots,
} from "@organic-growth/crawler";
import {
  createAnalysis, enqueueAnalysisCrawlUrls, getCrawlCoverage, listCrawlPageResults, listPendingCrawlUrls, saveCrawlBatch, upsertSite,
} from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { runFullAnalysis, synthesizePlanNarrative } from "@organic-growth/agents";
import { createLlm } from "@organic-growth/ai";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const options = (name) => args.flatMap((value, index) => (args[index - 1] === `--${name}` ? [value] : []));
const target = args.find((value) => /^https?:\/\//.test(value));
if (!target) {
  console.error("Usage: npm run audit -- https://example.com [--max 500] [--competitor other.com] [--market idn] [--json]");
  process.exit(1);
}
const maxUrls = Number(option("max", "500"));
const baseUrl = new URL(target).origin;
const log = (message) => process.stderr.write(`${message}\n`);

const db = openSqliteD1();
const now = new Date().toISOString();
const siteId = createId("site");
const analysisId = createId("analysis");
await upsertSite(db, { id: siteId, name: new URL(baseUrl).hostname, baseUrl, createdAt: now, updatedAt: now });
await createAnalysis(db, { id: analysisId, siteId, status: "running", createdAt: now });

log(`Reading the sitemap of ${baseUrl}…`);
const { urls } = await auditSitemap(baseUrl, undefined, { maxUrls: 1 });
const robots = await defaultFetcher(`${baseUrl}/robots.txt`, { userAgent: GOOGLEBOT_UA, maxBytes: 500_000 })
  .then((response) => (response.status < 400 ? parseRobots(response.body, GOOGLEBOT_TOKEN) : null))
  .catch(() => null);
const capped = urls.slice(0, maxUrls);
await enqueueAnalysisCrawlUrls(db, {
  analysisId,
  siteId,
  urls: capped.map((url) => {
    const parsed = new URL(url);
    return { url, routeFamily: classifyUrlType(url), blocked: robots ? !robots.isAllowed(`${parsed.pathname}${parsed.search}`) : false };
  }),
});
log(`${urls.length.toLocaleString()} sitemap URLs; crawling ${capped.length.toLocaleString()} as Googlebot…`);

for (;;) {
  const batch = await listPendingCrawlUrls(db, analysisId, 50);
  if (!batch.length) break;
  const outcomes = await crawlGooglebotBatch(batch, undefined, 6);
  await saveCrawlBatch(db, { analysisId, outcomes });
  const coverage = await getCrawlCoverage(db, analysisId);
  log(`  ${(coverage.completedUrls + coverage.failedUrls).toLocaleString()} / ${coverage.totalUrls.toLocaleString()}`);
}

// Browser rendering uses Playwright when it is installed (optional).
const playwright = await import("playwright").catch(() => null);
if (!playwright) log("Playwright isn't installed, so the browser-rendering comparison is skipped (npm i -D playwright to enable it).");
async function renderPages(urls) {
  const proxy = process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {};
  const browser = await playwright.chromium.launch(proxy);
  try {
    const output = {};
    for (const url of urls) {
      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 }).catch(() => undefined);
        output[url] = await page.content();
      } catch {
        // Keep the other pages when one navigation fails.
      } finally {
        await page.close();
      }
    }
    return output;
  } finally {
    await browser.close();
  }
}

// A language model (DEEPSEEK_API_KEY or ANTHROPIC_API_KEY) matches content types across sites and polishes the plan.
let llm;
try {
  llm = createLlm(process.env);
} catch {
  log("No language model key set, so competitor sections are matched by URL name.");
}

const [coverage, examples] = await Promise.all([getCrawlCoverage(db, analysisId), listCrawlPageResults(db, analysisId, 50)]);
log("Running sampled checks, rendering comparison, repeatability test, and synthesis…");
const report = await runFullAnalysis({
  analysisId, siteId, name: new URL(baseUrl).hostname, baseUrl, maxPages: 25,
  competitorDomains: options("competitor"),
  targetMarkets: options("market"),
  crawlCoverage: { coverage, examples },
  renderPages: playwright ? renderPages : undefined,
  llm,
});
if (llm) report.plan = await synthesizePlanNarrative(llm, report.plan, report.findings);

if (args.includes("--json")) {
  console.log(JSON.stringify({ ...report, coverage }, null, 2));
} else {
  console.log(`\n${baseUrl}: ${coverage.totalUrls} sitemap URLs crawled (${coverage.emptyShellUrls} empty shells, ${coverage.httpErrorUrls} errors)\n`);
  if (coverage.families?.length) {
    console.log("Page type                 URLs  Empty  Errors  Noindex  No schema");
    for (const family of coverage.families.slice(0, 12)) {
      console.log(`${family.family.padEnd(24)}${String(family.urls).padStart(6)}${String(family.emptyShells).padStart(7)}${String(family.errors).padStart(8)}${String(family.noindex).padStart(9)}${String(family.missingStructuredData).padStart(11)}`);
    }
    console.log("");
  }
  for (const finding of report.findings) {
    console.log(`[${finding.severity}] (${finding.organicImpactScore}) ${finding.title}\n  ${finding.summary}\n`);
  }
  if (report.rendering.comparisons.length) {
    console.log("Rendered in a browser             HTML text  Rendered  Verdict");
    for (const entry of report.rendering.comparisons) {
      console.log(`${new URL(entry.url).pathname.slice(0, 32).padEnd(32)}${String(entry.rawTextLength).padStart(11)}${String(entry.renderedTextLength).padStart(10)}  ${entry.verdict}`);
    }
    console.log("");
  }
  if (report.competition?.rows.length) {
    console.log("Content type                  You  " + report.competition.competitors.filter((c) => c.analyzed).slice(0, 3).map((c) => c.domain.slice(0, 18).padStart(19)).join("") + "  Status");
    for (const row of report.competition.rows.slice(0, 12)) {
      const cells = report.competition.competitors.filter((c) => c.analyzed).slice(0, 3).map((c) => String(row.competitors.find((entry) => entry.domain === c.domain)?.pages ?? 0).padStart(19)).join("");
      console.log(`${row.label.slice(0, 28).padEnd(28)}${String(row.you.pages).padStart(5)}  ${cells}  ${row.status}`);
    }
    console.log("");
    for (const insight of report.competition.insights) console.log(`- ${insight}`);
    console.log("");
  }
  console.log(`Highest-impact opportunity: ${report.plan.highestImpactOpportunity}`);
}
