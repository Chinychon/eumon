import { env } from "cloudflare:workers";
import { getAnalysisJob } from "@organic-growth/db";

export async function GET(_request: Request, context: { params: Promise<{ analysisId: string }> }) {
  const { analysisId } = await context.params;
  const job = await getAnalysisJob(env.DB, analysisId);
  if (!job) return Response.json({ error: "Analysis not found." }, { status: 404 });
  return Response.json({
    analysisId: job.id,
    siteId: job.siteId,
    status: job.status,
    progress: job.progress,
    error: job.error,
    summary: job.summary,
    report: job.status === "completed" ? job.report : undefined,
  }, { headers: { "Cache-Control": "no-store" } });
}
