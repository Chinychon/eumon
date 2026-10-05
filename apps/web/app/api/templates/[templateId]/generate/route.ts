import { env } from "cloudflare:workers";
import { getSite, getTemplate } from "@organic-growth/db";
import { regenerateTemplate } from "../../../../../src/page-engine";
import { fail, json } from "../../../../../src/server";

export async function POST(_request: Request, context: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await context.params;
  const template = await getTemplate(env.DB, templateId);
  if (!template) return fail("Template not found.", 404);
  const site = await getSite(env.DB, template.siteId);
  if (!site) return fail("Site not found.", 404);
  try {
    return json({ generation: await regenerateTemplate(site, template) });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Generation failed.", 500);
  }
}
