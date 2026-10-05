import { env } from "cloudflare:workers";
import type { GeneratedPageStatus } from "@organic-growth/core";
import { getTemplate, listPages } from "@organic-growth/db";
import { fail, json } from "../../../../../src/server";

const STATUSES: GeneratedPageStatus[] = ["draft", "published", "thin", "duplicate", "unpublished", "retired"];

export async function GET(request: Request, context: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await context.params;
  const template = await getTemplate(env.DB, templateId);
  if (!template) return fail("Template not found.", 404);
  const params = new URL(request.url).searchParams;
  const status = STATUSES.find((entry) => entry === params.get("status"));
  const { pages, total } = await listPages(env.DB, {
    siteId: template.siteId, templateId, status,
    limit: Math.min(Number(params.get("limit")) || 25, 100),
    offset: Math.max(Number(params.get("offset")) || 0, 0),
  });
  return json({
    total,
    pages: pages.map((page) => ({
      id: page.id, path: page.path, title: page.title, description: page.description, status: page.status,
      qualityScore: page.qualityScore, qualityIssues: page.qualityIssues, items: page.items.length, updatedAt: page.updatedAt,
    })),
  });
}
