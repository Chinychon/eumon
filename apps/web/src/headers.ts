/*
 * Response headers that limit what a browser does with Eumon's pages.
 * ponytail: no script-src. vinext writes inline RSC payload scripts and the landing-page
 * beacon is inline with per-page config; a script policy needs per-request nonces threaded
 * through both renderers. The renderer's escaping is the XSS defence until then.
 */
export const APP_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
};

/** Landing pages may be framed by the customer's own site, so no frame rules. */
export const PAGE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": "base-uri 'none'; object-src 'none'",
};

/** A copy of `response` with `headers` set; responses from fetch or Response.redirect are immutable. */
export function withHeaders(response: Response, headers: Record<string, string>): Response {
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value);
  return copy;
}
