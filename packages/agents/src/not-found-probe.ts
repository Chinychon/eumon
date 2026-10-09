import { createId, severityFromImpact, type Finding } from "@organic-growth/core";

/** What the site answered for a URL that cannot exist (`probeNotFound` in the crawler); `finalUrl` is where it was sent. */
export type NotFoundProbe = { url: string; finalUrl?: string; status: number; title?: string };

const sentHome = (probe: NotFoundProbe) => Boolean(probe.finalUrl) && new URL(probe.finalUrl!).pathname.replace(/\/+$/, "") === "";

/** The title that marks a page as a soft 404 for the coverage rule: the probe's, unless the probe was sent to the homepage (whose title is the site's). */
export function probeTitleForCoverage(probe: NotFoundProbe | null | undefined): string | null {
  if (!probe || probe.status >= 400 || !probe.title || sentHome(probe)) return null;
  return probe.title;
}

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
    summary: `A URL that cannot exist (${new URL(probe.url).pathname}) ${sentHome(probe) ? `redirects to the homepage and answers ${probe.status}` : `answered ${probe.status}${probe.title ? ` with the title “${probe.title}”` : ""}`}. Google treats such pages as soft 404s: it crawls them, indexes nothing, and returns, and every old link or typo becomes a page it has to check.`,
    evidence: { url: probe.url, finalUrl: probe.finalUrl ?? null, status: probe.status, title: probe.title ?? null },
    organicImpactScore: impact,
    recommendation: "Return a real 404 (or 410 for pages taken down) with the not-found page's content, so Google drops dead URLs instead of re-crawling them.",
    createdAt: new Date().toISOString(),
  };
}
