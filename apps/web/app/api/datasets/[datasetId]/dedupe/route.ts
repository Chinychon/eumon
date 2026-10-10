import { env } from "cloudflare:workers";
import { getDataset } from "@organic-growth/db";
import { mergeDuplicateRecords } from "../../../../../src/dedupe";
import { appLlm, fail, json, llmFailure } from "../../../../../src/server";
import { requireOwned } from "../../../../../src/guard";

/** Merges records that name the same entity, e.g. after a CSV import or a collection run. */
export async function POST(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
  const access = await requireOwned(request, "dataset", datasetId, "write");
  if (access instanceof Response) return access;
  const dataset = await getDataset(env.DB, datasetId);
  if (!dataset) return fail("Dataset not found.", 404);
  const llm = appLlm();
  if (llm instanceof Response) return llm;
  try {
    return json({ merges: await mergeDuplicateRecords(env.DB, llm, dataset) });
  } catch (error) {
    return llmFailure(error);
  }
}
