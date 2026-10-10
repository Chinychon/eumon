import { authorityDomain, DEMO_SITE_ID, fetchAiAnswer } from "@organic-growth/agents";
import { addDays, aiAnswerPoints, AI_ANSWER_ENGINES, AI_CHECK_FRESH_DAYS, AI_RETRY_DAYS, countryAlpha2, readAnswer, type AiAnswerCheck, type AiAnswerEngine, type SiteRecord } from "@organic-growth/core";
import {
  aiLastChecked, defaultPageSettings, getPageSettings, listAiAnswerChecks, listAiBrandNames, listAiPrompts, listSiteCompetitorDomains, listSiteMarkets,
  pruneAiAnswerChecks, saveAiAnswerChecks, upsertMetricPoints, type D1Like,
} from "@organic-growth/db";
import { dollars, marketLocation, said, sliceByMarket } from "./source-helpers.ts";
import type { StepOptions } from "./sync-steps.ts";

/*
 * AI answer tracking's steps: each question is asked of each engine in each
 * target market once a week. Due checks are spread over the week (at most
 * AI_CHECKS_PER_DAY attempts a site a day, oldest first), asked 20 a step in
 * one market, ten at a time: a live scraper answer can take 90 seconds. Every
 * attempt is saved; one with no answer is retried after AI_RETRY_DAYS.
 */

export const AI_STEP = 20;
export const AI_CHECKS_PER_DAY = 40;
const KEEP_DAYS = 400;
const AI: StepOptions = { retries: { limit: 1, delay: 30_000 }, timeout: 10 * 60_000 };
const ENGINE_LABEL = Object.fromEntries(AI_ANSWER_ENGINES.map(({ engine, label }) => [engine, label])) as Record<AiAnswerEngine, string>;

export type AiTarget = { prompt: string; market: string; engine: AiAnswerEngine };
type Auth = { login: string; password: string };

/** The day's due checks: every prompt × covered market × engine never asked, or last answered a week ago, or last unanswered AI_RETRY_DAYS ago; oldest first, capped less today's attempts, market-major for slicing. */
export async function aiQueue(db: D1Like, site: SiteRecord, today: string): Promise<{ targets: AiTarget[]; notes: string[] }> {
  const [prompts, markets, last] = await Promise.all([listAiPrompts(db, site.id), listSiteMarkets(db, site.id), aiLastChecked(db, site.id, addDays(today, -90))]);
  const notes: string[] = [];
  const covered = markets.filter((market) => {
    if (marketLocation(market) !== null) return true;
    notes.push(`ai answers skipped ${market}: DataForSEO doesn't cover it`);
    return false;
  });
  const staleBefore = addDays(today, -AI_CHECK_FRESH_DAYS + 1);
  const retryBefore = addDays(today, -AI_RETRY_DAYS + 1);
  const attemptedToday = [...last.values()].filter((attempt) => attempt.day === today).length;
  const due = covered.flatMap((market) => prompts.flatMap((prompt) => AI_ANSWER_ENGINES.map(({ engine }) => {
    const attempt = last.get(`${prompt}|${market}|${engine}`);
    return { prompt, market, engine, last: attempt?.day ?? "", answered: attempt?.answered ?? false };
  })))
    .filter((target) => target.last < (target.answered ? staleBefore : retryBefore))
    .sort((a, b) => a.last.localeCompare(b.last))
    .slice(0, Math.max(0, AI_CHECKS_PER_DAY - attemptedToday));
  const order = new Map(covered.map((market, index) => [market, index]));
  const targets = due.sort((a, b) => order.get(a.market)! - order.get(b.market)!).map(({ prompt, market, engine }) => ({ prompt, market, engine }));
  return { targets, notes };
}

