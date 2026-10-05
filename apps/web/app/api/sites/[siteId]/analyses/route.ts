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
  if (!site.githubOwner || !site.githubRepo || !site.githubInstallationId) {
    return Response.json({ error: "Connect a GitHub repository before starting an analysis." }, { status: 409 });
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
