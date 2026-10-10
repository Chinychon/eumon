import { env } from "cloudflare:workers";
import { searchConsoleView } from "../../../../../src/search-console-import";
import { requireSite } from "../../../../../src/guard";
import { fail, json } from "../../../../../src/server";

/** Imported Search Console URL lists reconciled with today, the overview totals, redirect suggestions, and Google's indexed counts over time. */
export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "read");
  if (access instanceof Response) return access;
  return json(await searchConsoleView(env.DB, siteId));
}
