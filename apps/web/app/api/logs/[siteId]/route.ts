import { env } from "cloudflare:workers";
import { getSite, getSiteLogToken } from "@organic-growth/db";
import { ingestLog, readLogBody, tokenMatches } from "../../../../src/crawl-logs";
import { fail, json } from "../../../../src/server";

type Context = { params: Promise<{ siteId: string }> };

/**
 * A batch of the site's access logs: Cloudflare Logpush (gzipped NDJSON),
 * a Vercel log drain (JSON or NDJSON), Eumon's log-forwarding Worker, or an
 * uploaded nginx/Apache log. Only crawler requests are kept. A delivery with
 * no request in it (Logpush's and Vercel's endpoint checks) is accepted.
 */
export async function POST(request: Request, context: Context) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  // One answer for an unknown site and a wrong token, so the address reveals nothing.
  if (!site || !env.SESSION_SECRET || !(await tokenMatches(request, env.SESSION_SECRET, siteId, await getSiteLogToken(env.DB, siteId)))) return fail("Unknown site or token.", 401);
  const body = await readLogBody(request);
  if (body === null) return fail("The delivery is too large: send at most 24 MB per request.", 413);
  return json(await ingestLog(env.DB, site, body));
}
