import { env } from "cloudflare:workers";
import { signalKeys } from "../../../../../src/results-access";
import { resultsPayload } from "../../../../../src/results-data";
import { requireSite } from "../../../../../src/guard";
import { fail, json } from "../../../../../src/server";

export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  try {
    const { siteId } = await context.params;
    const access = await requireSite(request, siteId, "read");
    if (access instanceof Response) return access;
    const { site } = access;
    return json(await resultsPayload(env.DB, site, { keys: signalKeys(env) }));
  } catch (error) {
    console.error("Results API error:", error);
    return fail(error instanceof Error ? error.message : "Internal error", 500);
  }
}
