import { env } from "cloudflare:workers";
import { createId } from "@organic-growth/core";
import { createAnalysis, getLatestAnalysisForSite, getSite, updateAnalysisStatus } from "@organic-growth/db";

export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const job = await getLatestAnalysisForSite(env.DB, siteId);
  if (!job) return Response.json({ analysis: null }, { headers: { "Cache-Control": "no-store" } });
  return Response.json({ analysis: {
    analysisId: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
    report: job.status === "completed" ? job.report : undefined,
  } }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return Response.json({ error: "Site not found." }, { status: 404 });
  const running = await getLatestAnalysisForSite(env.DB, siteId);
  // A run that has not finished in 3 hours is treated as abandoned (e.g. a restarted dev server).
  if (running && (running.status === "queued" || running.status === "running") && Date.now() - Date.parse(running.createdAt) < 3 * 3_600_000) {
    return Response.json({ error: "An analysis is already running for this site." }, { status: 409 });
  }

  const analysisId = createId("analysis");
  const createdAt = new Date().toISOString();
  await createAnalysis(env.DB, { id: analysisId, siteId, status: "queued", createdAt });
  try {
    await env.ANALYSIS_WORKFLOW.create({
      id: analysisId,
      params: { analysisId, siteId },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not queue analysis.";
    await updateAnalysisStatus(env.DB, analysisId, "failed", { error: message, completedAt: new Date().toISOString() });
    return Response.json({ error: message }, { status: 503 });
  }
  return Response.json({ analysisId, status: "queued" }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
