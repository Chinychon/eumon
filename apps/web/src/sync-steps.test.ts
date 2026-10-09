import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_SITE_ID } from "@organic-growth/agents";
import { createAnalysis, enqueueAnalysisCrawlUrls, listMetricSeries, listSyncRuns, saveCrawlBatch, updateAnalysisStatus, updateSiteGscProperty, upsertSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { SEARCH_CONSOLE_SCOPE } from "./gsc-auth.ts";
import { startSync, syncSite, syncSites, type StepLike, type SyncDeps } from "./sync-steps.ts";

const now = new Date("2026-10-07T04:15:00Z");
const today = "2026-10-07";
const at = now.toISOString();

async function addSite(db: ReturnType<typeof openSqliteD1>, id: string, property = `sc-domain:${id}.com`) {
  await upsertSite(db, { id, name: `${id}.com`, baseUrl: `https://${id}.com`, createdAt: at, updatedAt: at });
  if (property) await updateSiteGscProperty(db, id, property);
}

async function publishPages(db: ReturnType<typeof openSqliteD1>, siteId: string, count: number) {
  await db.prepare(`INSERT INTO datasets (id, site_id, name, entity_type, description, fields_json, key_field, page_ideas_json, status, created_at, updated_at) VALUES (?, ?, 'T', 't', '', '[]', 'name', '[]', 'active', ?, ?)`).bind(`d-${siteId}`, siteId, at, at).run();
  await db.prepare(`INSERT INTO page_templates (id, site_id, dataset_id, name, config_json, status, created_at, updated_at) VALUES (?, ?, ?, 'T', '{}', 'active', ?, ?)`).bind(`t-${siteId}`, siteId, `d-${siteId}`, at, at).run();
  for (let index = 0; index < count; index++) {
    await db.prepare(`INSERT INTO generated_pages (id, site_id, template_id, path, group_key, title, description, content_json, quality_score, quality_issues_json, status, published_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'x', '', '{}', 1, '[]', 'published', ?, ?, ?)`).bind(`p-${siteId}-${index}`, siteId, `t-${siteId}`, `/guides/${index}`, String(index), at, at, at).run();
  }
}

async function crawl(db: ReturnType<typeof openSqliteD1>, siteId: string, count: number) {
  const id = `a-${siteId}`;
  await createAnalysis(db, { id, siteId, status: "running", createdAt: at });
  const urls = Array.from({ length: count }, (_, index) => `https://${siteId}.com/doctors/d${index}`);
  await enqueueAnalysisCrawlUrls(db, { analysisId: id, siteId, urls: urls.map((url) => ({ url, routeFamily: "doctors" })) });
  await saveCrawlBatch(db, { analysisId: id, outcomes: urls.map((url) => ({ url, page: {
    url, status: 200, finalUrl: url, hreflang: [], jsonLdCount: 0, contentLength: 1, isEmptyShell: false, headingOutline: [], internalLinkCount: 0,
    rawTextLength: 500, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot" as const, routeFamily: "doctors",
  } })) });
  await updateAnalysisStatus(db, id, "completed", { completedAt: at });
}

/** A step runner that remembers every step and how many inspections it asked for. */
function recorder() {
  const steps: Array<{ name: string; inspections: number }> = [];
  let current: { name: string; inspections: number } | null = null;
  const step: StepLike = {
    do: async (name, fn) => {
      current = { name, inspections: 0 };
      steps.push(current);
      try { return await fn(); } finally { current = null; }
    },
  };
  return { steps, step, count: () => { if (current) current.inspections++; } };
}

const PASS = () => new Response(JSON.stringify({ inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed" } } }));
const asked = (init?: RequestInit) => (JSON.parse(String(init?.body ?? "{}")) as { inspectionUrl?: string }).inspectionUrl;

function deps(db: ReturnType<typeof openSqliteD1>, count: () => void, answer: (url: string, init: RequestInit | undefined, n: number) => Response | Promise<Response>): SyncDeps {
  let n = 0;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (!url.includes("urlInspection")) return new Response(JSON.stringify({ rows: [] }));
    count();
    return answer(url, init, ++n);
  }) as typeof fetch;
  return { db, keys: {}, now: () => now, google: () => ({ connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE] }), fetchFn }) };
}

