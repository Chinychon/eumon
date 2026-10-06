import { env } from "cloudflare:workers";
import { deleteSite, getSite } from "@organic-growth/db";
import { fail, json } from "../../../../src/server";

export async function DELETE(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return fail("Site not found.", 404);
  await deleteSite(env.DB, siteId);
  return json({ deleted: true });
}
