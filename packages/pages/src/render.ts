import type { GeneratedPage, PageLink, PageSettings } from "@organic-growth/core";
import { htmlLang, labelsFor } from "./labels.js";

export type RenderCta = { variantId?: string; label: string; copy: string; url: string };

export type RenderOptions = {
  settings: PageSettings;
  cta: RenderCta;
  /** Path the beacon posts to; relative so it stays same-origin behind the proxy. */
  beaconPath: string;
  /** Drafts and Eumon-hosted previews must never be indexed. */
  indexable: boolean;
  entityType?: string;
  /**
   * Parent domain for the session cookie when pages live on a subdomain
   * (`example.com` for `guides.example.com`), so conversions on the main
   * site can be attributed to the landing page.
   */
  cookieDomain?: string;
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!);
}

/** JSON for a `<script>` element: `</script>` and comment openers cannot escape. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function safeHref(href: string, origin: string): string | null {
  try {
    const url = new URL(href, origin);
    return /^(https?|mailto|tel):$/.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function publicUrl(settings: Pick<PageSettings, "publicOrigin">, path: string): string {
  return `${settings.publicOrigin.replace(/\/$/, "")}${path}`;
}

const SCHEMA_TYPES: Array<[RegExp, string]> = [
  [/doctor|physician|surgeon|specialist|dentist/i, "Physician"],
  [/hospital|clinic|medical cent/i, "MedicalOrganization"],
  [/procedure|treatment|surgery|therapy/i, "MedicalProcedure"],
  [/product|item|material/i, "Product"],
  [/service/i, "Service"],
  [/mall|store|shop|restaurant|hotel|venue|location|place/i, "Place"],
  [/course|class/i, "Course"],
  [/event/i, "Event"],
];

function schemaTypeFor(entityType: string | undefined): string {
  return SCHEMA_TYPES.find(([pattern]) => pattern.test(entityType ?? ""))?.[1] ?? "Thing";
}

function structuredData(page: GeneratedPage, options: RenderOptions, canonical: string): unknown[] {
  const { settings } = options;
  const hub = settings.mountPath ? publicUrl(settings, settings.mountPath) : settings.publicOrigin;
  const graph: unknown[] = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: settings.siteName, item: settings.publicOrigin },
        ...(settings.mountPath ? [{ "@type": "ListItem", position: 2, name: labelsFor(settings.language).guides, item: hub }] : []),
        { "@type": "ListItem", position: settings.mountPath ? 3 : 2, name: page.h1, item: canonical },
      ],
    },
  ];
  if (page.items.length === 1) {
    graph.push({
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: page.title,
      description: page.description,
      url: canonical,
      dateModified: page.updatedAt,
      about: { "@type": schemaTypeFor(options.entityType), name: page.items[0]!.title },
    });
  } else if (page.items.length > 1) {
    graph.push({
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: page.h1,
      numberOfItems: page.items.length,
      itemListElement: page.items.slice(0, 50).map((item, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: item.title,
      })),
    });
  }
  if (page.faq.length) {
    graph.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: page.faq.map((entry) => ({
        "@type": "Question",
        name: entry.question,
        acceptedAnswer: { "@type": "Answer", text: entry.answer },
      })),
    });
  }
  return graph;
}

function paragraphs(text: string): string {
  return text.split(/\n{2,}/).filter(Boolean).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");
}

function ctaButton(cta: RenderCta, origin: string, placement: string, className = "cta"): string {
  const href = safeHref(cta.url, origin) ?? origin;
  const external = !href.startsWith(origin);
  return `<a class="${className}" href="${escapeHtml(href)}" data-eumon-cta="${placement}"${external ? " rel=\"nofollow noopener\"" : ""}>${escapeHtml(cta.label)}</a>`;
}

function itemFieldsHtml(fields: GeneratedPage["items"][number]["fields"], origin: string): string {
  return fields.map((field) => {
    const href = field.href ? safeHref(field.href, origin) : null;
    const value = href ? `<a href="${escapeHtml(href)}">${escapeHtml(field.value)}</a>` : escapeHtml(field.value);
    return `<div class="field"><dt>${escapeHtml(field.label)}</dt><dd>${value}</dd></div>`;
  }).join("");
}

function relatedHtml(related: PageLink[], heading: string): string {
  if (!related.length) return "";
  return `<section class="related"><h2>${escapeHtml(heading)}</h2><ul>${related.map((link) => `<li><a href="${escapeHtml(link.path)}">${escapeHtml(link.title)}</a></li>`).join("")}</ul></section>`;
}

function trackingScript(beaconPath: string, pageId: string, variantId: string | undefined, cookieDomain: string | undefined): string {
  // Beacon is same-origin (served through the customer's proxy), first-party,
  // and fails silently so analytics can never break the page. A view sends the
  // referrer's host only (never the full URL) and utm_source, so the server
  // can tell visits from AI assistants and search engines.
  const domain = cookieDomain && /^[a-z0-9.-]+$/i.test(cookieDomain) ? `; domain=${cookieDomain}` : "";
  const config = scriptJson({ e: beaconPath, p: pageId, v: variantId ?? null, d: domain });
  return `<script>(function(c){try{var m=document.cookie.match(/(?:^|; )eumon_sid=([^;]+)/),s=m?m[1]:(crypto.randomUUID?crypto.randomUUID().replace(/-/g,""):String(Math.random()).slice(2)+Date.now());document.cookie="eumon_sid="+s+"; path=/; max-age=2592000; SameSite=Lax"+c.d;var R="",U=null;try{R=document.referrer?new URL(document.referrer).host:"";if(R===location.host)R="";U=new URLSearchParams(location.search).get("utm_source")}catch(_){}var send=function(t,x){var b=JSON.stringify(t==="view"?{t:t,p:c.p,v:c.v,s:s,r:R,u:U}:{t:t,p:c.p,v:c.v,s:s,x:x||null});if(navigator.sendBeacon){navigator.sendBeacon(c.e,new Blob([b],{type:"application/json"}))}else{fetch(c.e,{method:"POST",body:b,keepalive:true,headers:{"Content-Type":"application/json"}})}};send("view");document.addEventListener("click",function(ev){var a=ev.target&&ev.target.closest&&ev.target.closest("[data-eumon-cta]");if(a)send("cta",a.getAttribute("data-eumon-cta"))},true)}catch(_){}})(${config})</script>`;
}

function styles(brand: string): string {
  const color = /^#[0-9a-f]{3,8}$/i.test(brand) ? brand : "#176b50";
  return `:root{--brand:${color};--ink:#17211d;--muted:#5d6b65;--line:#e4ebe7;--soft:#f6f9f7}*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:#fff;line-height:1.6}a{color:var(--brand)}.wrap{max-width:960px;margin:0 auto;padding:0 20px}.top{border-bottom:1px solid var(--line);background:#fff}.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;height:60px}.brand{font-weight:700;color:var(--ink);text-decoration:none}.crumbs{font-size:13px;color:var(--muted);margin:18px 0 0}.crumbs a{color:var(--muted)}.hero{padding:28px 0 8px}.hero h1{font-size:clamp(28px,4.4vw,40px);line-height:1.15;margin:0 0 14px;letter-spacing:-.02em}.lead{font-size:18px;color:#33413b;max-width:720px}.lead p{margin:0 0 12px}.cta-box{display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin:22px 0 8px;padding:18px;border:1px solid var(--line);border-radius:14px;background:var(--soft)}.cta-box p{margin:0;flex:1 1 220px;color:#33413b}.cta{display:inline-block;padding:13px 22px;border-radius:999px;background:var(--brand);color:#fff;text-decoration:none;font-weight:650;white-space:nowrap}.cta:hover{filter:brightness(.92)}.cta.small{padding:8px 16px;font-size:14px}section{margin:34px 0}h2{font-size:22px;margin:0 0 14px}.details{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:0}.field{padding:14px;border:1px solid var(--line);border-radius:12px}.field dt{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}.field dd{margin:4px 0 0;font-weight:550}.items{display:grid;gap:14px}.item{padding:18px;border:1px solid var(--line);border-radius:14px}.item h3{margin:0 0 10px;font-size:18px}.item .details{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}.item .field{padding:0;border:0}.faq details{border-bottom:1px solid var(--line);padding:14px 0}.faq summary{cursor:pointer;font-weight:600}.faq p{margin:8px 0 0;color:#33413b}.related ul{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px}.related a{display:block;padding:12px 14px;border:1px solid var(--line);border-radius:10px;text-decoration:none;color:var(--ink)}.band{margin:40px 0;padding:28px;border-radius:18px;background:var(--brand);color:#fff;text-align:center}.band h2{color:#fff}.band p{opacity:.9}.band .cta{background:#fff;color:var(--brand)}footer{border-top:1px solid var(--line);padding:24px 0 90px;font-size:13px;color:var(--muted)}.sticky{position:fixed;left:0;right:0;bottom:0;padding:10px 16px;background:#fff;border-top:1px solid var(--line);display:none;box-shadow:0 -4px 16px rgba(0,0,0,.06)}.sticky .cta{display:block;text-align:center}@media(max-width:700px){.sticky{display:block}.top .cta{display:none}.lead{font-size:16px}}`;
}

/** Renders a complete, self-contained landing page. Content never depends on JavaScript. */
export function renderLandingPage(page: GeneratedPage, options: RenderOptions): string {
  const { settings, cta } = options;
  const origin = settings.publicOrigin.replace(/\/$/, "");
  const canonical = publicUrl(settings, page.path);
  const hubPath = settings.mountPath || "/";
  const isEntity = page.items.length === 1;
  const item = page.items[0];
  const labels = labelsFor(settings.language);
  const lang = htmlLang(settings.language);

  const body = isEntity && item
    ? `<section><h2>${escapeHtml(labels.details)}</h2><dl class="details">${itemFieldsHtml(item.fields, origin)}</dl></section>`
    : `<section><h2>${escapeHtml(labels.options(page.items.length))}</h2><div class="items">${page.items.map((entry) =>
      `<article class="item"><h3>${escapeHtml(entry.title)}</h3><dl class="details">${itemFieldsHtml(entry.fields, origin)}</dl></article>`).join("")}</div></section>`;

  const faq = page.faq.length
    ? `<section class="faq"><h2>${escapeHtml(labels.faq)}</h2>${page.faq.map((entry) =>
      `<details><summary>${escapeHtml(entry.question)}</summary>${paragraphs(entry.answer)}</details>`).join("")}</section>`
    : "";

  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)}</title>
