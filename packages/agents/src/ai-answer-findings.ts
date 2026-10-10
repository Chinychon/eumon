import { addDays, AI_ANSWER_ENGINES, bareDomain, countryName, createId, isOrUnder, latestChecks, severityFromImpact, type AiAnswerCheck, type Finding, type JsonObject, type Opportunity } from "@organic-growth/core";
import { listAiAnswerChecks, listAiPrompts, listSiteMarkets, type D1Like } from "@organic-growth/db";
import { estimateDemand } from "./demand.js";

/*
 * What AI answer tracking adds to an analysis: a finding when AI assistants
 * name competitors instead of the site, a finding per engine that stopped
 * citing the site, and an opportunity per question where competitors are
 * cited and the site isn't.
 */

export type AiAnswerSignals = { prompts: string[]; markets: string[]; checks: AiAnswerCheck[]; today: string };

/**
 * Thresholds, with their reasons. Only current questions in target markets
 * count. A lost citation stays while the site is still not cited, so History
 * says "Resolved" only when it is cited again (or its checks leave the 90 days read).
 */
export const AI_FINDINGS = {
  /** Days of checks read: how long a lost citation can stay while still lost. */
  LOOKBACK_DAYS: 90,
  /** One engine naming a competitor is one model's habit; two is a pattern across assistants. */
  ENGINES_AT_LEAST: 2,
  /** Fewer questions than this is an anecdote, not a finding. */
  QUESTIONS_AT_LEAST: 3,
  /** One question losing its citation is the answer churning; two in an engine is a shift. */
  LOST_AT_LEAST: 2,
  /** Opportunities are per question; more than this crowds out the rest of the plan. */
  OPPORTUNITIES_MAX: 5,
};

const LEVERS = "Answer each question directly in the first lines of a page, with figures and sources; add a question-and-answer section; keep the page's date current; and get listed on the sites AI cites for these questions (the AI answers card shows them).";
const engineLabel = (engine: string) => AI_ANSWER_ENGINES.find((entry) => entry.engine === engine)?.label ?? engine;
const named = (row: AiAnswerCheck) => row.rivals.filter((rival) => rival.mentioned || rival.cited).map((rival) => rival.domain);
/** The answer's first three distinct source domains. */
const citesNow = (row: AiAnswerCheck) => [...new Set(row.sources.map((source) => bareDomain(source.domain)))].slice(0, 3);

/** Checks of current questions in target markets within the lookback. */
function inWindow(signals: AiAnswerSignals): AiAnswerCheck[] {
  const since = addDays(signals.today, -AI_FINDINGS.LOOKBACK_DAYS);
  const prompts = new Set(signals.prompts);
  return signals.checks.filter((row) => prompts.has(row.prompt) && signals.markets.includes(row.market) && row.day >= since);
}

/** The latest answers grouped per (prompt, market). */
function byQuestion(signals: AiAnswerSignals): Map<string, AiAnswerCheck[]> {
  const map = new Map<string, AiAnswerCheck[]>();
  for (const row of latestChecks(inWindow(signals), signals.prompts, signals.markets)) {
    const key = `${row.prompt}|${row.market}`;
    map.set(key, [...(map.get(key) ?? []), row]);
  }
  return map;
}

