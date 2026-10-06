import { env } from "cloudflare:workers";
import { createId } from "@organic-growth/core";
import { getSite, insertCtaVariant, listCtaVariants } from "@organic-growth/db";
import { fail, json, readJson, settingsFor } from "../../../../../src/server";

export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return fail("Site not found.", 404);
  return json({ variants: await listCtaVariants(env.DB, siteId) });
}

/**
 * Adds a CTA variant. The first variant also enrols the current default CTA
 * as the control, so the test always compares against what is live today.
 */
export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  const body = await readJson<{ label?: unknown; copy?: unknown; url?: unknown }>(request);
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const copy = typeof body?.copy === "string" ? body.copy.trim() : "";
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!label || label.length > 60) return fail("Give the button a label of up to 60 characters.");
  if (copy.length > 200) return fail("Keep the supporting copy under 200 characters.");
  if (url && !/^(https?:\/\/|mailto:|tel:)/i.test(url)) return fail("The link must be an https, mailto:, or tel: URL.");
  const existing = await listCtaVariants(env.DB, siteId);
  const settings = await settingsFor(site);
  const now = new Date().toISOString();
  if (!existing.length) {
    await insertCtaVariant(env.DB, {
      id: createId("cta"), siteId, label: settings.ctaLabel, copy: settings.ctaCopy, url: settings.ctaUrl,
      impressions: 0, clicks: 0, active: true, createdAt: now,
    });
  }
  await insertCtaVariant(env.DB, {
    id: createId("cta"), siteId, label, copy: copy || settings.ctaCopy, url: url || settings.ctaUrl,
    impressions: 0, clicks: 0, active: true, createdAt: now,
  });
  return json({ variants: await listCtaVariants(env.DB, siteId) }, 201);
}
