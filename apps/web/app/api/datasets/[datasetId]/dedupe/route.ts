import { env } from "cloudflare:workers";
import { getDataset } from "@organic-growth/db";
import { mergeDuplicateRecords } from "../../../../../src/dedupe";
import { appLlm, fail, json, llmFailure } from "../../../../../src/server";

/** Merges records that name the same entity, e.g. after a CSV import or a collection run. */
export async function POST(_request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
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
