import { env } from "cloudflare:workers";
import { getSite, listCtaVariants, setCtaVariantActive } from "@organic-growth/db";
import { fail, json, readJson } from "../../../../../../src/server";

export async function PATCH(request: Request, context: { params: Promise<{ siteId: string; variantId: string }> }) {
  const { siteId, variantId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return fail("Site not found.", 404);
  const body = await readJson<{ active?: unknown }>(request);
  if (typeof body?.active !== "boolean") return fail("Send { active: true | false }.");
  await setCtaVariantActive(env.DB, siteId, variantId, body.active);
  return json({ variants: await listCtaVariants(env.DB, siteId) });
}
