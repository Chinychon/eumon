import { env } from "cloudflare:workers";
import { GOOGLEBOT_UA, defaultFetcher, headerNoindex, isEmptyShell, parseHtmlSignals } from "@organic-growth/crawler";
import { getSite, listPublishedPaths, upsertPageSettings } from "@organic-growth/db";
import { fail, json, settingsFor } from "../../../../../src/server";

type Snippet = { id: string; label: string; when: string; language: string; code: string };

function snippets(target: string, mount: string, publicHost: string): Snippet[] {
  const prefix = mount || "";
  const route = mount ? `${publicHost}${mount}*` : `${publicHost}/*`;
  return [
    {
      id: "cloudflare",
      label: "Cloudflare Worker",
      when: "Your domain's DNS is on Cloudflare (works for any CMS: WordPress, Drupal, Webflow, Wix, custom).",
      language: "js",
      code: `// Create a Worker, paste this, then add the route: ${route}
const TARGET = "${target}";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("X-Eumon-Proxy", "1");
    headers.set("X-Forwarded-Host", url.host);
    return fetch(TARGET + url.pathname + url.search, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
    });
  },
};`,
    },
    {
      id: "vercel",
      label: "Vercel (vercel.json)",
      when: "The site is deployed on Vercel (Next.js, Astro, Nuxt, Vite).",
      language: "json",
      code: JSON.stringify({
        rewrites: mount
          ? [
            { source: mount, destination: `${target}${mount}` },
            { source: `${mount}/:path*`, destination: `${target}${mount}/:path*` },
          ]
          : [{ source: "/:path*", destination: `${target}/:path*` }],
      }, null, 2),
    },
    {
      id: "nextjs",
      label: "Next.js (next.config)",
      when: "A self-hosted Next.js app.",
      language: "js",
      code: `// next.config.js
module.exports = {
  async rewrites() {
    return {
      beforeFiles: [
        { source: "${prefix || "/"}", destination: "${target}${prefix}" },
        { source: "${prefix}/:path*", destination: "${target}${prefix}/:path*" },
      ],
    };
  },
};`,
    },
    {
      id: "netlify",
      label: "Netlify (netlify.toml)",
      when: "The site is deployed on Netlify.",
      language: "toml",
      code: `[[redirects]]
  from = "${prefix}/*"
  to = "${target}${prefix}/:splat"
  status = 200
  force = true
  headers = { X-Eumon-Proxy = "1" }`,
    },
    {
      id: "nginx",
      label: "nginx",
      when: "You manage the web server (common for WordPress and Drupal hosting).",
      language: "nginx",
      code: `location ${prefix || "/"} {
    proxy_pass ${target}${prefix};
    proxy_set_header Host ${new URL(target).host};
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Eumon-Proxy 1;
    proxy_ssl_server_name on;
}`,
    },
    {
      id: "apache",
      label: "Apache (.htaccess / vhost)",
      when: "Apache with mod_proxy and mod_headers enabled.",
      language: "apache",
      code: `SSLProxyEngine on
RequestHeader set X-Eumon-Proxy "1"
ProxyPass "${prefix || "/"}" "${target}${prefix}"
ProxyPassReverse "${prefix || "/"}" "${target}${prefix}"`,
    },
  ];
}

/**
 * Dependency-free conversion tracking for the main site (any CMS). It reuses
 * the landing-page session cookie, so conversions are credited to the page a
 * visitor first landed on, and it auto-tracks WhatsApp, phone, email, and form
 * submissions. It never sends form contents.
 */
function trackingSnippet(endpoint: string, siteId: string): string {
  return `<script>
(function () {
  var endpoint = ${JSON.stringify(endpoint)};
  function sessionId() {
    var match = document.cookie.match(/(?:^|; )eumon_sid=([a-zA-Z0-9_-]{16,64})/);
    if (match) return match[1];
    try {
      var key = "og-session-${siteId}", value = sessionStorage.getItem(key);
      if (!value) { value = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : String(Date.now()) + Math.random().toString(36).slice(2)); sessionStorage.setItem(key, value); }
      return value;
    } catch (e) { return undefined; }
  }
  window.eumonTrack = function (event, destination) {
    try {
      fetch(endpoint, { method: "POST", mode: "cors", keepalive: true, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: event, destination: destination, pageUrl: location.href, sessionId: sessionId() }) }).catch(function () {});
    } catch (e) {}
  };
  document.addEventListener("click", function (e) {
    var link = e.target && e.target.closest && e.target.closest("a[href]");
    if (!link) return;
    var href = link.getAttribute("href") || "";
    if (/wa\\.me|whatsapp\\.com/i.test(href)) window.eumonTrack("whatsapp_click", "whatsapp");
    else if (/^tel:/i.test(href)) window.eumonTrack("phone_click", "phone");
    else if (/^mailto:/i.test(href)) window.eumonTrack("email_click", "email");
  }, true);
  document.addEventListener("submit", function () { window.eumonTrack("form_submit", "form"); }, true);
})();
</script>`;
}

