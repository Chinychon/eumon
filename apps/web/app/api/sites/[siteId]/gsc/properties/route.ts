import { env } from "cloudflare:workers";
import { startSync } from "../../../../../../src/sync-steps";
import { METRICS } from "@organic-growth/core";
import { clearMetricPoints, listRecordKeys, listSiteMarkets, replaceCurrentSearchMetrics, setLatestReportSearch, updateSiteGscProperty } from "@organic-growth/db";
import { analyzeSearch, fetchSearchConsoleMetrics, listSearchConsoleProperties, siteBrandTerms } from "@organic-growth/agents";
import { googleAccessToken } from "../../../../../../src/gsc-auth";
import { requireSite } from "../../../../../../src/guard";

/** Starts this site's sync after a connection changes, so the dashboard fills in now instead of at the daily run; null while the daily run is already going (it brings the same data) or when it can't start. */
const syncNow = (siteId: string) => startSync(env, { siteId, trigger: "manual" })
  .then((result) => (result.running ? null : { id: result.id, startedAt: result.startedAt }))
  .catch(() => null);

export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const { site } = access;
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
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const { site } = access;
  let property: unknown;
  try { property = (await request.json() as { property?: unknown }).property; } catch { return Response.json({ error: "Choose a Search Console property." }, { status: 400 }); }
  if (typeof property !== "string" || property.length > 2048) return Response.json({ error: "Choose a valid property." }, { status: 400 });
  try {
    const token = await googleAccessToken(env.DB, siteId, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.OAUTH_ENCRYPTION_KEY);
    const properties = await listSearchConsoleProperties(token);
    if (!properties.some((entry) => entry.siteUrl === property)) return Response.json({ error: "That property is not accessible to this Google account." }, { status: 403 });
    // Another property's history is not this site's "before Eumon": clear it so the next sync backfills.
    if (site.gscProperty && site.gscProperty !== property) await clearMetricPoints(env.DB, siteId, METRICS.search);
    await updateSiteGscProperty(env.DB, siteId, property);
    // Fill the last report's Search section now instead of on the next analysis.
    const [rows, targetMarkets, entityKeys] = await Promise.all([
      fetchSearchConsoleMetrics(token, property), listSiteMarkets(env.DB, siteId), listRecordKeys(env.DB, siteId),
    ]);
    await replaceCurrentSearchMetrics(env.DB, siteId, rows);
    if (rows.length) await setLatestReportSearch(env.DB, siteId, analyzeSearch(rows, { brandTerms: siteBrandTerms(site), targetMarkets, entityKeys }));
    return Response.json({ selected: property, searchRows: rows.length, sync: await syncNow(siteId) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not save the property." }, { status: 400 });
  }
}
