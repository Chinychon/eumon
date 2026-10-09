/*
 * Site signals: Google's Core Web Vitals thresholds, and what URL Inspection
 * says Google did with a page.
 */

export type SpeedMetric = "lcp" | "inp" | "cls";
export type SpeedRating = "good" | "needs-work" | "poor";
export const SPEED_METRICS: SpeedMetric[] = ["lcp", "inp", "cls"];

/** Google's thresholds at the 75th percentile: good up to the first, needs work up to the second. */
const THRESHOLDS: Record<SpeedMetric, [number, number]> = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25] };

export function speedRating(metric: SpeedMetric, p75: number): SpeedRating {
  const [good, needsWork] = THRESHOLDS[metric];
  return p75 <= good ? "good" : p75 <= needsWork ? "needs-work" : "poor";
}

export type CoverageClass = "indexed" | "crawled" | "discovered" | "unknown" | "excluded";
export const COVERAGE_CLASSES: CoverageClass[] = ["indexed", "crawled", "discovered", "unknown", "excluded"];

/** Indexed, crawled but not indexed, discovered but not crawled, unknown to Google, or excluded for another reason. */
export function coverageClass(verdict: string, coverageState: string | null): CoverageClass {
  if (verdict === "PASS") return "indexed";
  const state = coverageState ?? "";
  if (state.startsWith("Crawled")) return "crawled";
  if (state.startsWith("Discovered")) return "discovered";
  if (state.includes("unknown to Google")) return "unknown";
  return "excluded";
}
