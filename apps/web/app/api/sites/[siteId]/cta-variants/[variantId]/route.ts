import { env } from "cloudflare:workers";
import { listCtaVariants, setCtaVariantActive } from "@organic-growth/db";
import { requireSite } from "../../../../../../src/guard";
import { fail, json, readJson } from "../../../../../../src/server";

export async function PATCH(request: Request, context: { params: Promise<{ siteId: string; variantId: string }> }) {
  const { siteId, variantId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const body = await readJson<{ active?: unknown }>(request);
  if (typeof body?.active !== "boolean") return fail("Send { active: true | false }.");
  await setCtaVariantActive(env.DB, siteId, variantId, body.active);
  return json({ variants: await listCtaVariants(env.DB, siteId) });
}
