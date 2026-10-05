import { env } from "cloudflare:workers";
import type { GeneratedPage } from "@organic-growth/core";
import { clearPageOverrides, getPage, getSite, getTemplate, updatePageFields } from "@organic-growth/db";
import { regenerateTemplate } from "../../../../src/page-engine";
import { fail, json, readJson } from "../../../../src/server";

/** Edits one page; each change is recorded so its effect on search and conversions can be measured. */
export async function PATCH(request: Request, context: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await context.params;
  const page = await getPage(env.DB, pageId);
  if (!page) return fail("Page not found.", 404);
  const body = await readJson<{ title?: unknown; description?: unknown; status?: unknown; reason?: unknown; resetOverrides?: unknown }>(request);
  if (!body) return fail("Send the changes as JSON.");
  if (body.resetOverrides === true) {
    // Return the page to its template copy by regenerating from current data.
    await clearPageOverrides(env.DB, page);
    const [site, template] = await Promise.all([getSite(env.DB, page.siteId), getTemplate(env.DB, page.templateId)]);
    if (site && template) await regenerateTemplate(site, template);
    const fresh = await getPage(env.DB, page.id);
    return json({ page: fresh && { id: fresh.id, path: fresh.path, title: fresh.title, description: fresh.description, status: fresh.status } });
  }
  const update: Partial<Pick<GeneratedPage, "title" | "description" | "status">> = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || body.title.trim().length < 10 || body.title.length > 90) return fail("Titles should be 10–90 characters.");
    update.title = body.title.trim();
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string" || body.description.trim().length < 30 || body.description.length > 200) return fail("Descriptions should be 30–200 characters.");
    update.description = body.description.trim();
  }
  if (body.status !== undefined) {
    if (body.status !== "published" && body.status !== "unpublished") return fail("Pages can be published or unpublished.");
    if (body.status === "published" && (page.status === "thin" || page.status === "duplicate")) {
      return fail("This page did not pass the quality check. Add data to its record, then regenerate.", 409);
    }
    update.status = body.status;
  }
  if (!Object.keys(update).length) return fail("Nothing to change.");
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : "Edited in the dashboard";
  const next = await updatePageFields(env.DB, page, update, { reason, author: "owner" });
  return json({ page: { id: next.id, path: next.path, title: next.title, description: next.description, status: next.status } });
}
