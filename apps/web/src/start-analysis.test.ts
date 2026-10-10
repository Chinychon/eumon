import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAnalysis, getLatestAnalysisForSite, upsertSite, type D1Like } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { startAnalysis, type AnalysisWorkflow } from "./start-analysis.ts";

const AT = "2026-10-10T00:00:00.000Z";
const site = { id: "s", workspaceId: "w", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT };

async function setup(): Promise<D1Like> {
  const db = openSqliteD1();
  await db.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('w', 'w', 'w', ?)`).bind(AT).run();
  await upsertSite(db, site);
  return db;
}
function workflow(fail = false): AnalysisWorkflow & { created: unknown[] } {
  const created: unknown[] = [];
  return {
    created,
    async create(options) { if (fail) throw new Error("Workflows unavailable"); created.push(options); return {}; },
    async get() { return { terminate: async () => undefined }; },
  };
}

describe("startAnalysis", () => {
  it("queues a run: the analysis row, the Workflow instance, and one use of the daily allowance", async () => {
    const db = await setup();
    const flow = workflow();
    const started = await startAnalysis(db, flow, site, { full: false });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(started.status, "queued");
    assert.deepEqual(flow.created, [{ id: started.analysisId, params: { analysisId: started.analysisId, siteId: "s", full: false } }]);
    assert.equal((await getLatestAnalysisForSite(db, "s"))?.status, "queued");
  });

  it("refuses while a run is in progress, without using the allowance", async () => {
    const db = await setup();
    await createAnalysis(db, { id: "a1", siteId: "s", status: "running", createdAt: new Date().toISOString() });
    const started = await startAnalysis(db, workflow(), site, { full: false });
    assert.deepEqual(started, { ok: false, status: 409, error: "An analysis is already running for this site." });
    assert.equal(Number((await db.prepare("SELECT COUNT(*) AS n FROM analyses").first<{ n: number }>())?.n), 1, "no second run");
  });

  it("refuses once the daily allowance is used, and creates no run", async () => {
    const db = await setup();
    for (let i = 0; i < 3; i++) {
      const started = await startAnalysis(db, workflow(), site, { full: false });
      assert.equal(started.ok, true, `run ${i + 1}`);
      await db.prepare("UPDATE analyses SET status = 'completed' WHERE site_id = 's'").run();
    }
    const refused = await startAnalysis(db, workflow(), site, { full: false });
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.status, 429);
    assert.equal(Number((await db.prepare("SELECT COUNT(*) AS n FROM analyses").first<{ n: number }>())?.n), 3);
  });

  it("marks the run failed and gives the allowance back when the Workflow cannot be created", async () => {
    const db = await setup();
    const started = await startAnalysis(db, workflow(true), site, { full: false });
    assert.deepEqual(started, { ok: false, status: 503, error: "Workflows unavailable" });
    assert.equal((await getLatestAnalysisForSite(db, "s"))?.status, "failed");
    await db.prepare("UPDATE analyses SET status = 'completed'").run();
    for (let i = 0; i < 3; i++) {
      assert.equal((await startAnalysis(db, workflow(), site, { full: false })).ok, true, "all three runs are still available");
      await db.prepare("UPDATE analyses SET status = 'completed' WHERE site_id = 's'").run();
    }
  });
});
