import { env } from "cloudflare:workers";
import { deleteSite } from "@organic-growth/db";
import { requireSite } from "../../../../src/guard";
import { fail, json } from "../../../../src/server";

export async function DELETE(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "admin");
  if (access instanceof Response) return access;
  await deleteSite(env.DB, siteId);
  return json({ deleted: true });
}
