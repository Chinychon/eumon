import { env } from "cloudflare:workers";
import type { DataSource } from "@organic-growth/core";
import { deleteSource, getSource, upsertSource } from "@organic-growth/db";
import { validateUrlPattern } from "../../../../src/datasets";
import { fail, json, readJson } from "../../../../src/server";

export async function PATCH(request: Request, context: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await context.params;
  const source = await getSource(env.DB, sourceId);
  if (!source) return fail("Source not found.", 404);
  const body = await readJson<{ status?: unknown; urlPattern?: unknown; maxPages?: unknown }>(request);
  if (!body) return fail("Send the changes as JSON.");
  const next: DataSource = { ...source };
  if (body.status === "approved" || body.status === "rejected" || body.status === "proposed") next.status = body.status;
  if (body.urlPattern !== undefined) {
    const pattern = validateUrlPattern(body.urlPattern);
    if (typeof pattern === "object") return fail(pattern.error);
    next.urlPattern = pattern;
  }
  if (body.maxPages !== undefined && source.kind !== "page") {
    next.maxPages = Math.min(Math.max(Math.round(Number(body.maxPages) || 1), 1), 5000);
  }
  await upsertSource(env.DB, next);
  return json({ source: next });
}

export async function DELETE(_request: Request, context: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await context.params;
  if (!(await getSource(env.DB, sourceId))) return fail("Source not found.", 404);
  await deleteSource(env.DB, sourceId);
  return json({ deleted: true });
}