export function findingsFromAiAnswers(input: { siteId: string; analysisId: string; signals: AiAnswerSignals | null | undefined }): Finding[] {
  if (!input.signals) return [];
  const drafts: Array<{ impact: number; title: string; summary: string; evidence: JsonObject; recommendation: string }> = [];

  // Competitors instead of you: rivals named or cited, and the site neither, in two engines or more.
  const questions = byQuestion(input.signals);
  const instead = [...questions.values()].flatMap((rows) => {
    const engines = rows.filter((row) => !row.mentioned && !row.cited && named(row).length);
    if (engines.length < AI_FINDINGS.ENGINES_AT_LEAST) return [];
    return [{ prompt: rows[0]!.prompt, market: rows[0]!.market, engines: engines.map((row) => row.engine), rivals: [...new Set(engines.flatMap(named))] }];
  });
  if (instead.length >= AI_FINDINGS.QUESTIONS_AT_LEAST) {
    const n = instead.length;
    const rivals = [...new Set(instead.flatMap((question) => question.rivals))];
    const listed = instead.slice(0, 5).map((question) => `“${question.prompt}” in ${countryName(question.market)}`).join("; ");
    drafts.push({
      impact: Math.min(70, 30 + 5 * n),
      title: `AI assistants name competitors but not you for ${n} of ${questions.size} questions`,
      summary: `In ${AI_FINDINGS.ENGINES_AT_LEAST} or more AI assistants, the latest answers name or cite competitors and neither name nor cite the site for: ${listed}${n > 5 ? ` and ${n - 5} more` : ""}. Competitors named: ${rivals.join(", ")}.`,
      evidence: { questions: instead, total: questions.size }, recommendation: LEVERS,
    });
  }

  // Lost citations: per engine, questions cited earlier and not in any check since.
  const series = new Map<string, AiAnswerCheck[]>();
  for (const row of inWindow(input.signals)) {
    const key = `${row.prompt}|${row.market}|${row.engine}`;
    series.set(key, [...(series.get(key) ?? []), row]);
  }
  const lost = new Map<string, Array<{ prompt: string; market: string; since: string; citesNow: string[] }>>();
  for (const rows of series.values()) {
    rows.sort((a, b) => a.day.localeCompare(b.day));
    const lastCited = rows.map((row) => row.cited).lastIndexOf(true);
    if (lastCited < 0 || lastCited === rows.length - 1) continue;
    const latest = rows.at(-1)!;
    lost.set(latest.engine, [...(lost.get(latest.engine) ?? []), { prompt: latest.prompt, market: latest.market, since: rows[lastCited + 1]!.day, citesNow: citesNow(latest) }]);
  }
  for (const [engine, rows] of lost) {
    if (rows.length < AI_FINDINGS.LOST_AT_LEAST) continue;
    const n = rows.length;
    const since = rows.map((row) => row.since).sort()[0]!;
    const label = engineLabel(engine);
    const listed = rows.map((row) => `“${row.prompt}” in ${countryName(row.market)} since ${row.since} (now cites ${row.citesNow.join(", ") || "no sources"})`).join("; ");
    drafts.push({
      impact: Math.min(75, 40 + 5 * n),
      title: `${label} stopped citing you for ${n} questions since ${since}`,
      summary: `${label} cited the site for these questions and no longer does: ${listed}.`,
      evidence: { engine, questions: rows }, recommendation: `Compare the page ${label} used to cite with the pages it cites now. ${LEVERS} History records the return.`,
    });
  }

  const createdAt = new Date().toISOString();
  return drafts.map((draft) => ({
    id: createId("finding"), siteId: input.siteId, analysisId: input.analysisId, category: "ai_visibility", severity: severityFromImpact(draft.impact),
    title: draft.title, summary: draft.summary, evidence: draft.evidence, organicImpactScore: draft.impact,
    recommendation: draft.recommendation, pagesAffected: [], createdAt,
  }));
}

/** Questions where an engine cites competitors and not the site, unless an opportunity already names them; top five. */
export function aiAnswerOpportunities(input: { siteId: string; analysisId: string; signals: AiAnswerSignals | null | undefined; existing: Opportunity[] }): Opportunity[] {
  if (!input.signals) return [];
  const quoted = new Set(input.existing.map((opportunity) => /“(.+?)”/.exec(opportunity.title)?.[1]?.toLowerCase()).filter(Boolean));
  const made: Opportunity[] = [];
  for (const rows of byQuestion(input.signals).values()) {
    const { prompt, market } = rows[0]!;
    const rivalCited = rows.filter((row) => row.rivals.some((rival) => rival.cited));
    const missing = rivalCited.filter((row) => !row.cited);
    if (!missing.length || quoted.has(prompt.toLowerCase())) continue;
    const pages = [...new Set(rivalCited.flatMap((row) => row.sources.filter((source) => row.rivals.some((rival) => rival.cited && isOrUnder(bareDomain(source.domain), rival.domain))).map((source) => source.url)))].slice(0, 3);
    const estimate = estimateDemand({ kind: "ai_answer", engines: missing.length });
    made.push({
      id: createId("opp"), siteId: input.siteId, analysisId: input.analysisId,
      title: `Get cited for “${prompt}” in AI answers (${countryName(market)})`,
      searchDemand: estimate.searchDemand, estimatedDifficulty: estimate.estimatedDifficulty, intent: "ai_answer",
      competitorStrength: rivalCited.length, businessValue: 1, conversionPotential: 1, technicalEffort: 1, contentEffort: 2,
      priorityScore: missing.length * 8 * (rivalCited.length >= 2 ? 1.5 : 1),
      rationale: `${missing.map((row) => engineLabel(row.engine)).join(", ")} cite${missing.length === 1 ? "s" : ""} competitors and not the site for “${prompt}” in ${countryName(market)}.${pages.length ? ` Pages they cite: ${pages.join(", ")}.` : ""} ${LEVERS}`,
    });
  }
  return made.sort((a, b) => b.priorityScore - a.priorityScore).slice(0, AI_FINDINGS.OPPORTUNITIES_MAX);
}

/** What the analysis reads: the questions, the target markets, and 90 days of checks; null when no question is tracked. */
export async function loadAiAnswerSignals(db: D1Like, siteId: string, today = new Date().toISOString().slice(0, 10)): Promise<AiAnswerSignals | null> {
  const prompts = await listAiPrompts(db, siteId);
  if (!prompts.length) return null;
  const [markets, checks] = await Promise.all([listSiteMarkets(db, siteId), listAiAnswerChecks(db, siteId, addDays(today, -AI_FINDINGS.LOOKBACK_DAYS))]);
  return { prompts, markets, checks, today };
}
