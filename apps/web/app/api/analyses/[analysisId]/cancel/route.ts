import { env } from "cloudflare:workers";
import { getAnalysisJob, updateAnalysisStatus } from "@organic-growth/db";
import { fail, json } from "../../../../../src/server";
import { requireOwned } from "../../../../../src/guard";

/** Stops a queued or running analysis: ends its Workflow and records it as cancelled. */
export async function POST(request: Request, context: { params: Promise<{ analysisId: string }> }) {
  const { analysisId } = await context.params;
  const access = await requireOwned(request, "analysis", analysisId, "write");
  if (access instanceof Response) return access;
  const job = await getAnalysisJob(env.DB, analysisId);
  if (!job) return fail("Analysis not found.", 404);
  if (job.status !== "queued" && job.status !== "running") return fail("This analysis has already finished.", 409);
  try {
    await (await env.ANALYSIS_WORKFLOW.get(analysisId)).terminate();
  } catch {
    // The instance may already be gone (a restarted dev server ends local runs); the record still needs closing.
  }
  await updateAnalysisStatus(env.DB, analysisId, "cancelled", { completedAt: new Date().toISOString() });
  return json({ cancelled: true });
}
