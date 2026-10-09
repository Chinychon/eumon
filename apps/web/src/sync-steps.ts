import { DEMO_SITE_ID } from "@organic-growth/agents";
import { createId, type SiteRecord } from "@organic-growth/core";
import { getSite, indexStatusCounts, listSitesForResults, recordSyncRun, upsertMetricPoints, type D1Like, type SyncTrigger } from "@organic-growth/db";
import { syncResults, type GoogleAccess, type SignalKeys } from "./results-sync.ts";
import { COVERAGE_ROUNDS, coverageRound, inspectEumonPages, INSPECTION_STEP, PAGE_INSPECTIONS_PER_DAY } from "./url-inspection.ts";

/*
 * One site's Results sync as Workflow steps: the sources in one step, then
 * URL inspections 40 a step (the Free plan allows 50 subrequests a step), then
 * the sync run recorded with every note. `SearchSyncWorkflow` adapts
 * `WorkflowStep`; tests pass a plain function and count inspections per step.
 */

/** `step.do` with an optional retry policy (delay in milliseconds); tests pass a plain function. */
export type StepLike = { do<T>(name: string, fn: () => Promise<T>, options?: { retries: { limit: number; delay: number } }): Promise<T> };
export type SyncDeps = { db: D1Like; google: (siteId: string) => GoogleAccess; keys: SignalKeys; now: () => Date };
/** Every site for the daily run; one site for Sync now. */
export type SyncParams = { siteId?: string; trigger: SyncTrigger };

/** Steps a daily instance spends before coverage pauses: the Free plan allows 1,024 an instance, and every site still needs its record step. */
export const STEP_BUDGET = 1000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const n = (value: number) => value.toLocaleString("en");

type Round = { inspected: number; remaining: boolean; refused: number | null; error?: string };

/** Every site's sync (daily) or one site's (manual), each site's steps prefixed with its id; the notes per site. */
export async function syncSites(deps: SyncDeps, step: StepLike, params: SyncParams, options: { stepBudget?: number } = {}): Promise<Record<string, string>> {
  const siteIds = params.siteId ? [params.siteId] : await step.do("list-sites", () => listSitesForResults(deps.db));
  const budget = { used: params.siteId ? 0 : 1 };
  const results: Record<string, string> = {};
  for (const siteId of siteIds) results[siteId] = (await syncSite(deps, step, siteId, params.trigger, budget, options.stepBudget)).join("; ");
  return results;
}

/** One site: sources, Eumon pages, index counts, sitemap coverage, record. Returns the run's notes. */
export async function syncSite(deps: SyncDeps, step: StepLike, siteId: string, trigger: SyncTrigger, budget: { used: number }, stepBudget = STEP_BUDGET): Promise<string[]> {
  const startedAt = deps.now().toISOString();
  const today = startedAt.slice(0, 10);
  const run = <T>(name: string, fn: () => Promise<T>, options?: { retries: { limit: number; delay: number } }) => {
    budget.used++;
    return step.do(`${siteId}/${name}`, fn, options);
  };
  const notes = await run("sources", async () => {
    const site = await getSite(deps.db, siteId);
    if (!site) return ["skipped: site removed"];
    try {
      return await syncResults(deps.db, site, deps.now(), deps.google(siteId), deps.keys);
    } catch (error) {
      // A database error on one site must not stop the sites after it.
      return [`results failed: ${message(error)}`];
    }
  }, { retries: { limit: 1, delay: 60_000 } });
  const site = await getSite(deps.db, siteId);
  // The demo's property is fictional, and a site whose Google access failed has nothing to inspect with.
  if (site?.gscProperty && siteId !== DEMO_SITE_ID && !notes.some((note) => note.startsWith("google failed"))) {
    notes.push(...await inspectSite(deps, run, site, today, budget, stepBudget));
  }
  // The history is for the operator; failing to write it must not fail the sync.
  await run("record", () => recordSyncRun(deps.db, { id: createId("sync"), siteId, trigger, startedAt, finishedAt: deps.now().toISOString(), notes }).catch(() => undefined));
  return notes;
}

async function inspectSite(deps: SyncDeps, run: StepLike["do"], site: SiteRecord, today: string, budget: { used: number }, stepBudget: number): Promise<string[]> {
  const notes: string[] = [];
  const google = deps.google(site.id);
  const property = site.gscProperty!;
  let pages = 0;
  let refused: number | null = null;
  let failed: string | null = null;
  for (let round = 1; pages < PAGE_INSPECTIONS_PER_DAY && !refused && !failed; round++) {
    const limit = Math.min(INSPECTION_STEP, PAGE_INSPECTIONS_PER_DAY - pages);
    const result: Round = await run(`pages-${round}`, () => inspectEumonPages(deps.db, site, google, today, limit).catch((error): Round => ({ inspected: 0, remaining: false, refused: null, error: message(error) })));
    pages += result.inspected;
    refused = result.refused;
    failed = result.error ?? null;
    if (!result.remaining) break;
  }
  if (pages) notes.push(`inspected ${n(pages)} pages`);
  if (failed) notes.push(`inspection failed: ${failed}`);
  if (refused) notes.push(`inspection stopped: Google answered ${refused}`);
  if (pages) await run("index-counts", () => writeIndexCounts(deps.db, site.id, today));
  if (refused || failed) return notes;
  let covered = 0;
  let steps = 0;
  let paused = false;
  for (let round = 1; round <= COVERAGE_ROUNDS; round++) {
    if (budget.used >= stepBudget) {
      paused = true;
      break;
    }
    const result = await run(`coverage-${round}`, () => coverageRound(deps.db, site.id, property, google, today, INSPECTION_STEP));
    steps++;
    covered += result.inspected;
    refused = result.refused;
    failed = result.error ?? null;
    if (!result.remaining) break;
  }
  if (steps) notes.push(`coverage: inspected ${n(covered)} in ${steps} step${steps === 1 ? "" : "s"}`);
  if (failed) notes.push(`coverage failed: ${failed}`);
  if (refused) notes.push(`coverage stopped: Google answered ${refused}`);
  if (paused) notes.push("coverage paused: step budget");
  return notes;
}

/** The day's `pages_indexed` and `pages_not_indexed` from the stored inspections. */
async function writeIndexCounts(db: D1Like, siteId: string, day: string): Promise<void> {
  const counts = await indexStatusCounts(db, siteId);
  await upsertMetricPoints(db, siteId, [{ metric: "pages_indexed", day, value: counts.indexed }, { metric: "pages_not_indexed", day, value: counts.notIndexed }]);
}

/** Starts a sync instance: `daily-<day>` (one a day; an existing one is left alone) or `manual-<site>-<time>`. */
export async function startSync(
  env: { SEARCH_SYNC_WORKFLOW: { create(options: { id: string; params: SyncParams }): Promise<unknown> } },
  params: SyncParams,
  now = new Date(),
): Promise<{ id: string; created: boolean }> {
  const id = params.siteId ? `manual-${params.siteId}-${now.getTime()}` : `daily-${now.toISOString().slice(0, 10)}`;
  try {
    await env.SEARCH_SYNC_WORKFLOW.create({ id, params });
    return { id, created: true };
  } catch (error) {
    if (/exists/i.test(message(error))) return { id, created: false };
    throw error;
  }
}
