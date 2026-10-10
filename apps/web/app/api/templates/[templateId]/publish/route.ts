import { env } from "cloudflare:workers";
import { getTemplate, setTemplatePublication, upsertTemplate } from "@organic-growth/db";
import { fail, json, readJson } from "../../../../../src/server";
import { requireOwned } from "../../../../../src/guard";

/** Publishes every quality-passing page of the template (thin and duplicate pages never go live). */
export async function POST(request: Request, context: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await context.params;
  const access = await requireOwned(request, "template", templateId, "write");
  if (access instanceof Response) return access;
  const template = await getTemplate(env.DB, templateId);
  if (!template) return fail("Template not found.", 404);
  const body = await readJson<{ publish?: unknown }>(request);
  const publish = body?.publish !== false;
  const changed = await setTemplatePublication(env.DB, templateId, publish);
  await upsertTemplate(env.DB, { ...template, status: publish ? "active" : "draft", updatedAt: new Date().toISOString() });
  return json({ changed, status: publish ? "active" : "draft" });
}
