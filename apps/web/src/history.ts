import { CHECKS, findingKey, resolutions } from "@organic-growth/core";
import { historyRuns, listChanges, listCtaVariants, listPageRevisions, listPublications, type D1Like } from "@organic-growth/db";

/*
 * The Dashboard's History tab: problems the analysis once reported that are
 * gone, with what fixed them, and every action taken through Eumon.
 */

export type HistoryKind = "fixed" | "resolved" | "vanished" | "change" | "edit" | "cta" | "publish";
export type HistoryRow = {
  kind: HistoryKind; at: string; title: string; detail: string;
  /** Resolutions: the finding's category (which tab explains it), when it was first reported, and whether it came back. */
  category?: string; since?: string; reopenedAt?: string;
  /** The registry check's name, for resolutions saved since findings carry one. */
  check?: string;
  /** A pull request to open, or the engine page an action belongs to. */
  href?: string; view?: "performance" | "pages";
};
export type History = { runs: number; open: number; numbers: { resolved: number; fixedWithEumon: number; noLongerApplies: number; actions: number }; rows: HistoryRow[] };

const ROWS = 200;
const DONE = new Set(["merged", "pr_opened"]);

/** Resolutions with their attribution and Eumon's actions, newest first. */
export async function assembleHistory(db: D1Like, siteId: string): Promise<History> {
  const runs = await historyRuns(db, siteId);
  const [changes, revisions, variants, publications] = await Promise.all([listChanges(db, siteId), listPageRevisions(db, siteId), listCtaVariants(db, siteId), listPublications(db, siteId)]);
  const { resolved, open } = resolutions(runs);

  // A change names a finding id; the key lists say which problem that id was. A problem that came back may have a change per stretch.
  const keyOf = new Map(runs.flatMap((run) => run.keys.map((row) => [row.id, row.key] as const)));
  const done = changes.filter((change) => DONE.has(change.status));
  const changesFor = new Map<string, typeof done>();
  for (const change of done) {
    const key = change.findingId && keyOf.get(change.findingId);
    if (key) changesFor.set(key, [...(changesFor.get(key) ?? []), change]);
  }
  const prTitle = (change: (typeof done)[number]) => `${change.prNumber ? `Pull request #${change.prNumber}` : "Change"}: ${change.title}`;

  const resolutionRows: HistoryRow[] = resolved.map((entry) => {
    // A change made before the check registry is filed under the finding's title key.
    const fixed = (changesFor.get(entry.key) ?? changesFor.get(findingKey(entry)))?.find((change) => change.createdAt >= entry.firstSeen && change.createdAt <= entry.resolvedAt);
    return {
      kind: fixed ? "fixed" : entry.vanished ? "vanished" : "resolved",
      at: entry.resolvedAt, title: entry.title,
      detail: fixed ? prTitle(fixed) : entry.vanished ? "Every page it pointed at is gone or erroring, so it no longer applies." : "The analysis stopped reporting it.",
      category: entry.category, ...(CHECKS[entry.key.split("|")[0]!] ? { check: CHECKS[entry.key.split("|")[0]!]!.name } : {}), since: entry.firstSeen, reopenedAt: entry.reopenedAt, href: fixed?.prUrl,
    };
  });
  const actions: HistoryRow[] = [
    ...done.map((change): HistoryRow => ({ kind: "change", at: change.createdAt, title: prTitle(change), detail: change.reason, href: change.prUrl })),
    ...revisions.map((revision): HistoryRow => ({
      kind: "edit", at: revision.createdAt, title: `Edited ${revision.field} of ${revision.path}`, view: "performance",
      detail: revision.windowDays
        ? `${revision.reason}. ${revision.windowDays} days after: ${revision.metricsAfter.views} views and ${revision.metricsAfter.ctaClicks} CTA clicks (${revision.metricsBefore.views} and ${revision.metricsBefore.ctaClicks} before).`
        : `${revision.reason}. Too soon to compare.`,
    })),
    ...variants.map((variant): HistoryRow => ({ kind: "cta", at: variant.createdAt, title: `Started CTA test: ${variant.label}`, detail: `“${variant.copy}” → ${variant.url}`, view: "performance" })),
    ...publications.map((entry): HistoryRow => ({ kind: "publish", at: `${entry.day}T00:00:00.000Z`, title: `Published ${entry.pages} ${entry.pages === 1 ? "page" : "pages"} from ${entry.template}`, detail: "", view: "pages" })),
  ];
  const kinds = (kind: HistoryKind) => resolutionRows.filter((row) => row.kind === kind).length;
  return {
    runs: runs.length, open,
    numbers: { resolved: resolutionRows.length, fixedWithEumon: kinds("fixed"), noLongerApplies: kinds("vanished"), actions: actions.length },
    rows: [...resolutionRows, ...actions].sort((a, b) => b.at.localeCompare(a.at)).slice(0, ROWS),
  };
}
