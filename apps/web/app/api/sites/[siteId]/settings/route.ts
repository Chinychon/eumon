import { env } from "cloudflare:workers";
import type { PageSettings } from "@organic-growth/core";
import { getSite, upsertPageSettings } from "@organic-growth/db";
import { normalizeMountPath } from "@organic-growth/pages";
import { fail, isPublicHttpUrl, json, readJson, settingsFor } from "../../../../../src/server";

export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  return json({ settings: await settingsFor(site) });
}

export async function PUT(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  const body = await readJson<Partial<PageSettings>>(request);
  if (!body) return fail("Send the page settings as JSON.");
  const current = await settingsFor(site);
  const next: PageSettings = { ...current, updatedAt: new Date().toISOString() };

  if (body.publicOrigin !== undefined) {
    if (!isPublicHttpUrl(body.publicOrigin)) return fail("The public origin must be a public https URL, e.g. https://example.com or https://guides.example.com.");
    const origin = new URL(body.publicOrigin).origin;
    const siteHost = new URL(site.baseUrl).hostname.replace(/^www\./, "");
    const host = new URL(origin).hostname;
    // Pages must live on the customer's own domain so their authority accrues there.
    if (host !== siteHost && !host.endsWith(`.${siteHost}`) && `www.${siteHost}` !== host) {
      return fail(`Pages must be served from ${siteHost} or one of its subdomains.`);
    }
    next.publicOrigin = origin;
  }
  if (body.mountPath !== undefined) {
    if (typeof body.mountPath !== "string" || body.mountPath.length > 60) return fail("Enter a short path such as /guides.");
    next.mountPath = normalizeMountPath(body.mountPath);
  }
  if (!next.mountPath && next.publicOrigin === new URL(site.baseUrl).origin) {
    return fail("Pages on the main domain need a subdirectory such as /guides; use a subdomain to serve them from the root.");
  }
  for (const key of ["siteName", "ctaLabel", "ctaCopy"] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "string" || !body[key]!.trim() || body[key]!.length > 200) return fail(`Enter a value for ${key}.`);
      next[key] = body[key]!.trim();
    }
  }
  if (body.ctaUrl !== undefined) {
    const value = typeof body.ctaUrl === "string" ? body.ctaUrl.trim() : "";
    if (!/^(https?:\/\/|mailto:|tel:)/i.test(value) || value.length > 500) return fail("The CTA link must be an https, mailto:, or tel: URL (WhatsApp links use https://wa.me/…).");
    next.ctaUrl = value;
  }
  if (body.language !== undefined) {
    if (typeof body.language !== "string" || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(body.language)) return fail("Use a language code such as en, id, or ms.");
    next.language = body.language;
  }
  if (body.brandColor !== undefined) {
    if (typeof body.brandColor !== "string" || !/^#[0-9a-f]{6}$/i.test(body.brandColor)) return fail("Use a hex colour such as #176b50.");
    next.brandColor = body.brandColor;
  }
  if (body.currency !== undefined) {
    if (typeof body.currency !== "string" || !/^[A-Za-z]{3}$/.test(body.currency)) return fail("Use a three-letter currency code such as MYR, IDR or SGD.");
    next.currency = body.currency.toUpperCase();
  }
  // A new domain or path must be verified again before pages count as live.
  if (next.publicOrigin !== current.publicOrigin || next.mountPath !== current.mountPath) next.verifiedAt = undefined;
  await upsertPageSettings(env.DB, next);
  return json({ settings: next });
}
