/*
 * The first check on every request, before any route runs: public paths pass,
 * everything else needs a signed-in session, and signed-in writes must come from
 * Eumon's own pages. A route someone forgets to guard is still not public.
 */

const PUBLIC: RegExp[] = [
  /^\/p\//, // landing pages, their sitemap, and the analytics beacon
  /^\/api\/sites\/[^/]+\/events$/, // conversion events from customer sites
  /^\/r\//, /^\/api\/r\//, // client Results links (signed, revocable tokens)
  /^\/api\/logs\//, // log ingest (per-site token)
  /^\/api\/auth\//, // Better Auth's own endpoints
  /^\/sign-in(\/|$|\.)/, /^\/invite\//,
  /^\/(manifest\.json|sw\.js|sw-register\.js|favicon\.ico|robots\.txt)$/, /^\/icon-[\w-]+\.png$/, /^\/assets\//,
];

export const isPublicPath = (path: string) => PUBLIC.some((pattern) => pattern.test(path));

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function gate(request: Request, signedIn: boolean): Response | null {
  const url = new URL(request.url);
  if (isPublicPath(url.pathname)) return null;
  if (!signedIn) {
    if (url.pathname.startsWith("/api/")) return Response.json({ error: "Sign in to continue." }, { status: 401, headers: { "Cache-Control": "no-store" } });
    return Response.redirect(`${url.origin}/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`, 303);
  }
  // The session cookie rides along on cross-site requests; only Eumon's own pages may write.
  if (url.pathname.startsWith("/api/") && !SAFE_METHODS.has(request.method) && request.headers.get("origin") !== url.origin) {
    return Response.json({ error: "This request didn't come from Eumon, so it was refused." }, { status: 403 });
  }
  return null;
}
