import type { Pillar } from "./types.js";

/** Share of indexable crawled pages with no error-class issue in the pillar, 0–100 with one decimal; null without pages; 0 when a site-wide error of the pillar stands. */
export function healthScore(input: { indexable: number; unhealthy: number; siteErrors: number }): number | null {
  if (input.indexable <= 0) return null;
  if (input.siteErrors > 0) return 0;
  return Math.round(((input.indexable - Math.min(input.unhealthy, input.indexable)) / input.indexable) * 1000) / 10;
}

/** The page-level error checks each pillar's unhealthy count is built from. The SQL in packages/db (SEO_ERRORS, AI_ERRORS) mirrors this list. */
export const PAGE_ERROR_CHECKS: Record<Pillar, string[]> = {
  seo: ["http.error", "render.empty_shell", "access.bot_challenge", "content.soft_404", "security.mixed_content", "http.redirect_chain", "http.meta_refresh", "title.weak"],
  ai: ["http.error", "render.empty_shell", "access.bot_challenge", "ai.snippet_blocked"],
};

/** Error-class page checks that do not feed the score, and why. */
export const UNSCORED_PAGE_ERRORS: Record<string, string> = {
  // ponytail: a page with a broken outbound link is not itself broken; counting it needs a link join inside the coverage query.
  "links.broken_internal": "Counted per linking page outside the coverage query; the broken target already counts as an HTTP error.",
  "sitemap.blocked": "Blocked URLs are not fetched, so they are never indexable pages.",
};
