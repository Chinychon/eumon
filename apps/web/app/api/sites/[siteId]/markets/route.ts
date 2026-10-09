import { env } from "cloudflare:workers";
import { RESULT_METRICS } from "@organic-growth/core";
import { getSite, listSiteMarkets, setSiteMarkets, clearMetricPoints } from "@organic-growth/db";
import { fail, json, readJson } from "../../../../../src/server";

/** Countries the business sells to, as Search Console reports them (ISO 3166-1 alpha-3). */
export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return fail("Site not found.", 404);
  return json({ countries: await listSiteMarkets(env.DB, siteId) });
}

export async function PUT(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return fail("Site not found.", 404);
  const body = await readJson<{ countries?: unknown }>(request);
  const countries = body?.countries;
  if (!Array.isArray(countries) || countries.length > 20 || !countries.every((code) => typeof code === "string" && /^[a-z]{3}$/i.test(code))) {
    return fail("Send up to 20 three-letter country codes, e.g. [\"idn\", \"mys\"].");
  }
  const normalized = [...new Set(countries.map((code) => (code as string).toLowerCase()))];
  // A different set of countries is a different series: clear it so the next sync backfills the new set.
  const before = await listSiteMarkets(env.DB, siteId);
  if ([...before].sort().join() !== [...normalized].sort().join()) await clearMetricPoints(env.DB, siteId, RESULT_METRICS.filter((metric) => metric.endsWith("@markets")));
  await setSiteMarkets(env.DB, siteId, normalized);
  return json({ countries: normalized });
}
