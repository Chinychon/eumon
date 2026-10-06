import { env } from "cloudflare:workers";
import { listSiteMarkets, setSiteMarkets } from "@organic-growth/db";
import { fail, findSite, json, readJson } from "../../../../../src/server";

/** Countries the business sells to, as Search Console reports them (ISO 3166-1 alpha-3). */
export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await findSite(siteId))) return fail("Site not found.", 404);
  return json({ countries: await listSiteMarkets(env.DB, siteId) });
}

export async function PUT(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await findSite(siteId))) return fail("Site not found.", 404);
  const body = await readJson<{ countries?: unknown }>(request);
  const countries = body?.countries;
  if (!Array.isArray(countries) || countries.length > 20 || !countries.every((code) => typeof code === "string" && /^[a-z]{3}$/i.test(code))) {
    return fail("Send up to 20 three-letter country codes, e.g. [\"idn\", \"mys\"].");
  }
  const normalized = [...new Set(countries.map((code) => (code as string).toLowerCase()))];
  await setSiteMarkets(env.DB, siteId, normalized);
  return json({ countries: normalized });
}