describe("sync steps", () => {
  it("asks Google at most 40 times a step: 100 Eumon pages, then 47 coverage steps, within the day's quota", async () => {
    const db = openSqliteD1();
    await addSite(db, "s");
    await publishPages(db, "s", 130);
    await crawl(db, "s", 2000);
    const { steps, step, count } = recorder();
    const notes = await syncSite(deps(db, count, PASS), step, "s", "daily", { used: 0 });
    assert.ok(steps.every((entry) => entry.inspections <= 40), `most inspections in a step: ${Math.max(...steps.map((entry) => entry.inspections))}`);
    assert.ok(notes.includes("inspected 100 pages"), notes.join("; "));
    assert.ok(notes.includes("coverage: inspected 1,880 in 47 steps"), notes.join("; "));
    assert.equal(steps.reduce((total, entry) => total + entry.inspections, 0), 1980, "under the 2,000-a-day quota");
    assert.equal(steps.filter((entry) => entry.name.startsWith("s/pages-")).length, 3);
    assert.equal(steps.filter((entry) => entry.name.startsWith("s/coverage-")).length, 47);
    assert.deepEqual((await listMetricSeries(db, "s", ["pages_indexed"], today, today)).pages_indexed, [{ day: today, value: 100 }]);
    const runs = await listSyncRuns(db, "s");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.trigger, "daily");
    assert.deepEqual(runs[0]!.notes, notes);
  });

  it("stops the day at a refusal and keeps the statuses saved before it", async () => {
    const db = openSqliteD1();
    await addSite(db, "s");
    await publishPages(db, "s", 30);
    await crawl(db, "s", 250);
    const { steps, step, count } = recorder();
    const notes = await syncSite(deps(db, count, (_url, _init, n) => (n > 120 ? new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), { status: 429 }) : PASS())), step, "s", "daily", { used: 0 });
    assert.ok(notes.includes("inspected 30 pages"), notes.join("; "));
    assert.ok(notes.includes("coverage: inspected 90 in 3 steps"), notes.join("; "));
    assert.ok(notes.includes("coverage stopped: Google answered 429"), notes.join("; "));
    assert.ok(!steps.some((entry) => entry.name === "s/coverage-4"), "no step after the refusal");
    assert.ok(steps.reduce((total, entry) => total + entry.inspections, 0) <= 130, "stopped within the batch after the refusal");
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM url_index_status WHERE site_id = 's'").first<{ n: number }>())?.n, 90);
  });

  it("inspects ten at a time, and leaves a page Google won't inspect for tomorrow", async () => {
    const db = openSqliteD1();
    await addSite(db, "s");
    await publishPages(db, "s", 12);
    let inFlight = 0;
    let most = 0;
    const { step, count } = recorder();
    const notes = await syncSite(deps(db, count, async (_url, init) => {
      inFlight++; most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 3));
      inFlight--;
      if (asked(init)?.endsWith("/guides/3")) return new Response(JSON.stringify({ error: { message: "URL is not part of this property" } }), { status: 403 });
      return PASS();
    }), step, "s", "manual", { used: 0 });
    assert.ok(most > 1 && most <= 10, `at most ${most} in flight`);
    assert.ok(notes.includes("inspected 11 pages"), notes.join("; "));
    assert.ok(!notes.some((note) => /stopped/.test(note)), notes.join("; "));
  });

  it("records the run with a note, and no inspection steps, when Google access is revoked", async () => {
    const db = openSqliteD1();
    await addSite(db, "s");
    await publishPages(db, "s", 5);
    const { steps, step } = recorder();
    const revoked: SyncDeps = { db, keys: {}, now: () => now, google: () => ({ connect: async () => { throw new Error("Google access token refresh failed (400)."); } }) };
    const notes = await syncSite(revoked, step, "s", "daily", { used: 0 });
    assert.ok(notes.some((note) => note.startsWith("google failed")), notes.join("; "));
    assert.deepEqual(steps.map((entry) => entry.name), ["s/sources", "s/record"]);
    assert.equal((await listSyncRuns(db, "s")).length, 1);
  });

  it("runs one site for a manual sync, every site daily, and never asks Google about the demo", async () => {
    const db = openSqliteD1();
    await addSite(db, "s");
    await addSite(db, "b");
    await upsertSite(db, { id: DEMO_SITE_ID, name: "Demo", baseUrl: "https://demo-clinic.example", gscProperty: "sc-domain:demo-clinic.example", createdAt: at, updatedAt: at });
    await publishPages(db, "s", 3);
    await publishPages(db, "b", 3);
    const { steps, step, count } = recorder();
    const manual = await syncSites(deps(db, count, PASS), step, { siteId: "s", trigger: "manual" });
    assert.deepEqual(Object.keys(manual), ["s"]);
    assert.ok(steps.every((entry) => entry.name.startsWith("s/")), steps.map((entry) => entry.name).join(", "));
    assert.equal((await listSyncRuns(db, "s"))[0]?.trigger, "manual");
    assert.equal((await listSyncRuns(db, "b")).length, 0);
    const daily = await syncSites(deps(db, count, PASS), step, { trigger: "daily" });
    assert.deepEqual(Object.keys(daily).sort(), ["b", "s", DEMO_SITE_ID].sort());
    assert.equal(steps.filter((entry) => entry.name.startsWith(`${DEMO_SITE_ID}/`) && entry.inspections > 0).length, 0, "the demo's property is fictional");
    assert.ok((await listSyncRuns(db, DEMO_SITE_ID))[0]!.notes[0]!.startsWith("demo site"));
  });

  it("pauses coverage when the instance's step budget is reached, and says so", async () => {
    const db = openSqliteD1();
    await addSite(db, "s");
    await crawl(db, "s", 500);
    const { steps, step, count } = recorder();
    const result = await syncSites(deps(db, count, PASS), step, { trigger: "daily" }, { stepBudget: 6 });
    assert.match(result.s!, /coverage paused: step budget/);
    assert.ok(steps.length <= 7, `${steps.length} steps: the budget plus the record step`);
    assert.ok(steps.some((entry) => entry.name.startsWith("s/coverage-")), "some coverage ran first");
  });
});

