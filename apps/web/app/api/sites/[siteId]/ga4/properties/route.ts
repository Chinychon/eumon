import { env } from "cloudflare:workers";
import { listGa4Properties } from "@organic-growth/agents";
import { clearMetricPoints, GA4_METRIC_PATTERNS, getSite, updateSiteGa4Property } from "@organic-growth/db";
import { ANALYTICS_SCOPE, googleAccessToken, googleScopes } from "../../../../../../src/gsc-auth";
import { fail, json, readJson } from "../../../../../../src/server";

/** GA4 properties the site's Google connection can read; `needsReconnect` when it was granted before Analytics was requested. */
export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  const scopes = await googleScopes(env.DB, siteId);
  if (!scopes.length) return json({ properties: [], selected: site.ga4Property ?? null, needsReconnect: false, connected: false });
  if (!scopes.includes(ANALYTICS_SCOPE)) return json({ properties: [], selected: site.ga4Property ?? null, needsReconnect: true, connected: true });
  const token = await googleAccessToken(env.DB, siteId, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.OAUTH_ENCRYPTION_KEY);
  return json({ properties: await listGa4Properties(token), selected: site.ga4Property ?? null, needsReconnect: false, connected: true });
}

export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  const property = (await readJson<{ property?: unknown }>(request))?.property;
  if (property !== null && (typeof property !== "string" || !/^properties\/\d+$/.test(property))) return fail("Choose a GA4 property.");
  // A different property's sessions are not this site's baseline: clear them so the next sync backfills.
  if (site.ga4Property && site.ga4Property !== property) await clearMetricPoints(env.DB, siteId, GA4_METRIC_PATTERNS);
  await updateSiteGa4Property(env.DB, siteId, property);
  return json({ property });
}
