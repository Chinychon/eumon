import { createId, severityFromImpact, type BacklinksInput, type Finding, type ReferringDomain } from "@organic-growth/core";

/*
 * What the referring-domains profile adds to an analysis: links to pages that
 * are gone, links lost in the last 30 days, and a wave of new spam links.
 * Counts exclude spam sites, so spam never inflates the first two.
 */

/** Thresholds, with their reasons. */
export const LINK_FINDINGS = {
  /** One or two broken or lost links happen on their own; three is a pattern worth a look. */
  BROKEN_AT_LEAST: 3,
  LOST_AT_LEAST: 3,
  /** Spam links appear in trickles that Google ignores; a wave this size is worth knowing about. */
  SPAM_WAVE_AT_LEAST: 20,
  SPAM_IMPACT: 15,
  SHOWN: 5,
};

const path = (url: string) => { try { return new URL(url).pathname; } catch { return url; } };
const strongest = (rows: ReferringDomain[]) => [...rows].sort((a, b) => b.rank - a.rank).slice(0, LINK_FINDINGS.SHOWN);

export function findingsFromReferring(input: { siteId: string; analysisId: string; referring: BacklinksInput | null | undefined }): Finding[] {
  const r = input.referring;
  if (!r) return [];
  const { brokenReal, lostReal, newSpam } = r.counts;
  const drafts: Array<{ impact: number; title: string; summary: string; recommendation: string; pagesAffected: string[] }> = [];
  if (brokenReal >= LINK_FINDINGS.BROKEN_AT_LEAST) {
    drafts.push({
      impact: Math.min(70, 30 + 4 * brokenReal),
      title: `${brokenReal} sites link to pages on your site that are missing`,
      summary: `Strongest: ${strongest(r.brokenReal).map((row) => `${row.domain} → ${path(row.urlTo)}`).join("; ")}.`,
      recommendation: "Redirect each missing address to its closest live page, or restore the page; these links count again once the address answers. The Search Console import suggests redirects for missing addresses.",
      pagesAffected: [...new Set(r.brokenReal.map((row) => row.urlTo))],
    });
  }
  if (lostReal >= LINK_FINDINGS.LOST_AT_LEAST) {
    drafts.push({
      impact: Math.min(60, 25 + 3 * lostReal),
      title: `You lost links from ${lostReal} sites in 30 days`,
      summary: `Strongest: ${strongest(r.lostReal).map((row) => `${row.domain} (last seen ${row.lastSeen})`).join("; ")}.`,
      recommendation: "Check whether each linking page changed or your page moved; ask the strongest sites to restore the link, and redirect any moved page.",
      pagesAffected: [],
    });
  }
  if (newSpam >= LINK_FINDINGS.SPAM_WAVE_AT_LEAST) {
    drafts.push({
      impact: LINK_FINDINGS.SPAM_IMPACT,
      title: `${newSpam} spam sites started linking to you in 30 days`,
      summary: r.networks.length ? `Networks: ${r.networks.map((n) => `${n.label} (${n.domains} sites)`).join("; ")}.` : "No single network stands out.",
      recommendation: "Most sites need do nothing: Google ignores links like these. Don't buy links, and check Search Console's Manual actions page; disavow only if it reports one. Eumon leaves these sites out of your link counts.",
      pagesAffected: [],
    });
  }
  const createdAt = new Date().toISOString();
  return drafts.map((d) => ({
    id: createId("finding"), siteId: input.siteId, analysisId: input.analysisId, category: "search", severity: severityFromImpact(d.impact),
    title: d.title, summary: d.summary, evidence: { asOf: r.asOf, ...r.counts }, organicImpactScore: d.impact,
    recommendation: d.recommendation, pagesAffected: d.pagesAffected, createdAt,
  }));
}
