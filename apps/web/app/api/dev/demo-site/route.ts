import { env } from "cloudflare:workers";
import { isLocalHost, seedDemoSite } from "@organic-growth/agents";
import { fail, json } from "../../../../src/server";

/**
 * Builds (or rebuilds) the demo site with fictional data. Offered by the
 * development server at any address, and by a built app only to requests
 * addressed to this machine, never to the deployed site.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production" && !isLocalHost(new URL(request.url).hostname)) return fail("Not found.", 404);
  return json(await seedDemoSite(env.DB));
}
