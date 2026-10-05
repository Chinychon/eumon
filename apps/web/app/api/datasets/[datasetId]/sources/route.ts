import { env } from "cloudflare:workers";
import { createId, type DataSourceKind } from "@organic-growth/core";
import { getDataset, getSite, upsertSource } from "@organic-growth/db";
import { SOURCE_KINDS, validateUrlPattern } from "../../../../../src/datasets";
import { fail, isPublicHttpUrl, json, readJson } from "../../../../../src/server";

export async function POST(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
  const dataset = await getDataset(env.DB, datasetId);
  if (!dataset) return fail("Dataset not found.", 404);
  const site = await getSite(env.DB, dataset.siteId);
  if (!site) return fail("Site not found.", 404);
  const body = await readJson<{ url?: unknown; kind?: unknown; urlPattern?: unknown; maxPages?: unknown }>(request);
  const kind = SOURCE_KINDS.includes(body?.kind as DataSourceKind) ? body!.kind as DataSourceKind : "listing";
  const url = kind === "own_site" ? new URL(site.baseUrl).origin : body?.url;
  if (!isPublicHttpUrl(url)) return fail("Enter a public http(s) URL for the source.");
  const urlPattern = validateUrlPattern(body?.urlPattern);
  if (typeof urlPattern === "object") return fail(urlPattern.error);
  if (kind !== "page" && !urlPattern && kind !== "listing") return fail("Sitemap sources need a URL pattern, e.g. /malls/*, so only detail pages are collected.");
  // For a single list page, maxPages is how many pages of its pager to read.
  const maxPages = kind === "page"
    ? Math.min(Math.max(Math.round(Number(body?.maxPages) || 50), 1), 50)
    : Math.min(Math.max(Math.round(Number(body?.maxPages) || 300), 1), 5000);
  const source = {
    id: createId("src"), siteId: dataset.siteId, datasetId, url, kind, urlPattern, maxPages,
    origin: kind === "own_site" ? "own_site" as const : "user" as const,
    status: "approved" as const, recordCount: 0, createdAt: new Date().toISOString(),
  };
  await upsertSource(env.DB, source);
  return json({ source }, 201);
}
