import type { SiteRecord } from "@organic-growth/core";
import { firstMetricDay, upsertMetricPoints, type D1Like, type MetricPoint } from "@organic-growth/db";
import { SOURCES } from "./results-sources.ts";

/** Connects to Google only when a Google step runs; the token and the scopes it was granted come together. */
export type GoogleAccess = { connect: () => Promise<{ token: string; scopes: string[] }>; fetchFn?: typeof fetch };

/**
 * API keys for the signals that need no Google sign-in: CrUX and PageSpeed (Google API key), Open PageRank, DataForSEO,
 * Bing Webmaster Tools, and the server secret each site's IndexNow key is derived from.
 */
export type SignalKeys = { googleApiKey?: string; openPageRankKey?: string; dataForSeo?: { login: string; password: string }; bingApiKey?: string; indexNowSecret?: string };

/** What every source gets: the site, the day, the keys, and Google on demand (connected once per sync). */
export type SyncContext = {
  db: D1Like;
  site: SiteRecord;
  today: string;
  now: Date;
  keys: SignalKeys;
  /** Sitemap URLs to inspect in this sync; the daily workflow runs more rounds after it. */
  coverageLimit: number;
  fetchFn?: typeof fetch;
  google: () => Promise<{ token: string; scopes: string[] }>;
};

/**
 * One thing the sync collects. The runner decides whether it runs today,
 * writes its points and marker, and turns a throw into a "<name> failed" note.
 */
export type Source = {
  /** Prefix of its notes: "speed: 40 weeks", "speed failed: …". */
  name: string;
  /** Daily sources run every sync (a daily source that keeps lists decides inside which are stale). Weekly ones run on Mondays, or until their marker exists. */
  cadence: "daily" | "weekly";
  /** Written after each run (value: points written). Its absence means a first run, which backfills. */
  marker?: string;
  /** Needs the site's Google token; when connecting fails, the runner notes it once and skips them all. */
  google?: boolean;
  /** False when the source has nothing to do for this site (no property, no key): skipped silently. */
  applies?: (ctx: SyncContext) => boolean;
  /** A note saying why the source can't run today, or null. For Google sources, Google is connected by then. */
  skip?: (ctx: SyncContext) => Promise<string | null>;
  /** Fetches today's points; `first` on the first run. May save snapshots itself. */
  run: (ctx: SyncContext, first: boolean) => Promise<{ points?: MetricPoint[]; notes?: string[] }>;
};

/** URL inspections in a "Sync now": batches of ten wait on Google's slowest answer, so 50 keeps the button to about half a minute. */
const SYNC_NOW_COVERAGE = 50;

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * One site's Results sync: every source in turn, each failing on its own.
 * The notes say what ran, what was skipped and why.
 */
export async function syncResults(db: D1Like, site: SiteRecord, now: Date, google: GoogleAccess, keys: SignalKeys = {}, coverageLimit = SYNC_NOW_COVERAGE): Promise<string[]> {
  const today = now.toISOString().slice(0, 10);
  let access: Promise<{ token: string; scopes: string[] }> | undefined;
  const ctx: SyncContext = { db, site, today, now, keys, coverageLimit, fetchFn: google.fetchFn, google: () => (access ??= google.connect()) };
  const notes: string[] = [];
  let googleFailed = false;
  for (const source of SOURCES) {
    if (source.applies && !source.applies(ctx)) continue;
    if (source.google) {
      if (googleFailed) continue;
      try {
        await ctx.google();
      } catch (error) {
        googleFailed = true;
        notes.push(`google failed: ${reason(error)}`);
        continue;
      }
    }
    const skipped = source.skip ? await source.skip(ctx) : null;
    if (skipped) {
      notes.push(skipped);
      continue;
    }
    const first = source.marker ? !(await firstMetricDay(db, site.id, source.marker)) : false;
    if (source.cadence === "weekly" && !first && now.getUTCDay() !== 1) continue;
    try {
      const { points = [], notes: said = [] } = await source.run(ctx, first);
      if (source.marker) points.push({ metric: source.marker, day: today, value: points.length });
      if (points.length) await upsertMetricPoints(db, site.id, points);
      notes.push(...said);
    } catch (error) {
      notes.push(`${source.name} failed: ${reason(error)}`);
    }
  }
  return notes;
}
