import { env } from "cloudflare:workers";
import { getDataset, getSource, upsertSource } from "@organic-growth/db";
import { pullSupabaseSource } from "../../../../../src/supabase-source";
import { fail, json } from "../../../../../src/server";

/** Reads a Supabase table source again, now: up to 40,000 rows, upserted as records. */
export async function POST(_request: Request, context: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await context.params;
  const source = await getSource(env.DB, sourceId);
  if (!source) return fail("Source not found.", 404);
  if (source.kind !== "supabase") return fail("Only a Supabase table source can be pulled; other sources are collected by a crawl.");
  const dataset = await getDataset(env.DB, source.datasetId);
  if (!dataset) return fail("Dataset not found.", 404);
  try {
    const result = await pullSupabaseSource(env.DB, source, dataset, env.OAUTH_ENCRYPTION_KEY);
    return json({ ...result, source: await getSource(env.DB, sourceId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await upsertSource(env.DB, { ...source, error: message.slice(0, 300) });
    return fail(message, 502);
  }
}
