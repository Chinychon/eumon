import { env } from "cloudflare:workers";
import { getDataset, listAllRecords } from "@organic-growth/db";
import { estimatePagePotential } from "@organic-growth/pages";
import { fail, json } from "../../../../../src/server";
import { requireOwned } from "../../../../../src/guard";

/** Same cap as page generation, so the estimate covers what a template can generate. */
const MAX_RECORDS = 20_000;

/** How many landing pages the dataset's records support, per page idea and suggested grouping. */
export async function GET(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
  const access = await requireOwned(request, "dataset", datasetId, "read");
  if (access instanceof Response) return access;
  const dataset = await getDataset(env.DB, datasetId);
  if (!dataset) return fail("Dataset not found.", 404);
  const records = await listAllRecords(env.DB, datasetId, MAX_RECORDS);
  return json({ records: records.length, estimates: estimatePagePotential(dataset, records) });
}
