import { env } from "cloudflare:workers";
import { isLocalHost, seedDemoSite } from "@organic-growth/agents";
import { fail, json } from "../../../../src/server";

/** Builds (or rebuilds) the demo site with fictional data. Only for requests to this machine. */
export async function POST(request: Request) {
  if (!isLocalHost(new URL(request.url).hostname)) return fail("Not found.", 404);
  return json(await seedDemoSite(env.DB));
}
