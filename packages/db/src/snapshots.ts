import type { TopQuery } from "@organic-growth/core";
import { nowIso, type D1Like } from "./d1.js";

/*
 * Snapshots: lists that replace themselves (the Results spec's "latest list"),
 * beside the ledger's numbers over time. One row per site, kind and scope.
 */

export type Snapshot<T> = { periodEnd: string; rows: T[] };

/** The statement that replaces the list of this kind and scope, for batching. */
export function snapshotStatement<T>(db: D1Like, siteId: string, input: { kind: string; scope: string; periodEnd: string; rows: T[] }) {
  return db.prepare(
    `INSERT INTO site_snapshots (site_id, kind, scope, period_end, rows_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id, kind, scope) DO UPDATE SET period_end = excluded.period_end, rows_json = excluded.rows_json, updated_at = excluded.updated_at`,
  ).bind(siteId, input.kind, input.scope, input.periodEnd, JSON.stringify(input.rows), nowIso());
}

/** Replaces the list of this kind and scope. */
export async function saveSnapshot<T>(db: D1Like, siteId: string, input: { kind: string; scope: string; periodEnd: string; rows: T[] }): Promise<void> {
  await snapshotStatement(db, siteId, input).run();
}

export async function getSnapshot<T>(db: D1Like, siteId: string, kind: string, scope: string): Promise<Snapshot<T> | null> {
  const row = await db.prepare("SELECT period_end, rows_json FROM site_snapshots WHERE site_id = ? AND kind = ? AND scope = ?")
    .bind(siteId, kind, scope).first<{ period_end: string; rows_json: string }>();
  return row ? { periodEnd: row.period_end, rows: JSON.parse(row.rows_json) as T[] } : null;
}

/** Each list's period end by scope, without parsing the lists: for deciding what to refresh. */
export async function listSnapshotDates(db: D1Like, siteId: string, kind: string): Promise<Record<string, string>> {
  const { results } = await db.prepare("SELECT scope, period_end FROM site_snapshots WHERE site_id = ? AND kind = ?")
    .bind(siteId, kind).all<{ scope: string; period_end: string }>();
  return Object.fromEntries(results.map((row) => [row.scope, row.period_end]));
}

/** Every list of one kind, by scope. */
export async function listSnapshots<T>(db: D1Like, siteId: string, kind: string): Promise<Array<Snapshot<T> & { scope: string }>> {
  const { results } = await db.prepare("SELECT scope, period_end, rows_json FROM site_snapshots WHERE site_id = ? AND kind = ? ORDER BY scope")
    .bind(siteId, kind).all<{ scope: string; period_end: string; rows_json: string }>();
  return results.map((row) => ({ scope: row.scope, periodEnd: row.period_end, rows: JSON.parse(row.rows_json) as T[] }));
}

/** Which fetch a top-queries list belongs to: a different property or set of markets makes it stale. */
export type QueryScope = { property: string; markets: string[] };
const queryScope = ({ property, markets }: QueryScope) => `${property}|${[...markets].sort().join(",")}`;

export const saveTopQueriesSnapshot = (db: D1Like, siteId: string, input: QueryScope & { periodEnd: string; rows: TopQuery[] }) =>
  saveSnapshot(db, siteId, { kind: "top_queries", scope: queryScope(input), periodEnd: input.periodEnd, rows: input.rows });

export const getTopQueriesSnapshot = (db: D1Like, siteId: string, scope: QueryScope) => getSnapshot<TopQuery>(db, siteId, "top_queries", queryScope(scope));