describe("startSync", () => {
  it("names the daily instance after the day, tolerates one that exists, and gives a manual sync its own id", async () => {
    const created: Array<{ id: string; params: unknown }> = [];
    const env = { SEARCH_SYNC_WORKFLOW: { create: async (options: { id: string; params: unknown }) => { created.push(options); return { id: options.id }; } } };
    assert.deepEqual(await startSync(env, { trigger: "daily" }, now), { id: "daily-2026-10-07", created: true });
    assert.deepEqual(created[0], { id: "daily-2026-10-07", params: { trigger: "daily" } });
    const manual = await startSync(env, { siteId: "s", trigger: "manual" }, now);
    assert.match(manual.id, /^manual-s-/);
    assert.deepEqual(created[1]!.params, { siteId: "s", trigger: "manual" });
    const taken = { SEARCH_SYNC_WORKFLOW: { create: async () => { throw new Error("Workflow instance with id daily-2026-10-07 already exists"); } } };
    assert.deepEqual(await startSync(taken, { trigger: "daily" }, now), { id: "daily-2026-10-07", created: false });
    const broken = { SEARCH_SYNC_WORKFLOW: { create: async () => { throw new Error("binding unavailable"); } } };
    await assert.rejects(() => startSync(broken, { trigger: "daily" }, now), /binding unavailable/);
  });
});
