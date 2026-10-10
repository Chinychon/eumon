import type { Finding } from "./types.js";

/*
 * History: which problems the analysis once reported are gone, and when.
 * Each finished run keeps a key list (a few KB) in the snapshot store; the
 * Dashboard's History tab diffs consecutive lists.
 */

/**
 * One finding in a run's key list. A `vanished` row is not an open finding:
 * it says the previous run's finding is gone because every page it pointed
 * at was missing or erroring in this crawl.
 */
export type KeyRow = { id: string; key: string; title: string; category: string; severity: string; pages: string[]; vanished?: true };

export type HistoryRun = { analysisId: string; completedAt: string; keys: KeyRow[] };

export type Resolution = {
  key: string; title: string; category: string; severity: string; pages: string[];
  /** Completion time of the earliest consecutive run that reported it. */
  firstSeen: string;
  /** Completion time and id of the first run that no longer reported it. */
  resolvedAt: string; resolvedBy: string;
  /** Set when a later run reported it again. */
  reopenedAt?: string;
  /** Its pages were gone in the resolving crawl: it no longer applies rather than being fixed. */
  vanished: boolean;
};

/** The same problem across runs: category and title with numbers blanked (thousands separators included, so 1,200 and 800 match), so "waits for 3 requests" and "waits for 4" are one key. */
export const findingKey = (finding: { category: string; title: string }) => `${finding.category}|${finding.title.replace(/\d[\d,.]*/g, "#").trim().toLowerCase()}`;

/** The same problem across runs: the registry check and its scope (family, query, dataset), or the legacy title key for findings saved before the registry. */
export const keyOf = (finding: Pick<Finding, "category" | "title" | "checkId" | "scopeKey">) =>
  finding.checkId ? `${finding.checkId}|${finding.scopeKey ?? ""}` : findingKey(finding);

/**
 * A finished run's key list: its findings, plus `vanished` rows for the
 * previous run's findings that it no longer reports and whose pages (one or
 * more) are all in `vanishedPages`.
 */
export function runKeys(report: { findings?: Finding[] }, previous: KeyRow[] = [], vanishedPages: ReadonlySet<string> = new Set()): KeyRow[] {
  const findings = report.findings ?? [];
  const rows: KeyRow[] = findings.map((finding) => ({
    id: finding.id, key: keyOf(finding), title: finding.title, category: finding.category, severity: finding.severity, pages: (finding.pagesAffected ?? []).slice(0, 50),
  }));
  const open = new Set(rows.map((row) => row.key));
  // Rows saved before the registry carry title keys; a current finding with the same title key is the same problem under its new key.
  const newKeyOf = new Map(findings.filter((finding) => finding.checkId).map((finding) => [findingKey(finding), keyOf(finding)]));
  for (const row of previous.map((entry) => (newKeyOf.has(entry.key) ? { ...entry, key: newKeyOf.get(entry.key)! } : entry))) {
    if (row.vanished || open.has(row.key) || !row.pages.length || !row.pages.every((url) => vanishedPages.has(url))) continue;
    rows.push({ ...row, vanished: true });
    open.add(row.key);
  }
  return rows;
}

/** Resolutions over runs oldest → newest, and how many findings the latest run still has. */
export function resolutions(runs: HistoryRun[]): { resolved: Resolution[]; open: number } {
  const resolved: Resolution[] = [];
  const openSince = new Map<string, { row: KeyRow; firstSeen: string }>();
  for (const run of runs) {
    const present = new Map<string, KeyRow>();
    const vanished = new Set<string>();
    for (const row of run.keys) {
      if (row.vanished) vanished.add(row.key);
      else if (!present.has(row.key)) present.set(row.key, row);
    }
    // A run saved with check keys after one saved with title keys: carry the open stretch over to the new key.
    for (const row of present.values()) {
      const legacy = findingKey(row);
      if (legacy !== row.key && openSince.has(legacy) && !openSince.has(row.key)) {
        openSince.set(row.key, openSince.get(legacy)!);
        openSince.delete(legacy);
      }
    }
    for (const [key, { row, firstSeen }] of openSince) {
      if (present.has(key)) continue;
      resolved.push({ key, title: row.title, category: row.category, severity: row.severity, pages: row.pages, firstSeen, resolvedAt: run.completedAt, resolvedBy: run.analysisId, reopenedAt: undefined, vanished: vanished.has(key) });
      openSince.delete(key);
    }
    for (const [key, row] of present) {
      const stretch = openSince.get(key);
      if (stretch) { stretch.row = row; continue; }
      const earlier = resolved.filter((entry) => entry.key === key && !entry.reopenedAt).at(-1);
      if (earlier) earlier.reopenedAt = run.completedAt;
      openSince.set(key, { row, firstSeen: run.completedAt });
    }
  }
  return { resolved, open: openSince.size };
}
