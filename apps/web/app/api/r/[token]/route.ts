import { env } from "cloudflare:workers";
import { fail, json } from "../../../../src/server";
import { loadResults } from "../../../../src/results-data";
import { siteForShareToken } from "../../../../src/share";

/** The client's read-only Results: no site health, nothing to edit. */
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const site = await siteForShareToken(env.DB, token, env.SESSION_SECRET);
  if (!site) return fail("This link has expired or was revoked.", 404);
  const results = await loadResults(env.DB, site);
  return json({
    site: { name: site.name, baseUrl: site.baseUrl, gscProperty: site.gscProperty ?? null, ga4Property: site.ga4Property ?? null },
    results: { ...results, health: { value: null, day: null } },
  });
}
