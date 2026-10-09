import { env } from "cloudflare:workers";
import { datasetInventory } from "@organic-growth/agents";
import { getDataset } from "@organic-growth/db";
import { fail, json } from "../../../../../src/server";

/** What the dataset's records say about the site's content: fills per field (by language), duplicates, thin and missing pages. */
export async function GET(_request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
  const dataset = await getDataset(env.DB, datasetId);
  if (!dataset) return fail("Dataset not found.", 404);
  return json({ inventory: await datasetInventory(env.DB, dataset) });
}
