import { env } from "cloudflare:workers";
import { getSite } from "@organic-growth/db";
import { signalKeys } from "../../../../../src/results-access";
import { resultsPayload } from "../../../../../src/results-data";
import { fail, json } from "../../../../../src/server";

export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  try {
    const { siteId } = await context.params;
    const site = await getSite(env.DB, siteId);
    if (!site) return fail("Site not found.", 404);
    return json(await resultsPayload(env.DB, site, { keys: signalKeys(env) }));
  } catch (error) {
    console.error("Results API error:", error);
    return fail(error instanceof Error ? error.message : "Internal error", 500);
  }
}
