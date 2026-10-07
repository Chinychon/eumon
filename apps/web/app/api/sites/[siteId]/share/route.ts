import { env } from "cloudflare:workers";
import { bumpReportShareVersion, getSite } from "@organic-growth/db";
import { fail, json } from "../../../../../src/server";
import { shareToken } from "../../../../../src/share";

export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  return json({ url: new URL(`/r/${await shareToken(site, env.SESSION_SECRET)}`, request.url).toString() });
}

/** Revokes every link issued so far. */
export async function DELETE(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return fail("Site not found.", 404);
  await bumpReportShareVersion(env.DB, siteId);
  return json({ revoked: true });
}
