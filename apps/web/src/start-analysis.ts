import { createId, type SiteRecord } from "@organic-growth/core";
import { analysisStalled, createAnalysis, getLatestAnalysisForSite, updateAnalysisStatus, type D1Like } from "@organic-growth/db";
import { charge, refund } from "./limits.ts";

/** The parts of the `ANALYSIS_WORKFLOW` binding a start uses. */
export type AnalysisWorkflow = {
  create(options: { id: string; params: { analysisId: string; siteId: string; full: boolean } }): Promise<unknown>;
  get(id: string): Promise<{ terminate(): Promise<unknown> }>;
};

export type Started = { ok: true; analysisId: string; status: "queued" } | { ok: false; status: 409 | 429 | 503; error: string };

/**
 * Queues an analysis for a site: refused while one is running, or once the
 * workspace's daily allowance is used; a stalled run is closed first. The
 * allowance is charged only when the run will start, and refunded if the
 * Workflow cannot be created. `full` re-crawls every page instead of reusing
 * unchanged results from the last crawl.
 */
export async function startAnalysis(db: D1Like, workflow: AnalysisWorkflow, site: Pick<SiteRecord, "id" | "workspaceId">, options: { full: boolean }): Promise<Started> {
  const latest = await getLatestAnalysisForSite(db, site.id);
  const active = latest && (latest.status === "queued" || latest.status === "running");
  if (active && !analysisStalled(latest)) return { ok: false, status: 409, error: "An analysis is already running for this site." };
  const refusal = await charge(db, site.workspaceId!, "analysesPerDay");
  if (refusal) return { ok: false, status: 429, error: refusal };
  if (active) {
    // A stalled run is closed before the new one starts, so it can't come back and write alongside it.
    await workflow.get(latest.id).then((instance) => instance.terminate()).catch(() => undefined);
    await updateAnalysisStatus(db, latest.id, "failed", { error: "It stopped making progress, so a new run replaced it.", completedAt: new Date().toISOString() });
  }
  const analysisId = createId("analysis");
  await createAnalysis(db, { id: analysisId, siteId: site.id, status: "queued", createdAt: new Date().toISOString() });
  try {
    await workflow.create({ id: analysisId, params: { analysisId, siteId: site.id, full: options.full } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not queue analysis.";
    await updateAnalysisStatus(db, analysisId, "failed", { error: message, completedAt: new Date().toISOString() });
    await refund(db, site.workspaceId!, "analysesPerDay");
    return { ok: false, status: 503, error: message };
  }
  return { ok: true, analysisId, status: "queued" };
}