/** One slice: ask each engine, ten at a time; read each answer; save every attempt in one batch, those with no answer as unanswered. `checked` counts the answers. */
export async function checkAiAnswers(db: D1Like, site: SiteRecord, auth: Auth, today: string, targets: AiTarget[], fetchFn: typeof fetch = fetch): Promise<{ checked: number; cost: number; notes: string[] }> {
  const [settings, brandNames, competitors] = await Promise.all([getPageSettings(db, site.id), listAiBrandNames(db, site.id), listSiteCompetitorDomains(db, site.id)]);
  const language = (settings ?? defaultPageSettings(site.id, site.name, site.baseUrl)).language;
  const own = authorityDomain(site.baseUrl);
  const rows: AiAnswerCheck[] = [];
  const notes: string[] = [];
  let cost = 0;
  // An attempt with no answer says nothing about the site: saved only so the queue waits AI_RETRY_DAYS before asking again.
  const unanswered = (target: AiTarget) => rows.push({ ...target, day: today, answered: false, mentioned: false, cited: false, citedRank: null, sources: [], rivals: [], excerpt: "" });
  for (let start = 0; start < targets.length; start += 10) {
    const group = targets.slice(start, start + 10);
    const answers = await Promise.allSettled(group.map((target) => fetchAiAnswer(auth, { engine: target.engine, prompt: target.prompt, location: marketLocation(target.market)!, language, countryIso2: countryAlpha2(target.market) }, fetchFn)));
    answers.forEach((answer, index) => {
      const target = group[index]!;
      if (answer.status === "rejected") {
        notes.push(`ai answers refused on ${ENGINE_LABEL[target.engine]} for “${target.prompt}” in ${target.market}: ${said(answer.reason)}`);
        unanswered(target);
        return;
      }
      cost += answer.value.cost;
      if (!answer.value.text.trim() && !answer.value.sources.length) {
        notes.push(`ai answers: ${ENGINE_LABEL[target.engine]} gave no answer to “${target.prompt}” in ${target.market}`);
        unanswered(target);
        return;
      }
      // Only the names users enter: a site's name is often a repository slug ("website", "app") that would match nearly every answer.
      const read = readAnswer({ prompt: target.prompt, text: answer.value.text, sources: answer.value.sources, brandNames, site: own, competitors });
      rows.push({ ...target, day: today, answered: true, ...read, sources: answer.value.sources.slice(0, 20) });
    });
  }
  await saveAiAnswerChecks(db, site.id, rows);
  return { checked: rows.filter((row) => row.answered).length, cost, notes };
}

/** The day's ledger points and marker, then the prune. */
export async function writeAiCounts(db: D1Like, site: SiteRecord, today: string): Promise<void> {
  const [checks, prompts, markets, competitors] = await Promise.all([
    listAiAnswerChecks(db, site.id, addDays(today, -AI_CHECK_FRESH_DAYS)), listAiPrompts(db, site.id), listSiteMarkets(db, site.id), listSiteCompetitorDomains(db, site.id),
  ]);
  const points = aiAnswerPoints(checks, prompts, markets, competitors, today);
  await upsertMetricPoints(db, site.id, [...points, { metric: "sync.ai_answers", day: today, value: points.length }]);
  await pruneAiAnswerChecks(db, site.id, addDays(today, -KEEP_DAYS));
}

type Safe = <T>(name: string, fn: () => Promise<T>, options?: StepOptions) => Promise<{ ok: T } | { error: string }>;

/** The step group for one site: queue, 20 a step in one market, counts. Returns the run's notes. */
export async function trackAiAnswers(db: D1Like, safe: Safe, site: SiteRecord, auth: Auth, today: string, fetchFn?: typeof fetch): Promise<string[]> {
  if (site.id === DEMO_SITE_ID) return [];
  const queue = await safe("ai-queue", () => aiQueue(db, site, today));
  if ("error" in queue) return [`ai answers failed: ${queue.error}`];
  const notes = [...queue.ok.notes];
  if (!queue.ok.targets.length) return notes;
  let checked = 0;
  let cost = 0;
  let steps = 0;
  let round = 0;
  for (const slice of sliceByMarket(queue.ok.targets, AI_STEP)) {
    round++;
    const result = await safe(`ai-${round}`, () => checkAiAnswers(db, site, auth, today, slice, fetchFn), AI);
    if ("error" in result) { notes.push(`ai answers failed: ${result.error}`); continue; }
    steps++;
    checked += result.ok.checked;
    cost += result.ok.cost;
    notes.push(...result.ok.notes);
  }
  if (checked) {
    notes.unshift(`ai answers: ${checked} checked in ${steps} step${steps === 1 ? "" : "s"}, ${dollars(cost)}`);
    const counts = await safe("ai-counts", () => writeAiCounts(db, site, today));
    if ("error" in counts) notes.push(`ai answers counts failed: ${counts.error}`);
  }
  return notes;
}
