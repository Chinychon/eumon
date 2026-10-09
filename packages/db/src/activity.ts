import { runStatements, type D1Like } from "./d1.js";

/*
 * What the console did and received, for the operator to check: each Results
 * sync with its notes, and the latest conversion events the tracker sent.
 */

export type SyncTrigger = "manual" | "daily";
export type SyncRun = { id: string; trigger: SyncTrigger; startedAt: string; finishedAt: string; notes: string[] };

/** How many runs a site keeps; older ones are dropped as new ones arrive. */
const KEEP_RUNS = 30;

export async function recordSyncRun(db: D1Like, input: { id: string; siteId: string; trigger: SyncTrigger; startedAt: string; finishedAt: string; notes: string[] }): Promise<void> {
  await runStatements(db, [
    db.prepare("INSERT INTO sync_runs (id, site_id, trigger, started_at, finished_at, notes_json) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(input.id, input.siteId, input.trigger, input.startedAt, input.finishedAt, JSON.stringify(input.notes)),
    db.prepare(`DELETE FROM sync_runs WHERE site_id = ? AND id NOT IN (SELECT id FROM sync_runs WHERE site_id = ? ORDER BY started_at DESC LIMIT ${KEEP_RUNS})`)
      .bind(input.siteId, input.siteId),
  ]);
}

export async function listSyncRuns(db: D1Like, siteId: string, limit = 20): Promise<SyncRun[]> {
  const { results } = await db.prepare("SELECT id, trigger, started_at, finished_at, notes_json FROM sync_runs WHERE site_id = ? ORDER BY started_at DESC LIMIT ?")
    .bind(siteId, limit).all<{ id: string; trigger: SyncTrigger; started_at: string; finished_at: string; notes_json: string }>();
  return results.map((row) => ({ id: row.id, trigger: row.trigger, startedAt: row.started_at, finishedAt: row.finished_at, notes: JSON.parse(row.notes_json) as string[] }));
}

/** The one rule for a note that says something went wrong lives in core, where the console's pages can read it too. */
export { isProblemNote } from "@organic-growth/core";

export type RecentEvent = { id: string; event: string; destination: string | null; pageUrl: string | null; occurredAt: string; landedOnEumon: boolean };

/** The latest conversion events received, newest first, and whether each visitor first landed on an Eumon page. */
export async function listRecentEvents(db: D1Like, siteId: string, limit = 20): Promise<RecentEvent[]> {
  const { results } = await db.prepare(
    `SELECT e.id, e.event, e.destination, e.page_url, e.occurred_at, s.session_id AS landed
     FROM conversion_events e LEFT JOIN page_sessions s ON s.session_id = e.session_id AND s.site_id = e.site_id
     WHERE e.site_id = ? ORDER BY e.occurred_at DESC LIMIT ?`,
  ).bind(siteId, limit).all<{ id: string; event: string; destination: string | null; page_url: string | null; occurred_at: string; landed: string | null }>();
  return results.map((row) => ({ id: row.id, event: row.event, destination: row.destination, pageUrl: row.page_url, occurredAt: row.occurred_at, landedOnEumon: Boolean(row.landed) }));
}
