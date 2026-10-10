import { env } from "cloudflare:workers";
import type { DataSource } from "@organic-growth/core";
import { deleteOAuthCredential, deleteSource, getSource, upsertSource } from "@organic-growth/db";
import { validateUrlPattern } from "../../../../src/datasets";
import { fail, json, readJson } from "../../../../src/server";
import { requireOwned } from "../../../../src/guard";

export async function PATCH(request: Request, context: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await context.params;
  const access = await requireOwned(request, "source", sourceId, "write");
  if (access instanceof Response) return access;
  const source = await getSource(env.DB, sourceId);
  if (!source) return fail("Source not found.", 404);
  const body = await readJson<{ status?: unknown; urlPattern?: unknown; maxPages?: unknown }>(request);
  if (!body) return fail("Send the changes as JSON.");
  const next: DataSource = { ...source };
  if (body.status === "approved" || body.status === "rejected" || body.status === "proposed") next.status = body.status;
  if (body.urlPattern !== undefined && source.kind === "supabase") {
    if (typeof body.urlPattern !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(body.urlPattern.trim())) return fail("Enter the table or view name (letters, digits and underscores).");
    next.urlPattern = body.urlPattern.trim();
  } else if (body.urlPattern !== undefined) {
    const pattern = validateUrlPattern(body.urlPattern);
    if (typeof pattern === "object") return fail(pattern.error);
    next.urlPattern = pattern;
  }
  if (body.maxPages !== undefined) {
    next.maxPages = Math.min(Math.max(Math.round(Number(body.maxPages) || 1), 1), source.kind === "page" ? 50 : 5000);
  }
  await upsertSource(env.DB, next);
  return json({ source: next });
}

export async function DELETE(request: Request, context: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await context.params;
  const access = await requireOwned(request, "source", sourceId, "write");
  if (access instanceof Response) return access;
  const source = await getSource(env.DB, sourceId);
  if (!source) return fail("Source not found.", 404);
  await deleteSource(env.DB, sourceId);
  if (source.kind === "supabase") await deleteOAuthCredential(env.DB, source.siteId, `supabase:${sourceId}`);
  return json({ deleted: true });
}
