import { env } from "cloudflare:workers";
import { getTopQueriesSnapshot, listAiBrandNames, listAiPrompts, listSiteMarkets, setAiBrandNames, setAiPrompts } from "@organic-growth/db";
import { requireSite } from "../../../../../src/guard";
import { featureRefusal, FREE_LIMITS } from "../../../../../src/limits";
import { parseAiPrompts, promptSuggestions } from "../../../../../src/ai-prompts";

export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "read");
  if (access instanceof Response) return access;
  const { site } = access;
  const [prompts, brandNames, markets] = await Promise.all([listAiPrompts(env.DB, siteId), listAiBrandNames(env.DB, siteId), listSiteMarkets(env.DB, siteId)]);
  const snapshot = site.gscProperty ? await getTopQueriesSnapshot(env.DB, siteId, { property: site.gscProperty, markets }) : null;
  const suggestions = promptSuggestions(snapshot?.rows ?? [], prompts);
  return Response.json({ prompts, brandNames, suggestions }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  // A site without a workspace follows FREE_LIMITS, which doesn't include DataForSEO.
  const { workspaceId } = access.site;
  const refusal = workspaceId ? await featureRefusal(env.DB, workspaceId, "dataForSeo") : FREE_LIMITS.dataForSeo ? null : "This workspace's plan doesn't include keyword data yet.";
  if (refusal) return Response.json({ error: refusal }, { status: 403 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Send a list of questions and a list of brand names." }, { status: 400 }); }
  const parsed = parseAiPrompts(body);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  await setAiPrompts(env.DB, siteId, parsed.prompts);
  await setAiBrandNames(env.DB, siteId, parsed.brandNames);
  return Response.json({ prompts: parsed.prompts, brandNames: parsed.brandNames, suggestions: [] });
}
