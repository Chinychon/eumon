import type { FindingCategory, Severity } from "./types.js";

/**
 * Severity must reflect expected organic business impact, not arbitrary lint rules.
 */
export function severityFromImpact(score: number): Severity {
  if (score >= 90) return "CRITICAL";
  if (score >= 70) return "HIGH";
  if (score >= 40) return "MEDIUM";
  if (score >= 15) return "LOW";
  return "INFORMATIONAL";
}

export function organicImpactScore(input: {
  category: FindingCategory;
  pagesAffected: number;
  isBlockingCrawl?: boolean;
  isEmptyShellAtScale?: boolean;
  trafficShareAffected?: number;
  commercialIntent?: boolean;
}): number {
  let score = 10;

  if (input.isEmptyShellAtScale) score += 55;
  if (input.isBlockingCrawl) score += 40;
  if (input.commercialIntent) score += 20;
  if ((input.trafficShareAffected ?? 0) > 0.5) score += 25;
  else if ((input.trafficShareAffected ?? 0) > 0.2) score += 15;

  score += Math.min(input.pagesAffected / 100, 20);

  if (input.category === "rendering" || input.category === "indexing") {
    score += 10;
  }
  if (input.category === "metadata" && input.pagesAffected < 5) {
    score = Math.min(score, 25);
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}
