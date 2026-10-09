import { env, waitUntil } from "cloudflare:workers";
import type { ConversionEventName, GeneratedPage, PageSettings, SiteRecord } from "@organic-growth/core";
import {
  filterPublishedPaths,
  getPage,
  getPageByPath,
  incrementPageMetric,
  insertConversionEvent,
  listCtaVariants,
  listPublishedPaths,
  listTemplates,
  recordAiSignal,
  recordLandingSession,
  recordLeadClick,
  getDataset,
  getTemplate,
} from "@organic-growth/db";
import { chooseArm, escapeHtml, htmlLang, labelsFor, renderHubPage, renderLandingPage, renderSitemap, type RenderCta } from "@organic-growth/pages";
import { classifyUserAgent, createId, isRef, isWhatsAppChatUrl, landingSource } from "@organic-growth/core";
import { indexNowKey } from "@organic-growth/agents";
import { readJson, settingsFor } from "./server";

const BEACON = "/__eumon/e";
const HEALTH = "/__eumon/health";

/**
 * Pages are indexable only when served through the customer's proxy (on their
 * domain). Direct hits on Eumon's own host get `X-Robots-Tag: noindex` so the
 * Eumon copy can never compete with the customer's URL.
 */
function isProxied(request: Request, settings: PageSettings): boolean {
  if (request.headers.get("x-eumon-proxy") === "1") return true;
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
  return Boolean(forwarded && forwarded === new URL(settings.publicOrigin).host.toLowerCase());
}

/** Counts a crawler's request for a published page: Googlebot on the page's daily row, AI agents by name. Other bots aren't counted. */
function countCrawl(siteId: string, pageId: string, userAgent: string): Promise<void> | null {
  const visitor = classifyUserAgent(userAgent);
  if (!visitor) return null;
  if (visitor.kind === "ai") return recordAiSignal(env.DB, { siteId, pageId, signal: "fetch", name: visitor.agent.agent });
  return visitor.kind === "googlebot" ? incrementPageMetric(env.DB, { siteId, pageId, kind: "googlebot_hits" }) : null;
}

function html(body: string, status: number, headers: Record<string, string>): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });
}

function notFound(settings: PageSettings, status = 404): Response {
  const origin = settings.publicOrigin.replace(/\/$/, "");
  const labels = labelsFor(settings.language);
  const message = status === 410 ? labels.retired : labels.notFound;
  return html(
    `<!doctype html><html lang="${escapeHtml(htmlLang(settings.language))}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(message)}</title></head><body style="font-family:system-ui;margin:15vh auto;max-width:520px;padding:0 20px"><h1>${escapeHtml(message)}</h1><p><a href="${escapeHtml(settings.mountPath || "/")}">${escapeHtml(labels.browseGuides)}</a> · <a href="${escapeHtml(origin)}/">${escapeHtml(labels.goTo(settings.siteName))}</a></p></body></html>`,
    status,
    { "Cache-Control": "public, max-age=60", "X-Robots-Tag": "noindex" },
  );
}

async function chooseCta(siteId: string, settings: PageSettings): Promise<RenderCta> {
  const variants = (await listCtaVariants(env.DB, siteId)).filter((variant) => variant.active);
  const chosen = chooseArm(variants);
  return chosen
    ? { variantId: chosen.id, label: chosen.label, copy: chosen.copy, url: chosen.url }
    : { label: settings.ctaLabel, copy: settings.ctaCopy, url: settings.ctaUrl };
}

/** Drops links to pages that are not live, so published pages never point at drafts or 404s. */
async function withLiveLinksOnly(page: GeneratedPage): Promise<GeneratedPage> {
  const internal = [
    ...page.related.map((link) => link.path),
    ...page.items.flatMap((item) => item.fields.map((field) => field.href).filter((href): href is string => Boolean(href?.startsWith("/")))),
  ];
  if (!internal.length) return page;
  const live = await filterPublishedPaths(env.DB, page.siteId, internal);
  return {
    ...page,
    related: page.related.filter((link) => live.has(link.path)),
    items: page.items.map((item) => ({
      ...item,
      fields: item.fields.map((field) => (field.href?.startsWith("/") && !live.has(field.href) ? { label: field.label, value: field.value } : field)),
    })),
  };
}

