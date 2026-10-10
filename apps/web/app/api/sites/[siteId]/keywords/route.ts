import { env } from "cloudflare:workers";
import { listTrackedKeywords, setTrackedKeywords } from "@organic-growth/db";
import { requireSite } from "../../../../../src/guard";
import { featureRefusal, FREE_LIMITS } from "../../../../../src/limits";
import { parseTrackedKeywords } from "../../../../../src/tracked-keywords";

export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "read");
  if (access instanceof Response) return access;
  return Response.json({ keywords: await listTrackedKeywords(env.DB, siteId) }, { headers: { "Cache-Control": "no-store" } });
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
  try { body = await request.json(); } catch { return Response.json({ error: "Send a list of keywords." }, { status: 400 }); }
  const parsed = parseTrackedKeywords(body);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  await setTrackedKeywords(env.DB, siteId, parsed.keywords);
  return Response.json({ keywords: parsed.keywords });
}
