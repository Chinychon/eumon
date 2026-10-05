import { env } from "cloudflare:workers";
import { createId, type DatasetField } from "@organic-growth/core";
import { getLatestJob, getSiteScope, listDatasets, listSources, upsertDataset } from "@organic-growth/db";
import { validateFields } from "../../../../../src/datasets";
import { fail, findSite, json, readJson } from "../../../../../src/server";

export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await findSite(siteId))) return fail("Site not found.", 404);
  const datasets = await listDatasets(env.DB, siteId);
  const detailed = await Promise.all(datasets.map(async (dataset) => ({
    ...dataset,
    sources: await listSources(env.DB, dataset.id),
    latestJob: await getLatestJob(env.DB, dataset.id),
  })));
  return json({ datasets: detailed, scope: await getSiteScope(env.DB, siteId) });
}

/** Creates a dataset by hand, e.g. for data the owner already has as a spreadsheet. */
export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await findSite(siteId))) return fail("Site not found.", 404);
  const body = await readJson<{ name?: unknown; entityType?: unknown; description?: unknown; fields?: unknown; keyField?: unknown }>(request);
  if (!body || typeof body.name !== "string" || !body.name.trim()) return fail("Name the dataset, e.g. “Malls”.");
  const fields = validateFields(body.fields);
  if (typeof fields === "string") return fail(fields);
  const keyField = typeof body.keyField === "string" && fields.some((field) => field.key === body.keyField) ? body.keyField : fields[0]!.key;
  const now = new Date().toISOString();
  const dataset = {
    id: createId("ds"), siteId, name: body.name.trim().slice(0, 60),
    entityType: typeof body.entityType === "string" && body.entityType.trim() ? body.entityType.trim().slice(0, 40) : "record",
    description: typeof body.description === "string" ? body.description.slice(0, 500) : "",
    fields: fields.map((field): DatasetField => (field.key === keyField ? { ...field, required: true } : field)),
    keyField, pageIdeas: [{ name: "One page per record", groupBy: [], exampleTitle: "", exampleQueries: [], intent: "commercial", rationale: "" }],
    status: "active" as const, createdAt: now, updatedAt: now,
  };
  await upsertDataset(env.DB, dataset);
  return json({ dataset }, 201);
}
