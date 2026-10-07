import { env } from "cloudflare:workers";
import { DEMO_SITE_ID, startDemoRun } from "@organic-growth/agents";
import { createId } from "@organic-growth/core";
import { analysisStalled, crawlPace, createAnalysis, getAnalysisJob, getLatestAnalysisForSite, getPreviousCompletedAnalysis, getSite, updateAnalysisStatus } from "@organic-growth/db";
import { readJson } from "../../../../../src/server";

export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const job = await getLatestAnalysisForSite(env.DB, siteId);
  if (!job) return Response.json({ analysis: null }, { headers: { "Cache-Control": "no-store" } });
  // While a re-run is in progress, the last finished report stays readable.
  const running = job.status === "queued" || job.status === "running";
  const last = running ? await getPreviousCompletedAnalysis(env.DB, siteId, job.id) : null;
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
  // `full` re-crawls every page; otherwise unchanged results from the last crawl are reused.
  const full = (await readJson<{ full?: unknown }>(request))?.full === true;
  const site = await getSite(env.DB, siteId);
  if (!site) return Response.json({ error: "Site not found." }, { status: 404 });
  const latest = await getLatestAnalysisForSite(env.DB, siteId);
  if (latest && (latest.status === "queued" || latest.status === "running") && !analysisStalled(latest)) {
    return Response.json({ error: "An analysis is already running for this site." }, { status: 409 });
  }

  const analysisId = createId("analysis");
  // The demo site is served from memory, so its run is simulated as the progress view polls.
  if (siteId === DEMO_SITE_ID) {
    await startDemoRun(env.DB, { analysisId, full });
    return Response.json({ analysisId, status: "running" }, { status: 202, headers: { "Cache-Control": "no-store" } });
  }
  const createdAt = new Date().toISOString();
  await createAnalysis(env.DB, { id: analysisId, siteId, status: "queued", createdAt });
  try {
    await env.ANALYSIS_WORKFLOW.create({
      id: analysisId,
      params: { analysisId, siteId, full },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not queue analysis.";
    await updateAnalysisStatus(env.DB, analysisId, "failed", { error: message, completedAt: new Date().toISOString() });
    return Response.json({ error: message }, { status: 503 });
  }
  return Response.json({ analysisId, status: "queued" }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
