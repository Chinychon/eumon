import { env } from "cloudflare:workers";
import { getJob, listScrapeFailures, scrapeQueueCounts } from "@organic-growth/db";
import { fail, json } from "../../../../src/server";
import { requireOwned } from "../../../../src/guard";

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  const access = await requireOwned(request, "job", jobId, "read");
  if (access instanceof Response) return access;
  const job = await getJob(env.DB, jobId);
  if (!job) return fail("Job not found.", 404);
  const [counts, failures] = await Promise.all([scrapeQueueCounts(env.DB, jobId), listScrapeFailures(env.DB, jobId, 8)]);
  return json({ job, counts, failures });
}
