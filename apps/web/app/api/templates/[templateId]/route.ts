import { env } from "cloudflare:workers";
import type { FaqPattern, PageTemplate } from "@organic-growth/core";
import { deleteTemplate, getDataset, getTemplate, upsertTemplate } from "@organic-growth/db";
import { unknownPlaceholders } from "@organic-growth/pages";
import { fail, json, readJson } from "../../../../src/server";
import { requireOwned } from "../../../../src/guard";

const PATTERN_FIELDS = ["pathPattern", "titlePattern", "descriptionPattern", "h1Pattern", "introPattern"] as const;

export async function GET(request: Request, context: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await context.params;
  const access = await requireOwned(request, "template", templateId, "read");
  if (access instanceof Response) return access;
  const template = await getTemplate(env.DB, templateId);
  return template ? json({ template }) : fail("Template not found.", 404);
}

/** Edits copy patterns and display settings; every placeholder must exist in the dataset. */
export async function PATCH(request: Request, context: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await context.params;
  const access = await requireOwned(request, "template", templateId, "write");
  if (access instanceof Response) return access;
  const template = await getTemplate(env.DB, templateId);
  if (!template) return fail("Template not found.", 404);
  const dataset = await getDataset(env.DB, template.datasetId);
  if (!dataset) return fail("Dataset not found.", 404);
  const body = await readJson<Partial<Record<keyof PageTemplate, unknown>>>(request, 128 * 1024);
  if (!body) return fail("Send the changes as JSON.");
  const next: PageTemplate = { ...template, updatedAt: new Date().toISOString() };
  const keys = new Set(dataset.fields.map((field) => field.key));

  if (typeof body.name === "string" && body.name.trim()) next.name = body.name.trim().slice(0, 80);
  for (const field of PATTERN_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim() || value.length > 2000) return fail(`${field} cannot be empty.`);
    const unknown = unknownPlaceholders(value, dataset);
    if (unknown.length) return fail(`${field} uses unknown placeholders: ${unknown.map((token) => `{${token}}`).join(", ")}.`);
    next[field] = value.trim();
  }
  if (!next.pathPattern.startsWith("/") || !/\{[a-z0-9_:]+\}/i.test(next.pathPattern)) return fail("The URL pattern must start with / and include at least one placeholder.");
  if (Array.isArray(body.itemFields)) next.itemFields = body.itemFields.filter((key): key is string => typeof key === "string" && keys.has(key)).slice(0, 20);
  if (typeof body.sortBy === "string") next.sortBy = keys.has(body.sortBy) ? body.sortBy : undefined;
  if (body.sortDir === "asc" || body.sortDir === "desc") next.sortDir = body.sortDir;
  if (body.minRecords !== undefined) next.minRecords = Math.min(Math.max(Math.round(Number(body.minRecords) || 1), 1), 100);
  if (Array.isArray(body.faq)) {
    const faq: FaqPattern[] = [];
    for (const entry of body.faq.slice(0, 10)) {
      const item = entry as Record<string, unknown>;
      if (typeof item.question !== "string" || typeof item.answer !== "string" || !item.question.trim() || !item.answer.trim()) continue;
      const unknown = unknownPlaceholders(item.question + item.answer, dataset);
      if (unknown.length) return fail(`FAQ uses unknown placeholders: ${unknown.map((token) => `{${token}}`).join(", ")}.`);
      faq.push({ question: item.question.trim(), answer: item.answer.trim() });
    }
    next.faq = faq;
  }
  await upsertTemplate(env.DB, next);
  return json({ template: next });
}

export async function DELETE(request: Request, context: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await context.params;
  const access = await requireOwned(request, "template", templateId, "write");
  if (access instanceof Response) return access;
  if (!(await getTemplate(env.DB, templateId))) return fail("Template not found.", 404);
  await deleteTemplate(env.DB, templateId);
  return json({ deleted: true });
}