<meta name="description" content="${escapeHtml(page.description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta name="robots" content="${options.indexable ? "index, follow, max-image-preview:large" : "noindex, nofollow"}">
<meta name="generator" content="Eumon">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(page.title)}">
<meta property="og:description" content="${escapeHtml(page.description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:site_name" content="${escapeHtml(settings.siteName)}">
<style>${styles(settings.brandColor)}</style>
<script type="application/ld+json">${scriptJson(structuredData(page, options, canonical))}</script>
</head>
<body>
<header class="top"><div class="wrap"><a class="brand" href="${escapeHtml(origin)}/">${escapeHtml(settings.siteName)}</a>${ctaButton(cta, origin, "header", "cta small")}</div></header>
<main class="wrap">
<nav class="crumbs" aria-label="Breadcrumb"><a href="${escapeHtml(origin)}/">${escapeHtml(labels.home)}</a>${settings.mountPath ? ` › <a href="${escapeHtml(hubPath)}">${escapeHtml(labels.guides)}</a>` : ""} › <span>${escapeHtml(page.h1)}</span></nav>
<div class="hero">
<h1>${escapeHtml(page.h1)}</h1>
<div class="lead">${paragraphs(page.intro)}</div>
<div class="cta-box"><p>${escapeHtml(cta.copy)}</p>${ctaButton(cta, origin, "hero")}</div>
</div>
${body}
${faq}
<div class="band"><h2>${escapeHtml(page.h1)}</h2><p>${escapeHtml(cta.copy)}</p>${ctaButton(cta, origin, "footer-band")}</div>
${relatedHtml(page.related, labels.related)}
</main>
<footer><div class="wrap">© ${new Date(page.updatedAt).getUTCFullYear()} ${escapeHtml(settings.siteName)} · ${escapeHtml(labels.lastUpdated)} ${escapeHtml(page.updatedAt.slice(0, 10))}</div></footer>
<div class="sticky">${ctaButton(cta, origin, "sticky")}</div>
${trackingScript(options.beaconPath, page.id, cta.variantId, options.cookieDomain)}
</body>
</html>`;
}

/** Index of every live page, so each one is reachable through internal links. */
export function renderHubPage(input: {
  settings: PageSettings;
  sections: Array<{ name: string; pages: Array<{ path: string; title: string }> }>;
  indexable: boolean;
}): string {
  const { settings } = input;
  const labels = labelsFor(settings.language);
  const lang = htmlLang(settings.language);
  const origin = settings.publicOrigin.replace(/\/$/, "");
  const canonical = publicUrl(settings, settings.mountPath || "/");
  // Link text reads better without the "| Site name" suffix every title carries.
  const suffix = new RegExp(`\\s*[|–-]\\s*${settings.siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const sections = input.sections.filter((section) => section.pages.length).map((section) =>
    `<section class="related"><h2>${escapeHtml(section.name)}</h2><ul>${section.pages.map((page) =>
      `<li><a href="${escapeHtml(page.path)}">${escapeHtml(page.title.replace(suffix, "") || page.title)}</a></li>`).join("")}</ul></section>`).join("");
  return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(`${labels.guides} | ${settings.siteName}`)}</title><link rel="canonical" href="${escapeHtml(canonical)}"><meta name="robots" content="${input.indexable ? "index, follow" : "noindex, nofollow"}"><style>${styles(settings.brandColor)}</style></head><body><header class="top"><div class="wrap"><a class="brand" href="${escapeHtml(origin)}/">${escapeHtml(settings.siteName)}</a></div></header><main class="wrap"><div class="hero"><h1>${escapeHtml(labels.hubTitle(settings.siteName))}</h1></div>${sections || `<p>${escapeHtml(labels.noGuides)}</p>`}</main></body></html>`;
}

export function renderSitemap(settings: PageSettings, pages: Array<{ path: string; updatedAt: string }>): string {
  const urls = [{ path: settings.mountPath || "/", updatedAt: pages[0]?.updatedAt }, ...pages]
    .map((page) => `<url><loc>${escapeHtml(publicUrl(settings, page.path))}</loc>${page.updatedAt ? `<lastmod>${escapeHtml(page.updatedAt.slice(0, 10))}</lastmod>` : ""}</url>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}
