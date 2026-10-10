import { addDays, CHECKS, countryName, createId, finding, type Finding, type KeywordDemand, type Opportunity } from "@organic-growth/core";
import { expectedCtr } from "@organic-growth/pages";
import { estimateDemand } from "./demand.js";
import type { ContentGradeRow } from "./content-targets.js";

/* What content grades add to an analysis: one finding when several pages trail the top results, and an opportunity per weak page. */

const COVERAGE_UNDER = 0.5;
const MIN_TOPICS = 3;
const MAX_OPPORTUNITIES = 5;
/** A grade older than this no longer speaks for the page (the card still shows it, with its date). */
const FRESH_DAYS = 35;

const coverage = (row: ContentGradeRow) => row.covered / row.topics.length;
const fresh = (grades: ContentGradeRow[] | undefined, today = new Date().toISOString().slice(0, 10)) =>
  (grades ?? []).filter((row) => row.checkedAt.slice(0, 10) >= addDays(today, -FRESH_DAYS));

export function findingsFromContentGrades(input: { siteId: string; analysisId: string; grades: ContentGradeRow[] | undefined; today?: string }): Finding[] {
  const weak = fresh(input.grades, input.today).filter((row) => row.topics.length >= MIN_TOPICS && coverage(row) < COVERAGE_UNDER);
  if (weak.length < 2) return [];
  const worst = [...weak].sort((a, b) => coverage(a) - coverage(b)).slice(0, 3);
  return [finding(CHECKS["content.coverage_gap"]!, {
    siteId: input.siteId, analysisId: input.analysisId,
    impact: Math.min(65, 25 + 5 * weak.length),
    title: `${weak.length} pages cover less than half of what the top results cover`,
    summary: `For ${weak.length} searches graded against the top 3 results, the page covers under half of the topics they share. Furthest behind: ${worst.map((row) => `“${row.query}” (${row.page}) is missing ${row.missing.slice(0, 3).join(", ")}`).join("; ")}.`,
    evidence: { pages: weak.map((row) => ({ query: row.query, market: row.market, page: row.page, covered: row.covered, topics: row.topics.length })) },
    pagesAffected: weak.map((row) => row.page),
  })];
}

/**
 * One opportunity per page graded C or below (five at most, weakest first). When an existing
 * “Move …” opportunity already quotes the query, its rationale gains the missing topics instead.
 */
export function contentOpportunities(input: { siteId: string; analysisId: string; grades: ContentGradeRow[] | undefined; existing: Opportunity[]; demand?: KeywordDemand; today?: string }): { made: Opportunity[]; existing: Opportunity[] } {
  const weak = fresh(input.grades, input.today).filter((row) => row.grade >= "C").sort((a, b) => a.score - b.score).slice(0, MAX_OPPORTUNITIES);
  const existing = [...input.existing];
  const made: Opportunity[] = [];
  for (const row of weak) {
    const quoted = row.query.toLowerCase();
    const at = existing.findIndex((opp) => /^Move /.test(opp.title) && /“(.+?)”/.exec(opp.title)?.[1]?.toLowerCase() === quoted);
    if (at >= 0) {
      existing[at] = { ...existing[at]!, rationale: `${existing[at]!.rationale} The top results also cover: ${row.missing.slice(0, 5).join(", ")}.` };
      continue;
    }
    const estimate = estimateDemand({ kind: "content_coverage", query: row.query, impressions: row.impressions ?? 0 }, input.demand);
    const reach = row.impressions !== null ? row.impressions * expectedCtr(3) / 2 : estimate.searchDemand * expectedCtr(3) / 2;
    made.push({
      id: createId("opp"), siteId: input.siteId, analysisId: input.analysisId,
      title: `Cover what the top results cover for “${row.query}”: ${row.missing.slice(0, 3).join(", ")}`,
      searchDemand: estimate.searchDemand, estimatedDifficulty: estimate.estimatedDifficulty, intent: "content_coverage",
      competitorStrength: 0, currentPage: row.page,
      businessValue: 1.2, conversionPotential: 1, technicalEffort: 1, contentEffort: 2,
      priorityScore: Number((reach * (1 - row.score / 100)).toFixed(2)),
      rationale: `The page for “${row.query}” in ${countryName(row.market)} grades ${row.grade} (${row.score}/100) against the top 3 results: it covers ${row.covered} of the ${row.topics.length} topics they share and has ${row.ownWords.toLocaleString("en")} words against their median of ${row.medianWords.toLocaleString("en")}. Missing: ${row.missing.join(", ")}.${estimate.priced ? ` ${estimate.priced}` : ""}`,
    });
  }
  return { made, existing };
}
