import { env } from "cloudflare:workers";
import type { Dataset } from "@organic-growth/core";
import { deleteDataset, getDataset, upsertDataset } from "@organic-growth/db";
import { validateFields } from "../../../../src/datasets";
import { fail, json, readJson } from "../../../../src/server";

export async function PATCH(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
  const dataset = await getDataset(env.DB, datasetId);
  if (!dataset) return fail("Dataset not found.", 404);
  const body = await readJson<Partial<Record<keyof Dataset, unknown>>>(request);
  if (!body) return fail("Send the changes as JSON.");
  const next: Dataset = { ...dataset, updatedAt: new Date().toISOString() };
  if (typeof body.name === "string" && body.name.trim()) next.name = body.name.trim().slice(0, 60);
  if (typeof body.entityType === "string" && body.entityType.trim()) next.entityType = body.entityType.trim().slice(0, 40);
  if (typeof body.description === "string") next.description = body.description.slice(0, 500);
  if (body.fields !== undefined) {
    const fields = validateFields(body.fields);
    if (typeof fields === "string") return fail(fields);
    next.fields = fields;
  }
  if (typeof body.keyField === "string") next.keyField = body.keyField;
  if (!next.fields.some((field) => field.key === next.keyField)) return fail("The key field must be one of the dataset's fields.");
  next.fields = next.fields.map((field) => (field.key === next.keyField ? { ...field, required: true } : field));
  if (body.status === "active" || body.status === "archived" || body.status === "proposed") next.status = body.status;
  await upsertDataset(env.DB, next);
  return json({ dataset: next });
}

export async function DELETE(_request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
  if (!(await getDataset(env.DB, datasetId))) return fail("Dataset not found.", 404);
  await deleteDataset(env.DB, datasetId);
  return json({ deleted: true });
}
