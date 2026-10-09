import { env } from "cloudflare:workers";
import { getSite } from "@organic-growth/db";
import { isBeaconPath, servePublicBeacon, servePublicGet } from "../../../../src/public-pages";

type Context = { params: Promise<{ siteId: string; path?: string[] }> };

/**
 * Public, server-rendered landing pages. The customer's site proxies a path
 * (e.g. `example.com/guides/*`) to `/p/{siteId}/guides/*`, so search engines
 * receive complete HTML on the customer's own domain.
 */
async function resolve(context: Context): Promise<{ site: Awaited<ReturnType<typeof getSite>>; path: string }> {
  const { siteId, path } = await context.params;
  const segments = (path ?? []).map((segment) => {
    try {
      return encodeURIComponent(decodeURIComponent(segment));
    } catch {
      return encodeURIComponent(segment); // malformed escapes simply won't match a page
    }
  });
  return { site: await getSite(env.DB, siteId), path: `/${segments.join("/")}` };
}

export async function GET(request: Request, context: Context) {
  const { site, path } = await resolve(context);
  if (!site) return new Response("Not found", { status: 404 });
  return servePublicGet(request, site, path);
}

export async function HEAD(request: Request, context: Context) {
  const response = await GET(request, context);
  return new Response(null, { status: response.status, headers: response.headers });
}

export async function POST(request: Request, context: Context) {
  const { site, path } = await resolve(context);
  if (!site || !isBeaconPath(path)) return new Response(null, { status: 404 });
  return servePublicBeacon(request, site);
}
