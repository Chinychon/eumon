import { env } from "cloudflare:workers";
import { startSync } from "../../../../../../src/sync-steps";
import { listGa4Properties } from "@organic-growth/agents";
import { METRICS } from "@organic-growth/core";
import { clearMetricPoints, updateSiteGa4Property } from "@organic-growth/db";
import { ANALYTICS_SCOPE, googleAccessToken, googleScopes } from "../../../../../../src/gsc-auth";
import { requireSite } from "../../../../../../src/guard";
import { fail, json, readJson } from "../../../../../../src/server";

/** GA4 properties the site's Google connection can read; `needsReconnect` when it was granted before Analytics was requested. */
/** Starts this site's sync after a connection changes, so the dashboard fills in now instead of at the daily run; null while the daily run is already going (it brings the same data) or when it can't start. */
const syncNow = (siteId: string) => startSync(env, { siteId, trigger: "manual" })
  .then((result) => (result.running ? null : { id: result.id, startedAt: result.startedAt }))
  .catch(() => null);

export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const { site } = access;
  const scopes = await googleScopes(env.DB, siteId);
  if (!scopes.length) return json({ properties: [], selected: site.ga4Property ?? null, needsReconnect: false, connected: false });
  if (!scopes.includes(ANALYTICS_SCOPE)) return json({ properties: [], selected: site.ga4Property ?? null, needsReconnect: true, connected: true });
  try {
    const token = await googleAccessToken(env.DB, siteId, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.OAUTH_ENCRYPTION_KEY);
    return json({ properties: await listGa4Properties(token), selected: site.ga4Property ?? null, needsReconnect: false, connected: true });
  } catch (cause) {
    // Connected, but Google refused (often an API not enabled in the Cloud project): say why rather than offering to connect again.
    return json({ properties: [], selected: site.ga4Property ?? null, needsReconnect: false, connected: true, error: cause instanceof Error ? cause.message : String(cause) });
  }
}

export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const { site } = access;
  const property = (await readJson<{ property?: unknown }>(request))?.property;
  if (property !== null && (typeof property !== "string" || !/^properties\/\d+$/.test(property))) return fail("Choose a GA4 property.");
  // A different property's sessions are not this site's baseline: clear them so the next sync backfills.
  if (site.ga4Property && site.ga4Property !== property) await clearMetricPoints(env.DB, siteId, METRICS.ga4);
  await updateSiteGa4Property(env.DB, siteId, property);
  return json({ property, sync: property ? await syncNow(siteId) : null });
}
