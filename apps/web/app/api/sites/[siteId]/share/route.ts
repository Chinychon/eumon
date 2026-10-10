import { env } from "cloudflare:workers";
import { bumpReportShareVersion } from "@organic-growth/db";
import { requireSite } from "../../../../../src/guard";
import { fail, json } from "../../../../../src/server";
import { shareToken } from "../../../../../src/share";

export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const { site } = access;
  return json({ url: new URL(`/r/${await shareToken(site, env.SESSION_SECRET)}`, request.url).toString() });
}

/** Revokes every link issued so far. */
export async function DELETE(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  await bumpReportShareVersion(env.DB, siteId);
  return json({ revoked: true });
}
