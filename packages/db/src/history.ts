import { runKeys, type Finding, type HistoryRun, type KeyRow } from "@organic-growth/core";
import { runStatements, type D1Like } from "./d1.js";
import { getSnapshot, listSnapshots, snapshotStatement } from "./snapshots.js";

/*
 * History: each finished run's finding key list in the snapshot store (kind
 * `finding_keys`, scope = the analysis id), so the Dashboard's History tab
 * can diff runs without parsing reports. Crawl rows are pruned to the two
 * latest runs, so whether a finding's pages vanished is decided on save.
 */

export const FINDING_KEYS = "finding_keys";
/** How many finished runs History looks back over: keeps the first open within the Free plan's query budget. */
export const HISTORY_RUNS = 12;

export type CompletedAnalysis = { id: string; completedAt: string };

/** The latest finished runs with a report, oldest first. */
export async function listCompletedAnalyses(db: D1Like, siteId: string, limit = HISTORY_RUNS): Promise<CompletedAnalysis[]> {
  const { results } = await db.prepare(
    `SELECT id, COALESCE(completed_at, created_at) AS completed_at FROM analyses
     WHERE site_id = ? AND status = 'completed' AND report_json IS NOT NULL ORDER BY created_at DESC LIMIT ?`,
  ).bind(siteId, limit).all<{ id: string; completed_at: string }>();
  return results.reverse().map((row) => ({ id: String(row.id), completedAt: String(row.completed_at) }));
}

/** Of `urls`, those live in the previous crawl (fetched, status under 400) and missing or erroring (status 400 or more) in this one. Pages the previous crawl never fetched are unknown, never vanished. */
export async function vanishedPages(db: D1Like, previousId: string, analysisId: string, urls: string[]): Promise<Set<string>> {
  if (!urls.length) return new Set();
  const list = JSON.stringify([...new Set(urls)].slice(0, 500));
  const matching = async (id: string, condition: string) => new Set((await db.prepare(
    `SELECT url FROM pages WHERE analysis_id = ? AND url IN (SELECT value FROM json_each(?)) AND ${condition}`,
  ).bind(id, list).all<{ url: string }>()).results.map((row) => String(row.url)));
  const [live, stillThere] = await Promise.all([matching(previousId, "status IS NOT NULL AND status < 400"), matching(analysisId, "(status IS NULL OR status < 400)")]);
  return new Set([...live].filter((url) => !stillThere.has(url)));
}

/** Saves a finished run's key list; runs before its crawl rows are pruned. */
export async function saveFindingKeys(db: D1Like, siteId: string, analysisId: string, day: string, report: { findings?: Finding[] }): Promise<void> {
  const previous = await db.prepare(
    `SELECT id FROM analyses WHERE site_id = ? AND id != ? AND status = 'completed' AND report_json IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
  ).bind(siteId, analysisId).first<{ id: string }>();
  const before = previous ? (await getSnapshot<KeyRow>(db, siteId, FINDING_KEYS, previous.id))?.rows ?? [] : [];
  const gone = previous ? await vanishedPages(db, previous.id, analysisId, before.flatMap((row) => row.pages)) : new Set<string>();
  await snapshotStatement(db, siteId, { kind: FINDING_KEYS, scope: analysisId, periodEnd: day, rows: runKeys(report, before, gone) }).run();
}

/**
 * The latest finished runs with their key lists, oldest first. Runs saved
 * before key lists existed get theirs from their report here (one read, one
 * batch of writes); their crawls are long pruned, so no vanished rows.
 */
export async function historyRuns(db: D1Like, siteId: string): Promise<HistoryRun[]> {
  const runs = await listCompletedAnalyses(db, siteId);
  const saved = new Map((await listSnapshots<KeyRow>(db, siteId, FINDING_KEYS)).map((entry) => [entry.scope, entry.rows]));
  const missing = runs.filter((run) => !saved.has(run.id)).map((run) => run.id);
  const reports = new Map<string, { findings?: Finding[] }>();
  if (missing.length) {
    const { results } = await db.prepare("SELECT id, report_json FROM analyses WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(missing)).all<{ id: string; report_json: string }>();
    for (const row of results) reports.set(String(row.id), JSON.parse(String(row.report_json)));
  }
  const statements: ReturnType<typeof snapshotStatement>[] = [];
  let previous: KeyRow[] = [];
  const out: HistoryRun[] = [];
  for (const run of runs) {
    const keys = saved.get(run.id) ?? runKeys(reports.get(run.id) ?? {}, previous);
    if (!saved.has(run.id)) statements.push(snapshotStatement(db, siteId, { kind: FINDING_KEYS, scope: run.id, periodEnd: run.completedAt.slice(0, 10), rows: keys }));
    out.push({ analysisId: run.id, completedAt: run.completedAt, keys });
    previous = keys;
  }
  await runStatements(db, statements);
  return out;
}
