import { env } from "cloudflare:workers";
import { analysisStalled, estimateCrawl, getAnalysisJob, getCrawlProgress } from "@organic-growth/db";

/** Live state of a running analysis: stage timeline, crawl counts, pace, and time left. */
export async function GET(_request: Request, context: { params: Promise<{ analysisId: string }> }) {
  const { analysisId } = await context.params;
  const job = await getAnalysisJob(env.DB, analysisId);
  if (!job) return Response.json({ error: "Analysis not found." }, { status: 404 });
  const crawl = await getCrawlProgress(env.DB, analysisId);
  return Response.json({
    status: job.status,
    progress: job.progress,
    error: job.error,
    summary: job.summary,
    stalled: analysisStalled(job),
    queuedAt: job.createdAt,
    now: new Date().toISOString(),
    crawl: { ...crawl, ...estimateCrawl(crawl) },
  }, { headers: { "Cache-Control": "no-store" } });
}
