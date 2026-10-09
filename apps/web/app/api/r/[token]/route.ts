import { env } from "cloudflare:workers";
import { fail, json } from "../../../../src/server";
import { resultsPayload } from "../../../../src/results-data";
import { siteForShareToken } from "../../../../src/share";

/** The client's read-only Results: no site health, nothing to edit. */
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const site = await siteForShareToken(env.DB, token, env.SESSION_SECRET);
  if (!site) return fail("This link has expired or was revoked.", 404);
  return json(await resultsPayload(env.DB, site, { client: true, signals: { speed: Boolean(env.GOOGLE_API_KEY), authority: Boolean(env.OPEN_PAGERANK_KEY) } }));
}
