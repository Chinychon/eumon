/*
 * Search demand and difficulty for an opportunity, in one place. A query that
 * DataForSEO has priced (the site's keyword lists) gets its real volume and
 * difficulty; anything else is estimated from what the analysis saw, and the
 * rationales say so.
 */
import type { KeywordDemand } from "@organic-growth/core";

export type DemandInput =
  /** A query ranking 4–15: harder the further from page one; demand is what Search Console saw. */
  | { kind: "ranking"; query: string; position: number; impressions: number }
  /** Filling a page's missing topics: demand is what Search Console saw, or the priced volume. */
  | { kind: "content_coverage"; query: string; impressions: number }
  /** Rewriting a page-one snippet: cheap. */
  | { kind: "snippet"; query: string; impressions: number }
  /** A page type competitors publish and the site doesn't: their investment stands in for demand we can't see. */
  | { kind: "content_gap"; competitorPages: number }
  /** Records collected but not yet published as pages. */
  | { kind: "unpublished_data" }
  /** A technical fix, scaled by effort (1–4). */
  | { kind: "technical"; effort: number }
  /** An AI answer that cites competitors: no search volume exists for it; harder the more engines skip the site. */
  | { kind: "ai_answer"; engines: number };

export type DemandEstimate = {
  searchDemand: number;
  estimatedDifficulty: number;
  /** A sentence for the rationale when the figures are DataForSEO's; null when estimated. */
  priced: string | null;
};

export function estimateDemand(input: DemandInput, demand?: KeywordDemand): DemandEstimate {
  const cap = (value: number) => Math.min(100, Math.round(value));
  if ((input.kind === "ranking" || input.kind === "snippet" || input.kind === "content_coverage") && demand) {
    const price = demand.lookup(input.query);
    if (price && price.volume !== null && price.difficulty !== null) {
      return { searchDemand: price.volume, estimatedDifficulty: price.difficulty, priced: `${price.volume.toLocaleString("en")} searches a month, difficulty ${price.difficulty} of 100 (DataForSEO).` };
    }
  }
  switch (input.kind) {
    case "ranking": return { searchDemand: input.impressions, estimatedDifficulty: cap(input.position * 5), priced: null };
    case "content_coverage": return { searchDemand: input.impressions, estimatedDifficulty: 30, priced: null };
    case "snippet": return { searchDemand: input.impressions, estimatedDifficulty: 10, priced: null };
    case "content_gap": return { searchDemand: 0, estimatedDifficulty: cap(Math.log10(input.competitorPages + 1) * 25), priced: null };
    case "unpublished_data": return { searchDemand: 0, estimatedDifficulty: 20, priced: null };
    case "technical": return { searchDemand: 0, estimatedDifficulty: cap(input.effort * 15), priced: null };
    case "ai_answer": return { searchDemand: 0, estimatedDifficulty: cap(input.engines * 20), priced: null };
  }
}
