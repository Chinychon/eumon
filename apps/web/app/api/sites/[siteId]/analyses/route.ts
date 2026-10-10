import { env } from "cloudflare:workers";
import { DEMO_SITE_ID, startDemoRun } from "@organic-growth/agents";
import { createId } from "@organic-growth/core";
import { analysisStalled, crawlPace, getAnalysisJob, getLatestAnalysisForSite, getPreviousCompletedAnalysis, updateAnalysisStatus } from "@organic-growth/db";
import { requireSite } from "../../../../../src/guard";
import { charge } from "../../../../../src/limits";
import { startAnalysis } from "../../../../../src/start-analysis";
import { fail, readJson } from "../../../../../src/server";

export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "read");
  if (access instanceof Response) return access;
  const job = await getLatestAnalysisForSite(env.DB, siteId);
  if (!job) return Response.json({ analysis: null }, { headers: { "Cache-Control": "no-store" } });
  // While a re-run is in progress, or after one was cancelled or failed, the last finished report stays readable.
  const last = job.status === "completed" ? null : await getPreviousCompletedAnalysis(env.DB, siteId, job.id);
  const [previous, pace] = await Promise.all([last ? getAnalysisJob(env.DB, last.id) : null, crawlPace(env.DB, siteId)]);
  return Response.json({
    analysis: {
      analysisId: job.id,
      status: job.status,
      progress: job.progress,
      error: job.error,
      report: job.status === "completed" ? job.report : undefined,
    },
    previous: previous?.report ? { analysisId: previous.id, report: previous.report } : null,
    pace,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const { site } = access;
  // `full` re-crawls every page; otherwise unchanged results from the last crawl are reused.
  const full = (await readJson<{ full?: unknown }>(request))?.full === true;
  // The demo site is served from memory, so its run is simulated as the progress view polls.
  if (siteId === DEMO_SITE_ID) {
    const latest = await getLatestAnalysisForSite(env.DB, siteId);
    const active = latest && (latest.status === "queued" || latest.status === "running");
    if (active && !analysisStalled(latest)) return Response.json({ error: "An analysis is already running for this site." }, { status: 409 });
    const refusal = await charge(env.DB, site.workspaceId!, "analysesPerDay");
    if (refusal) return fail(refusal, 429);
    if (active) await updateAnalysisStatus(env.DB, latest.id, "failed", { error: "It stopped making progress, so a new run replaced it.", completedAt: new Date().toISOString() });
    const analysisId = createId("analysis");
    await startDemoRun(env.DB, { analysisId, full });
    return Response.json({ analysisId, status: "running" }, { status: 202, headers: { "Cache-Control": "no-store" } });
  }
  const started = await startAnalysis(env.DB, env.ANALYSIS_WORKFLOW, site, { full });
  if (!started.ok) return Response.json({ error: started.error }, { status: started.status });
  return Response.json({ analysisId: started.analysisId, status: started.status }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