export async function servePublicGet(request: Request, site: SiteRecord, path: string): Promise<Response> {
  const settings = await settingsFor(site);
  const mount = settings.mountPath;
  const proxied = isProxied(request, settings);
  const robotsHeader: Record<string, string> = proxied ? {} : { "X-Robots-Tag": "noindex" };
  const preview = new URL(request.url).searchParams.get("preview") === "1";

  if (path === `${mount}${HEALTH}`) {
    return Response.json({ ok: true, siteId: site.id, proxied }, { headers: { "Cache-Control": "no-store" } });
  }
  if (mount && path !== mount && !path.startsWith(`${mount}/`)) return notFound(settings);

  // The IndexNow key file, inside the mount path so it vouches only for Eumon's pages.
  if (env.SESSION_SECRET && env.SESSION_SECRET.length >= 32 && /^\/[0-9a-f]{32}\.txt$/.test(path.slice(mount.length))) {
    const key = await indexNowKey(env.SESSION_SECRET, site.id);
    if (path === `${mount}/${key}.txt`) return new Response(key, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400", ...robotsHeader } });
  }

  if (path === `${mount}/sitemap.xml`) {
    const pages = await listPublishedPaths(env.DB, site.id);
    return new Response(renderSitemap(settings, pages), {
      headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=900", ...robotsHeader },
    });
  }
  if (!mount && path === "/robots.txt") {
    return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${settings.publicOrigin.replace(/\/$/, "")}/sitemap.xml\n`, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
    });
  }
  if (path === mount || path === `${mount}/` || (!mount && path === "/")) {
    const [pages, templates] = await Promise.all([listPublishedPaths(env.DB, site.id, 20_000), listTemplates(env.DB, site.id)]);
    const sections = templates.map((template) => ({
      name: template.name,
      pages: pages.filter((page) => page.templateId === template.id).slice(0, 1000),
    }));
    return html(renderHubPage({ settings, sections, indexable: proxied }), 200, {
      "Cache-Control": "public, max-age=300", ...robotsHeader,
    });
  }

  const page = await getPageByPath(env.DB, site.id, path.replace(/\/+$/, ""));
  if (!page) return notFound(settings);
  if (page.status === "unpublished" || page.status === "retired") return notFound(settings, 410);
  if (page.status !== "published" && !preview) return notFound(settings);

  const indexable = page.status === "published" && proxied && !preview;
  const [livePage, cta, template] = await Promise.all([withLiveLinksOnly(page), chooseCta(site.id, settings), getTemplate(env.DB, page.templateId)]);
  const dataset = template ? await getDataset(env.DB, template.datasetId) : null;
  const siteHost = new URL(site.baseUrl).hostname.replace(/^www\./, "");
  const pageHost = new URL(settings.publicOrigin).hostname;
  const body = renderLandingPage(livePage, {
    settings,
    cta,
    beaconPath: `${mount}${BEACON}`,
    indexable,
    entityType: dataset?.entityType,
    cookieDomain: pageHost !== siteHost && pageHost.endsWith(`.${siteHost}`) ? siteHost : undefined,
  });

  const crawl = page.status === "published" ? countCrawl(site.id, page.id, request.headers.get("user-agent") ?? "") : null;
  if (crawl) waitUntil(crawl.catch(() => undefined));
  const headers: Record<string, string> = {
    // Short shared caching keeps CTA tests moving while absorbing crawl bursts.
    "Cache-Control": indexable ? "public, max-age=300" : "no-store",
  };
  if (!indexable) headers["X-Robots-Tag"] = "noindex";
  return html(body, 200, headers);
}

function conversionEventFor(url: string): ConversionEventName {
  if (/^https?:\/\/(wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)\//i.test(url)) return "whatsapp_click";
  if (/^tel:/i.test(url)) return "phone_click";
  if (/^mailto:/i.test(url)) return "email_click";
  return "cta_click";
}

/**
 * Beacon from rendered pages: human page views and CTA clicks, plus
 * first-touch session attribution. A view carries the referrer's host (never
 * the full URL) and `utm_source`, which say whether an AI assistant or a
 * search engine sent the visitor.
 */
export async function servePublicBeacon(request: Request, site: SiteRecord): Promise<Response> {
  const body = await readJson<{ t?: unknown; p?: unknown; v?: unknown; s?: unknown; x?: unknown; r?: unknown; u?: unknown; w?: unknown }>(request, 2048);
  const noContent = new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  if (!body || typeof body.p !== "string" || (body.t !== "view" && body.t !== "cta")) return noContent;
  if (classifyUserAgent(request.headers.get("user-agent") ?? "")) return noContent;
  const page = await getPage(env.DB, body.p);
  if (!page || page.siteId !== site.id || page.status !== "published") return noContent;
  const variantId = typeof body.v === "string" ? body.v : undefined;
  const sessionId = typeof body.s === "string" && /^[a-zA-Z0-9_-]{16,64}$/.test(body.s) ? body.s : undefined;

  if (body.t === "view") {
    const source = landingSource(typeof body.r === "string" ? body.r.slice(0, 120) : "", typeof body.u === "string" ? body.u.slice(0, 80) : "");
    await incrementPageMetric(env.DB, { siteId: site.id, pageId: page.id, kind: "views", variantId });
    // One referral per visit: a reload keeps the referrer but isn't a new visitor. Without a session id every view counts.
    const landed = sessionId ? await recordLandingSession(env.DB, { siteId: site.id, sessionId, pageId: page.id, source }) : true;
    if (source.startsWith("ai:") && landed) await recordAiSignal(env.DB, { siteId: site.id, pageId: page.id, signal: "referral", name: source.slice(3) });
  } else {
    await incrementPageMetric(env.DB, { siteId: site.id, pageId: page.id, kind: "cta_clicks", variantId });
    const settings = await settingsFor(site);
    const variants = variantId ? await listCtaVariants(env.DB, site.id) : [];
    const ctaUrl = variants.find((variant) => variant.id === variantId)?.url ?? settings.ctaUrl;
    // A WhatsApp CTA's click carries the reference code the page wrote into the message.
    const ref = isRef(body.w) && isWhatsAppChatUrl(ctaUrl) ? body.w : undefined;
    const placement = typeof body.x === "string" ? body.x.slice(0, 40) : undefined;
    const pageUrl = `${settings.publicOrigin.replace(/\/$/, "")}${page.path}`;
    const occurredAt = new Date().toISOString();
    await insertConversionEvent(env.DB, {
      id: createId("event"),
      siteId: site.id,
      event: conversionEventFor(ctaUrl),
      destination: placement,
      pageUrl,
      sessionId,
      ...(ref ? { properties: { ref } } : {}),
      occurredAt,
    });
    if (ref) await recordLeadClick(env.DB, { id: createId("lead"), siteId: site.id, ref, sessionId, pageUrl, placement, at: occurredAt });
  }
  return noContent;
}

export const isBeaconPath = (path: string) => path.endsWith(BEACON);