/** Infers hosting and CMS from the live homepage's response headers, so the right proxy snippet is suggested. */
async function detectHosting(baseUrl: string): Promise<{ provider: string | null; cms: string | null; server: string | null }> {
  try {
    const response = await defaultFetcher(baseUrl, { maxBytes: 300_000 });
    const header = (name: string) => response.headers[name] ?? "";
    const server = header("server").toLowerCase();
    const provider = header("cf-ray") || server === "cloudflare" ? "cloudflare"
      : header("x-vercel-id") || server.includes("vercel") ? "vercel"
        : header("x-nf-request-id") || server.includes("netlify") ? "netlify"
          : server.includes("nginx") ? "nginx"
            : server.includes("apache") ? "apache"
              : null;
    const generator = header("x-generator") || response.body.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i)?.[1] || "";
    const cms = /drupal/i.test(generator) ? generator.split("(")[0]!.trim()
      : /wordpress/i.test(generator) || /wp-content\//.test(response.body) ? "WordPress"
        : /webflow/i.test(generator) ? "Webflow"
          : /wix/i.test(generator) ? "Wix"
            : generator ? generator.split("(")[0]!.trim() : null;
    return { provider, cms, server: header("server") || null };
  } catch {
    return { provider: null, cms: null, server: null };
  }
}

export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  const settings = await settingsFor(site);
  const target = `${new URL(request.url).origin}/p/${site.id}`;
  const publicHost = new URL(settings.publicOrigin).host;
  const hosting = await detectHosting(site.baseUrl);
  return json({
    hosting,
    settings,
    target,
    hubUrl: `${settings.publicOrigin}${settings.mountPath || "/"}`,
    sitemapUrl: `${settings.publicOrigin}${settings.mountPath}/sitemap.xml`,
    snippets: snippets(target, settings.mountPath, publicHost),
    framework: site.fingerprint?.framework ?? null,
    deployment: site.fingerprint?.deployment ?? null,
    trackingSnippet: trackingSnippet(`${new URL(request.url).origin}/api/sites/${site.id}/events`, site.id),
  });
}

/**
 * Verifies the live setup from the outside, the way Google sees it: the proxy
 * reaches Eumon, a published page returns complete HTML as Googlebot on the
 * customer's domain, it is indexable, and its canonical points to itself.
 */
export async function POST(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  const settings = await settingsFor(site);
  const origin = settings.publicOrigin.replace(/\/$/, "");
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  try {
    const health = await defaultFetcher(`${origin}${settings.mountPath}/__eumon/health`, { userAgent: GOOGLEBOT_UA });
    const payload = (() => { try { return JSON.parse(health.body) as { siteId?: string; proxied?: boolean }; } catch { return null; } })();
    const reached = health.status === 200 && payload?.siteId === site.id;
    checks.push({
      name: "Proxy reaches Eumon",
      ok: reached,
      detail: reached
        ? `${origin}${settings.mountPath || "/"} is forwarded to Eumon.`
        : `Requests to ${origin}${settings.mountPath}/… are not reaching Eumon yet (HTTP ${health.status}). Add one of the proxy snippets.`,
    });
    if (reached) {
      checks.push({
        name: "Proxy identifies itself",
        ok: payload?.proxied === true,
        detail: payload?.proxied
          ? "The proxy sends X-Eumon-Proxy or X-Forwarded-Host, so pages are indexable."
          : "The proxy does not send X-Eumon-Proxy: 1 or X-Forwarded-Host, so pages are served with noindex. Update the proxy to set the header.",
      });
    }
  } catch (error) {
    checks.push({ name: "Proxy reaches Eumon", ok: false, detail: error instanceof Error ? error.message : "The request failed." });
  }

  const [sample] = await listPublishedPaths(env.DB, site.id, 1);
  if (!sample) {
    checks.push({ name: "A published page renders for Googlebot", ok: false, detail: "Publish at least one template to test a live page." });
  } else {
    const url = `${origin}${sample.path}`;
    try {
      const response = await defaultFetcher(url, { userAgent: GOOGLEBOT_UA });
      const signals = parseHtmlSignals(response.body, response.finalUrl);
      const fromEumon = /<meta name="generator" content="Eumon">/.test(response.body);
      const noindex = signals.metaNoindex || headerNoindex(response.headers["x-robots-tag"]);
      checks.push({
        name: "A published page renders for Googlebot",
        ok: response.status === 200 && fromEumon && !isEmptyShell(response.body, signals),
        detail: response.status === 200 && fromEumon
          ? `${url} returned complete HTML (${signals.textLength.toLocaleString()} characters of text) with no JavaScript required.`
          : `${url} returned HTTP ${response.status}${fromEumon ? "" : " without Eumon's page"}.`,
      });
      // Indexing and canonical checks only mean something once the page is Eumon's.
      if (!fromEumon) return json(await recordVerification(settings, checks));
      checks.push({
        name: "Indexable",
        ok: !noindex,
        detail: noindex
          ? "The page is marked noindex — the proxy is probably not sending X-Eumon-Proxy: 1."
          : "No noindex directives.",
      });
      checks.push({
        name: "Canonical points to the live URL",
        ok: signals.canonical === url,
        detail: signals.canonical === url ? url : `Canonical is ${signals.canonical ?? "missing"}; expected ${url}. Check the public origin in settings.`,
      });
    } catch (error) {
      checks.push({ name: "A published page renders for Googlebot", ok: false, detail: error instanceof Error ? error.message : "The request failed." });
    }
  }
  return json(await recordVerification(settings, checks));
}

/** Remembers whether the setup is verified, so pages can be shown as live rather than merely approved. */
async function recordVerification(settings: Awaited<ReturnType<typeof settingsFor>>, checks: Array<{ ok: boolean }>) {
  const ok = checks.length > 0 && checks.every((check) => check.ok);
  const verifiedAt = ok ? new Date().toISOString() : undefined;
  if (verifiedAt !== settings.verifiedAt) await upsertPageSettings(env.DB, { ...settings, verifiedAt });
  return { checks, ok, verifiedAt: verifiedAt ?? null };
}
