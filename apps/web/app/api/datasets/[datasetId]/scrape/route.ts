import { env } from "cloudflare:workers";
import { createId } from "@organic-growth/core";
import { createJob, getDataset, getLatestJob, listSources, updateJob } from "@organic-growth/db";
import { charge, refund } from "../../../../../src/limits";
import { fail, json, readJson } from "../../../../../src/server";
import { requireOwned } from "../../../../../src/guard";

export async function POST(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
  const access = await requireOwned(request, "dataset", datasetId, "write");
  if (access instanceof Response) return access;
  const dataset = await getDataset(env.DB, datasetId);
  if (!dataset) return fail("Dataset not found.", 404);
  const running = await getLatestJob(env.DB, datasetId);
  // A run that has not finished in 6 hours is treated as abandoned (e.g. a restarted dev server).
  if (running && (running.status === "queued" || running.status === "running") && Date.now() - Date.parse(running.createdAt) < 6 * 3_600_000) {
    return fail("A collection run is already in progress for this dataset.", 409);
  }
  const body = (await readJson<{ sourceIds?: unknown }>(request)) ?? {};
  const approved = (await listSources(env.DB, datasetId)).filter((source) => source.status === "approved");
  const requested = Array.isArray(body.sourceIds) ? body.sourceIds.filter((id): id is string => typeof id === "string") : approved.map((source) => source.id);
  const sources = approved.filter((source) => requested.includes(source.id));
  const sourceIds = sources.map((source) => source.id);
  if (!sourceIds.length) return fail("Approve at least one source first.", 409);
  const pages = sources.reduce((sum, source) => sum + source.maxPages, 0);
  const refusal = await charge(env.DB, access.site.workspaceId!, "scrapePagesPerDay", pages);
  if (refusal) return fail(refusal, 429);

  const jobId = createId("job");
  await createJob(env.DB, { id: jobId, siteId: dataset.siteId, kind: "scrape", subjectId: datasetId });
  try {
    await env.SCRAPE_WORKFLOW.create({ id: jobId, params: { jobId, siteId: dataset.siteId, datasetId, sourceIds } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start collection.";
    await updateJob(env.DB, jobId, { status: "failed", error: message });
    await refund(env.DB, access.site.workspaceId!, "scrapePagesPerDay", pages);
    return fail(message, 503);
  }
  return json({ jobId, status: "queued" }, 202);
}
