/*
 * Search demand and difficulty for an opportunity, in one place. Until keyword
 * data is synced (DataForSEO, sub-project C), every figure is an estimate from
 * what the analysis saw; the rationales say so. Real volume and difficulty will
 * replace these bodies without the opportunity builders changing.
 */
export type DemandInput =
  /** A query ranking 4–15: harder the further from page one; demand is what Search Console saw. */
  | { kind: "ranking"; position: number; impressions: number }
  /** Rewriting a page-one snippet: cheap. */
  | { kind: "snippet"; impressions: number }
  /** A page type competitors publish and the site doesn't: their investment stands in for demand we can't see. */
  | { kind: "content_gap"; competitorPages: number }
  /** Records collected but not yet published as pages. */
  | { kind: "unpublished_data" }
  /** A technical fix, scaled by effort (1–4). */
  | { kind: "technical"; effort: number };

export function estimateDemand(input: DemandInput): { searchDemand: number; estimatedDifficulty: number } {
  const cap = (value: number) => Math.min(100, Math.round(value));
  switch (input.kind) {
    case "ranking": return { searchDemand: input.impressions, estimatedDifficulty: cap(input.position * 5) };
    case "snippet": return { searchDemand: input.impressions, estimatedDifficulty: 10 };
    case "content_gap": return { searchDemand: 0, estimatedDifficulty: cap(Math.log10(input.competitorPages + 1) * 25) };
    case "unpublished_data": return { searchDemand: 0, estimatedDifficulty: 20 };
    case "technical": return { searchDemand: 0, estimatedDifficulty: cap(input.effort * 15) };
  }
}
