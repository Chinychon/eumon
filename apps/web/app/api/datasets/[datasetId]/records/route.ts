import { env } from "cloudflare:workers";
import { getDataset, listRecords } from "@organic-growth/db";
import { fail, json } from "../../../../../src/server";

export async function GET(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
  if (!(await getDataset(env.DB, datasetId))) return fail("Dataset not found.", 404);
  const params = new URL(request.url).searchParams;
  const result = await listRecords(env.DB, datasetId, {
    limit: Math.min(Number(params.get("limit")) || 50, 200),
    offset: Math.max(Number(params.get("offset")) || 0, 0),
    search: params.get("q") ?? undefined,
  });
  return json(result);
}
