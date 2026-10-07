import { env } from "cloudflare:workers";
import { getSite, updateSiteGscProperty, clearMetricPoints, SEARCH_METRIC_PATTERNS } from "@organic-growth/db";
import { listSearchConsoleProperties } from "@organic-growth/agents";
import { googleAccessToken } from "../../../../../../src/gsc-auth";

export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return Response.json({ error: "Site not found." }, { status: 404 });
  try {
    const token = await googleAccessToken(env.DB, siteId, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.OAUTH_ENCRYPTION_KEY);
    const properties = await listSearchConsoleProperties(token);
    return Response.json({ properties, selected: site.gscProperty ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not load Search Console properties." }, { status: 400 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return Response.json({ error: "Site not found." }, { status: 404 });
  let property: unknown;
  try { property = (await request.json() as { property?: unknown }).property; } catch { return Response.json({ error: "Choose a Search Console property." }, { status: 400 }); }
  if (typeof property !== "string" || property.length > 2048) return Response.json({ error: "Choose a valid property." }, { status: 400 });
  try {
    const token = await googleAccessToken(env.DB, siteId, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.OAUTH_ENCRYPTION_KEY);
    const properties = await listSearchConsoleProperties(token);
    if (!properties.some((entry) => entry.siteUrl === property)) return Response.json({ error: "That property is not accessible to this Google account." }, { status: 403 });
    // Another property's history is not this site's "before Eumon": clear it so the next sync backfills.
    if (site.gscProperty && site.gscProperty !== property) await clearMetricPoints(env.DB, siteId, SEARCH_METRIC_PATTERNS);
    await updateSiteGscProperty(env.DB, siteId, property);
    return Response.json({ selected: property });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not save the property." }, { status: 400 });
  }
}
