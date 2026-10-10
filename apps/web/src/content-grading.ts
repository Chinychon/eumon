import type { JsonLlm } from "@organic-growth/ai";
import { authorityDomain, DEMO_SITE_ID, fetchSerp, gradeTarget, pickContentTargets, type ContentGradeRow, type ContentTarget } from "@organic-growth/agents";
import { addDays, type SerpResult, type SiteRecord } from "@organic-growth/core";
import type { Fetcher } from "@organic-growth/crawler";
import {
  defaultPageSettings, getPageSettings, getSite, getSnapshot, listCurrentSearchMetrics, listRankChecks, listSiteMarkets, listSnapshots, listTrackedKeywords, saveSnapshot, type D1Like,
} from "@organic-growth/db";
import { charge, FREE_LIMITS, keysForLimits, limitsFor } from "./limits.ts";
import { saveSerpRows } from "./rank-tracking.ts";
import type { SignalKeys } from "./results-sync.ts";
import { dollars, marketLocation, said } from "./source-helpers.ts";
import type { StepLike, StepOptions } from "./sync-steps.ts";

/*
 * Content grading's analysis steps: pick the searches due and find who ranks
 * for each (the `serp` snapshot, or DataForSEO where the workspace may spend
 * it), grade four a step, then keep the latest grade per search in the
 * `content_grades` snapshot. Per target: 1 own page + 3 robots.txt + 3 rival
 * pages + 1–2 AI calls (DeepSeek retries once on bad JSON), redirect hops
 * extra: about 36 fetches a step at worst, under the Free plan's 50 with room
 * for hops. D1 calls don't count.
 */

export const CONTENT_STEP = 4;
const KIND = "content_grades";
/** A results page older than this is fetched again. */
const SERP_DAYS = 28;
/** Grades kept this long after their last check. */
const KEEP_DAYS = 90;
const RETRY_ONCE: StepOptions = { retries: { limit: 1, delay: 10_000 } };
const GRADE: StepOptions = { ...RETRY_ONCE, timeout: 10 * 60_000 };

type Site = Pick<SiteRecord, "id" | "baseUrl" | "workspaceId">;
const key = (query: string, market: string) => `${query.trim().toLowerCase()}|${market}`;
const scope = (site: Site) => authorityDomain(site.baseUrl);

export async function loadContentGrades(db: D1Like, site: Site): Promise<ContentGradeRow[]> {
  return (await getSnapshot<ContentGradeRow>(db, site.id, KIND, scope(site)))?.rows ?? [];
}

/** The latest grade per (query, market): this run's rows replace theirs, the others stay until they are 90 days old. */
export async function saveContentGrades(db: D1Like, site: Site, rows: ContentGradeRow[], today: string): Promise<void> {
  const fresh = new Set(rows.map((row) => key(row.query, row.market)));
  const since = addDays(today, -KEEP_DAYS);
  const kept = (await loadContentGrades(db, site)).filter((row) => !fresh.has(key(row.query, row.market)) && row.checkedAt.slice(0, 10) >= since);
  await saveSnapshot(db, site.id, { kind: KIND, scope: scope(site), periodEnd: today, rows: [...rows, ...kept] });
}

/** The searches due, each with its results page (by `key`); a search without one is skipped with a note. */
export async function contentTargets(db: D1Like, site: SiteRecord, today: string, keys: Pick<SignalKeys, "dataForSeo">, fetchFn: typeof fetch = fetch): Promise<{ targets: ContentTarget[]; serp: Record<string, SerpResult>; notes: string[] }> {
  const [checks, tracked, markets, searchRows, graded, lists] = await Promise.all([
    listRankChecks(db, site.id, addDays(today, -30)), listTrackedKeywords(db, site.id), listSiteMarkets(db, site.id),
    listCurrentSearchMetrics(db, site.id), loadContentGrades(db, site), listSnapshots<SerpResult>(db, site.id, "serp"),
  ]);
  const since = addDays(today, -SERP_DAYS);
  const stored = new Map(lists.flatMap((list) => list.rows.filter((row) => row.checkedAt.slice(0, 10) >= since).map((row) => [key(row.keyword, list.scope), row] as const)));
  const serp: Record<string, SerpResult> = {};
  const notes: string[] = [];
  const missing: ContentTarget[] = [];
  const picked = pickContentTargets({ checks, tracked, markets, searchRows, graded, today });
  for (const target of picked) {
    const row = stored.get(key(target.query, target.market));
    if (row) serp[key(target.query, target.market)] = row;
    else if (keys.dataForSeo && marketLocation(target.market) !== null) missing.push(target);
    else notes.push(`content grading skipped “${target.query}”: no results page (track it or add DataForSEO)`);
  }
  if (missing.length) {
    const language = ((await getPageSettings(db, site.id)) ?? defaultPageSettings(site.id, site.name, site.baseUrl)).language;
    const answers = await Promise.allSettled(missing.map((target) => fetchSerp(keys.dataForSeo!, { keyword: target.query, location: marketLocation(target.market)!, language, site: scope(site), checkedAt: today, volume: null }, fetchFn)));
    const pages = new Map<string, SerpResult[]>();
    let cost = 0;
    answers.forEach((answer, index) => {
      const target = missing[index]!;
      if (answer.status === "rejected") {
        notes.push(`content grading skipped “${target.query}”: no results page (${said(answer.reason)})`);
        return;
      }
      serp[key(target.query, target.market)] = answer.value.row;
      cost += answer.value.cost;
      pages.set(target.market, [...(pages.get(target.market) ?? []), answer.value.row]);
    });
    for (const [market, rows] of pages) await saveSerpRows(db, site.id, market, rows, today);
    const fetched = [...pages.values()].flat().length;
    if (fetched) notes.push(`content grading: ${fetched} results page${fetched === 1 ? "" : "s"} fetched, ${dollars(cost)}`);
  }
  return { targets: picked.filter((target) => serp[key(target.query, target.market)]), serp, notes };
}

