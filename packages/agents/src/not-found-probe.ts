import { createId, severityFromImpact, type Finding } from "@organic-growth/core";

/** What the site answered for a URL that cannot exist (`probeNotFound` in the crawler). */
export type NotFoundProbe = { url: string; status: number; title?: string };

/**
 * A site that answers under 400 for a page that doesn't exist tells Google
 * every dead URL is a page: Google crawls them, indexes nothing, and keeps
 * coming back (its "Soft 404"). Null for a proper 404 or 410.
 */
export function notFoundProbeFinding(probe: NotFoundProbe, siteId: string, analysisId: string): Finding | null {
  if (probe.status >= 400) return null;
  const impact = 62;
  return {
    id: createId("finding"), siteId, analysisId, category: "indexing", severity: severityFromImpact(impact),
    title: "The site answers 200 for pages that don't exist",
    summary: `A URL that cannot exist (${new URL(probe.url).pathname}) answered ${probe.status}${probe.title ? ` with the title “${probe.title}”` : ""}. Google treats such pages as soft 404s: it crawls them, indexes nothing, and returns, and every old link or typo becomes a page it has to check.`,
    evidence: { url: probe.url, status: probe.status, title: probe.title ?? null },
    organicImpactScore: impact,
    recommendation: "Return a real 404 (or 410 for pages taken down) with the not-found page's content, so Google drops dead URLs instead of re-crawling them.",
    createdAt: new Date().toISOString(),
  };
}
