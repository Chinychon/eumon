import { DEMO_SITE_ID } from "@organic-growth/agents";
import { addDays, createId, type SiteRecord } from "@organic-growth/core";
import {
  countInspectionsSince, getSite, indexStatusCounts, listSitesForResults, publishedPages, recordSyncRun, upsertMetricPoints, urlsToInspect, type D1Like, type SyncTrigger,
} from "@organic-growth/db";
import { keysForLimits, limitsFor } from "./limits.ts";
import { syncResults, type GoogleAccess, type SignalKeys } from "./results-sync.ts";
import { COVERAGE_URLS_PER_DAY, inspectEumonPages, inspectQueuedUrls, INSPECTION_STEP, PAGE_INSPECTIONS_PER_DAY } from "./url-inspection.ts";

/*
 * One site's Results sync as Workflow steps: the generated pages' search data,
 * the sources, then URL inspections 40 a step (the Free plan allows 50
 * subrequests a step) against what is left of Google's 2,000 a day for the
 * property, then the sync run recorded with every note. One instance per site
 * (`startDailySyncs`, `startSync`), so each has its own 1,024 steps.
 * `SearchSyncWorkflow` adapts `WorkflowStep`; tests pass a plain function and
 * count inspections per step.
 */

export type StepOptions = { retries?: { limit: number; delay: number }; timeout?: number };
/** `step.do` with an optional retry policy and timeout (milliseconds); tests pass a plain function. */
export type StepLike = { do<T>(name: string, fn: () => Promise<T>, options?: StepOptions): Promise<T> };
export type SyncDeps = {
  db: D1Like;
  google: (siteId: string) => GoogleAccess;
  keys: SignalKeys;
  now: () => Date;
  /** The generated pages' Search Console data (page × query, page × day); absent in tests that don't need it. */
  pageSearch?: (site: SiteRecord) => Promise<{ queries: number }>;
};
export type SyncParams = { siteId: string; trigger: SyncTrigger };
export type SyncBinding = {
  create(options: { id: string; params: SyncParams }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
};

/** Google's URL Inspection quota per property per (Pacific) day. */
export const DAILY_QUOTA = 2000;
/** Clicks of Sync now within this window join the same run. */
const MANUAL_WINDOW_MS = 10 * 60_000;
/** Inspection steps: one retry, and a hung Google answer ends the step rather than the day. */
const INSPECT: StepOptions = { retries: { limit: 1, delay: 30_000 }, timeout: 3 * 60_000 };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const n = (value: number) => value.toLocaleString("en");
type Outcome<T> = { ok: T } | { error: string };

/** Midnight in Los Angeles for the day the instant falls on there: Google's quota day. */
export function pacificDayStart(now: Date): Date {
  const la = (date: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", ...options }).format(date);
  const day = la(now, { year: "numeric", month: "2-digit", day: "2-digit" });
  for (const offset of ["-07:00", "-08:00"]) {
    const candidate = new Date(`${day}T00:00:00${offset}`);
    if (la(candidate, { year: "numeric", month: "2-digit", day: "2-digit" }) === day && Number(la(candidate, { hour: "numeric", hourCycle: "h23" })) === 0) return candidate;
  }
  return new Date(`${day}T00:00:00-08:00`);
}

/** One site: start (what is left of the quota), page search, sources, Eumon pages, index counts, coverage, record. Returns the run's notes. */
export async function syncSite(deps: SyncDeps, step: StepLike, siteId: string, trigger: SyncTrigger): Promise<string[]> {
  // A step that fails after its retries costs its note, never the run.
  const safe = async <T>(name: string, fn: () => Promise<T>, options?: StepOptions): Promise<Outcome<T>> => {
    try {
      return { ok: await step.do(`${siteId}/${name}`, fn, options) };
    } catch (error) {
      return { error: message(error) };
    }
  };
  const runId = createId("sync");
  const notes: string[] = [];
  const start = await safe("start", async () => {
    const site = await getSite(deps.db, siteId);
    if (!site) return null;
    const startedAt = deps.now().toISOString();
    const inspects = Boolean(site.gscProperty) && siteId !== DEMO_SITE_ID;
    return {
      site, startedAt,
      spent: inspects ? await countInspectionsSince(deps.db, siteId, pacificDayStart(new Date(startedAt)).toISOString()) : 0,
      published: inspects ? (await publishedPages(deps.db, siteId)).published : 0,
    };
  });
  const startedAt = "ok" in start && start.ok ? start.ok.startedAt : deps.now().toISOString();
  if ("error" in start) notes.push(`start failed: ${start.error}`);
  else if (!start.ok) notes.push("skipped: site removed");
  else {
    const { site, spent, published } = start.ok;
    const inspects = Boolean(site.gscProperty) && siteId !== DEMO_SITE_ID;
    if (deps.pageSearch && inspects && published > 0) {
      const pages = await safe("page-search", () => deps.pageSearch!(site).then((result) => `pages: ${n(result.queries)} query rows`, (error) => `pages failed: ${message(error)}`));
      notes.push("ok" in pages ? pages.ok : `pages failed: ${pages.error}`);
    }
    const sources = await safe("sources", async () => {
      const keys = site.workspaceId ? keysForLimits(deps.keys, await limitsFor(deps.db, site.workspaceId)) : deps.keys;
      return syncResults(deps.db, site, deps.now(), deps.google(siteId), keys).catch((error) => [`results failed: ${message(error)}`]);
    }, { retries: { limit: 1, delay: 60_000 } });
    notes.push(...("ok" in sources ? sources.ok : [`results failed: ${sources.error}`]));
    // A site whose Google access failed has nothing to inspect with.
    if (inspects && !notes.some((note) => note.startsWith("google failed"))) notes.push(...await inspectSite(deps, safe, site, startedAt.slice(0, 10), spent, published));
  }
  // The history is for the operator; failing to write it must not fail the sync.
  await safe("record", () => recordSyncRun(deps.db, { id: runId, siteId, trigger, startedAt, finishedAt: deps.now().toISOString(), notes }));
  return notes;
}

type Safe = <T>(name: string, fn: () => Promise<T>, options?: StepOptions) => Promise<Outcome<T>>;

async function inspectSite(deps: SyncDeps, safe: Safe, site: SiteRecord, today: string, spent: number, published: number): Promise<string[]> {
  const notes: string[] = [];
  const google = deps.google(site.id);
  const property = site.gscProperty!;
  const left = DAILY_QUOTA - spent;
  if (spent > 0) notes.push(`quota: ${n(spent)} inspections already today, ${n(Math.max(left, 0))} left`);
  if (left <= 0) return notes;
  // Eumon pages: up to 100 a day in steps of 40. A page Google fails on is recorded as checked today, so it is not asked again; the round cap, not the answers, ends the loop.
  const pageCap = Math.min(PAGE_INSPECTIONS_PER_DAY, left);
  let asked = 0;
  let inspected = 0;
  let refused: number | null = null;
  for (let round = 1; published > 0 && asked < pageCap && round <= Math.ceil(PAGE_INSPECTIONS_PER_DAY / INSPECTION_STEP); round++) {
    const limit = Math.min(INSPECTION_STEP, pageCap - asked);
    const result = await safe(`pages-${round}`, () => inspectEumonPages(deps.db, site, google, today, limit), INSPECT);
    if ("error" in result) {
      notes.push(`inspection failed: ${result.error}`);
      break;
    }
    asked += result.ok.asked;
    inspected += result.ok.inspected;
    refused = result.ok.refused;
    if (refused || result.ok.asked < limit) break;
  }
  if (asked) notes.push(`inspected ${n(inspected)} pages`);
  if (inspected) {
    const counts = await safe("index-counts", () => writeIndexCounts(deps.db, site.id, today));
    if ("error" in counts) notes.push(`index counts failed: ${counts.error}`);
  }
  if (refused) {
    notes.push(`inspection stopped: Google answered ${refused}`);
    return notes;
  }
  // Sitemap URLs: the day's queue read once, then 40 a step.
  const budget = Math.min(COVERAGE_URLS_PER_DAY, left - asked);
  if (budget <= 0) return notes;
  const queue = await safe("coverage-queue", () => urlsToInspect(deps.db, site.id, budget, addDays(today, -30)));
  if ("error" in queue) {
    notes.push(`coverage failed: ${queue.error}`);
    return notes;
  }
  let covered = 0;
  let steps = 0;
  for (let offset = 0, round = 1; offset < queue.ok.length; offset += INSPECTION_STEP, round++) {
    const slice = queue.ok.slice(offset, offset + INSPECTION_STEP);
    const result = await safe(`coverage-${round}`, () => inspectQueuedUrls(deps.db, site.id, property, google, slice), INSPECT);
    if ("error" in result) {
      notes.push(`coverage failed: ${result.error}`);
      break;
    }
    steps++;
    covered += result.ok.inspected;
    refused = result.ok.refused;
    if (refused) break;
  }
  if (steps) notes.push(`coverage: inspected ${n(covered)} in ${steps} step${steps === 1 ? "" : "s"}`);
  if (refused) notes.push(`coverage stopped: Google answered ${refused}`);
  return notes;
}

/** The day's `pages_indexed` and `pages_not_indexed` from the stored inspections. */
async function writeIndexCounts(db: D1Like, siteId: string, day: string): Promise<void> {
  const counts = await indexStatusCounts(db, siteId);
  await upsertMetricPoints(db, siteId, [{ metric: "pages_indexed", day, value: counts.indexed }, { metric: "pages_not_indexed", day, value: counts.notIndexed }]);
}

const dailyId = (now: Date, siteId: string) => `daily-${now.toISOString().slice(0, 10)}-${siteId}`;

async function inFlight(env: { SEARCH_SYNC_WORKFLOW: SyncBinding }, id: string): Promise<boolean> {
  try {
    const { status } = await (await env.SEARCH_SYNC_WORKFLOW.get(id)).status();
    return ["queued", "running", "paused", "waiting", "waitingForPause"].includes(status);
  } catch {
    return false;
  }
}

/**
 * Starts a sync instance for one site. A daily instance is `daily-<day>-<site>`;
 * a manual one is `manual-<site>-<window>`, so clicks within ten minutes join
 * one run (its `startedAt` is the window's start, which the run's record
 * follows). A manual sync waits while the site's daily run is going
 * (`running`), so the two never spend the day's quota twice.
 */
export async function startSync(env: { SEARCH_SYNC_WORKFLOW: SyncBinding }, params: SyncParams, now = new Date()): Promise<{ id: string; created: boolean; startedAt: string; running?: string }> {
  const window = Math.floor(now.getTime() / MANUAL_WINDOW_MS) * MANUAL_WINDOW_MS;
  const daily = dailyId(now, params.siteId);
  const id = params.trigger === "daily" ? daily : `manual-${params.siteId}-${window}`;
  const startedAt = params.trigger === "daily" ? now.toISOString() : new Date(window).toISOString();
  if (params.trigger === "manual" && await inFlight(env, daily)) return { id: daily, created: false, startedAt, running: daily };
  try {
    await env.SEARCH_SYNC_WORKFLOW.create({ id, params });
    return { id, created: true, startedAt };
  } catch (error) {
    // The error's wording is Cloudflare's; an instance that can be fetched is the one that exists.
    try {
      await env.SEARCH_SYNC_WORKFLOW.get(id);
      return { id, created: false, startedAt };
    } catch {
      throw error;
    }
  }
}

/** The cron's work: one daily instance per site (the Free plan allows 100 at once). Returns the ids created; a second firing the same day creates none. */
export async function startDailySyncs(env: { DB: D1Like; SEARCH_SYNC_WORKFLOW: SyncBinding }, now = new Date()): Promise<string[]> {
  const created: string[] = [];
  for (const siteId of await listSitesForResults(env.DB)) {
    const result = await startSync(env, { siteId, trigger: "daily" }, now);
    if (result.created) created.push(result.id);
  }
  return created;
}
