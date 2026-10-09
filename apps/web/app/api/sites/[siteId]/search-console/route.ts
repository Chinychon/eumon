import { env } from "cloudflare:workers";
import { getSite } from "@organic-growth/db";
import { searchConsoleView } from "../../../../../src/search-console-import";
import { fail, json } from "../../../../../src/server";

/** Imported Search Console URL lists reconciled with today, the overview totals, redirect suggestions, and Google's indexed counts over time. */
export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return fail("Site not found.", 404);
  return json(await searchConsoleView(env.DB, siteId));
}