/** The workspace's daily AI allowance said no; the rest of the targets wait for tomorrow. */
class AllowanceRefused extends Error {}

/**
 * One step's targets, in sequence. Skips become notes. A throw (a bad AI key, the allowance used up)
 * ends the slice with one note and `stop`, keeping the grades made before it.
 */
export async function gradeSlice(db: D1Like, site: Site, slice: ContentTarget[], serp: Record<string, SerpResult>, llm: JsonLlm | null, fetcher?: Fetcher): Promise<{ rows: ContentGradeRow[]; notes: string[]; stop: boolean }> {
  const rows: ContentGradeRow[] = [];
  const notes: string[] = [];
  // One AI run per target that reaches the AI; a site outside any workspace has no ledger (and grades at most 8 an analysis).
  // A retried step charges its targets again: the first attempt's charges aren't refunded.
  const beforeAi = async () => {
    const refusal = site.workspaceId ? await charge(db, site.workspaceId, "aiRunsPerDay") : null;
    if (refusal) throw new AllowanceRefused(refusal);
  };
  try {
    for (const target of slice) {
      const result = await gradeTarget(target, { serpRow: serp[key(target.query, target.market)]!, site: scope(site), llm, fetcher, beforeAi });
      if ("row" in result) rows.push(result.row);
      else notes.push(`content grading skipped “${target.query}”: ${result.skipped}`);
    }
  } catch (error) {
    notes.push(error instanceof AllowanceRefused ? `content grading: ${error.message}` : `content grading failed: ${said(error)}`);
    return { rows, notes, stop: true };
  }
  return { rows, notes, stop: false };
}

export type ContentDeps = { db: D1Like; siteId: string; now: () => Date; keys: SignalKeys; llm: () => JsonLlm | null; fetcher?: Fetcher; fetchFn?: typeof fetch };

/**
 * The analysis' content steps: targets, four a step, save. A step that dies costs its note and the analysis goes on.
 * Keys and the AI client are made inside each step: a step's output is persisted, so credentials never pass through one.
 */
export async function gradeContentSteps(step: StepLike, deps: ContentDeps): Promise<string[]> {
  if (deps.siteId === DEMO_SITE_ID) return []; // seeded; its domains are fictional
  const { db } = deps;
  const site = async () => {
    const record = await getSite(db, deps.siteId);
    if (!record) throw new Error("the site no longer exists");
    return record;
  };
  const safe = async <T>(name: string, fn: () => Promise<T>, options?: StepOptions): Promise<{ ok: T } | { error: string }> => {
    try {
      return { ok: await step.do(name, fn, options) };
    } catch (error) {
      return { error: said(error) };
    }
  };

  const picked = await safe("content-targets", async () => {
    const record = await site();
    const keys = keysForLimits(deps.keys, record.workspaceId ? await limitsFor(db, record.workspaceId) : FREE_LIMITS);
    const today = deps.now().toISOString().slice(0, 10);
    return { today, ...(await contentTargets(db, record, today, keys, deps.fetchFn)) };
  }, RETRY_ONCE);
  if ("error" in picked) return [`content grading failed: ${picked.error}`];
  const { today, targets, serp } = picked.ok;
  const notes = [...picked.ok.notes];
  const rows: ContentGradeRow[] = [];
  for (let start = 0, n = 1; start < targets.length; start += CONTENT_STEP, n++) {
    const slice = targets.slice(start, start + CONTENT_STEP);
    const graded = await safe(`content-grades-${n}`, async () => gradeSlice(db, await site(), slice, serp, deps.llm(), deps.fetcher), GRADE);
    if ("error" in graded) { notes.push(`content grading failed: ${graded.error}`); continue; }
    rows.push(...graded.ok.rows);
    notes.push(...graded.ok.notes);
    if (graded.ok.stop) break; // a setup problem or the day's allowance: the next step would hit it too
  }
  if (targets.length) {
    const saved = await safe("content-save", async () => saveContentGrades(db, await site(), rows, today));
    if ("error" in saved) notes.push(`content grading failed: ${saved.error}`);
  }
  return notes;
}
