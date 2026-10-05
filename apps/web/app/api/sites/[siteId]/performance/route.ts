import { env } from "cloudflare:workers";
import { getDailyTotals, getPagePerformance, listCtaVariants, listPageQueries, listPageRevisions, listTemplates } from "@organic-growth/db";
import { buildPerformanceReport } from "@organic-growth/pages";
import { fail, findSite, json, settingsFor } from "../../../../../src/server";

/** Which generated pages perform, what to do next, and whether past changes worked. */
export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await findSite(siteId);
  if (!site) return fail("Site not found.", 404);
  const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get("days")) || 28, 1), 365);
  const sinceDay = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const settings = await settingsFor(site);
  const origin = new URL(settings.publicOrigin).origin;
  const [pages, queries, templates, variants, daily, revisions] = await Promise.all([
    getPagePerformance(env.DB, { siteId, origin, sinceDay }),
    listPageQueries(env.DB, siteId),
    listTemplates(env.DB, siteId),
    listCtaVariants(env.DB, siteId),
    getDailyTotals(env.DB, siteId, sinceDay),
    listPageRevisions(env.DB, siteId, 30),
  ]);
  const report = buildPerformanceReport({
    pages, queries, publicOrigin: origin, variants,
    templates: templates.map((template) => ({ id: template.id, name: template.name })),
  });
  return json({ days, report, daily, revisions, variants, searchConnected: Boolean(site.gscProperty) });
}
