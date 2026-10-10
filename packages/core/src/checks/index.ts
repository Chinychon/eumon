import { createId } from "../ids.js";
import { severityFromImpact } from "../severity.js";
import type { Finding, Severity } from "../types.js";
import { CATALOG } from "./catalog.js";
import type { Check } from "./types.js";

export * from "./types.js";
export * from "./thresholds.js";
export * from "./health.js";
export { NOT_RUN } from "./not-run.js";

/** Every check by id. */
export const CHECKS: Record<string, Check> = Object.fromEntries(CATALOG.map((check) => [check.id, check]));

export function checkList(): Check[] {
  return CATALOG;
}

export type FindingInput = {
  siteId: string;
  analysisId: string;
  title: string;
  summary: string;
  evidence: Finding["evidence"];
  /** 0–100; severity follows it unless `severity` is given. */
  impact: number;
  severity?: Severity;
  recommendation?: string;
  pagesAffected?: string[];
  /** Distinguishes several findings from one check: the family, query or entity type. */
  scopeKey?: string;
  createdAt?: string;
};

/** A finding for a registered check: category and checkId from the check, recommendation from its docs unless the producer has a specific one. */
export function finding(check: Check, input: FindingInput): Finding {
  return {
    id: createId("finding"),
    siteId: input.siteId,
    analysisId: input.analysisId,
    category: check.category,
    checkId: check.id,
    ...(input.scopeKey ? { scopeKey: input.scopeKey } : {}),
    severity: input.severity ?? severityFromImpact(input.impact),
    title: input.title,
    summary: input.summary,
    evidence: input.evidence,
    organicImpactScore: input.impact,
    recommendation: input.recommendation ?? check.docs.how,
    pagesAffected: input.pagesAffected ?? [],
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
