import { env } from "cloudflare:workers";
import { getTemplate } from "@organic-growth/db";
import { regenerateTemplate } from "../../../../../src/page-engine";
import { fail, json } from "../../../../../src/server";
import { requireOwned } from "../../../../../src/guard";

export async function POST(request: Request, context: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await context.params;
  const access = await requireOwned(request, "template", templateId, "write");
  if (access instanceof Response) return access;
  const template = await getTemplate(env.DB, templateId);
  if (!template) return fail("Template not found.", 404);
  // Not metered: regenerating fills pages from data and calls no model.
  try {
    return json({ generation: await regenerateTemplate(access.site, template) });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Generation failed.", 500);
  }
}
