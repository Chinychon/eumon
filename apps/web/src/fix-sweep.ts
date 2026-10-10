import type { GitHubOps } from "./fix-github.ts";
import { getSite, listOpenFixes, transitionFix, type FixRecord, type FixStatus } from "@organic-growth/db";
import { advanceFix, CLOSE_FROM, CLOSED_ON_GITHUB, MERGE_FROM, type WebhookDeps } from "./github-webhook.ts";

const STALE_MS = 7 * 86_400_000;
const POOL = 200;
const CLOSE_NOTE = "Eumon closed this draft after 7 days without checks passing.";
const STALE_FROM: FixStatus[] = ["draft", "failed"];

/** Drafts and failed PRs untouched for 7 days are closed; a ready PR waits for its reviewer however long it takes. */
const isStale = (f: FixRecord, now: number) => f.status !== "ready" && now - new Date(f.updatedAt).getTime() >= STALE_MS;

/** Stale drafts first (oldest first), then a random pick of the rest, so no fix is starved without a migration. */
function pick(fixes: FixRecord[], limit: number, now: number, random: () => number): FixRecord[] {
  const stale = fixes.filter((f) => isStale(f, now)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const fresh = fixes.filter((f) => !stale.includes(f));
  for (let i = fresh.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [fresh[i], fresh[j]] = [fresh[j]!, fresh[i]!];
  }
  return [...stale, ...fresh].slice(0, limit);
}

/** Catches up on PR events the webhook missed, advances drafts, and closes stale drafts and failed PRs. Returns how many fixes changed status. */
export async function sweepFixes(deps: WebhookDeps & { random?: () => number }, limit = 4): Promise<number> {
  let changed = 0;
  const opsBySite = new Map<string, Promise<GitHubOps>>();
  const now = deps.now().getTime();
  for (const fix of pick(await listOpenFixes(deps.db, POOL), limit, now, deps.random ?? Math.random)) {
    try {
      const site = await getSite(deps.db, fix.siteId);
      if (!site || !fix.prNumber) throw new Error("The fix can't be tracked.");
      if (!opsBySite.has(site.id)) opsBySite.set(site.id, deps.opsFor(site));
      const ops = await opsBySite.get(site.id)!;
      const pr = await ops.getPullRequest(fix.prNumber);
      if (pr.merged) {
        if (await transitionFix(deps.db, fix.id, MERGE_FROM, { status: "merged" })) changed++;
      } else if (pr.state === "closed") {
        if (await transitionFix(deps.db, fix.id, CLOSE_FROM, { status: "rejected", result: CLOSED_ON_GITHUB })) changed++;
      } else if (isStale(fix, now)) {
        if (!(await transitionFix(deps.db, fix.id, STALE_FROM, { status: "closed", result: CLOSE_NOTE }))) continue;
        changed++;
        try {
          await ops.close(fix.prNumber);
        } catch {
          await transitionFix(deps.db, fix.id, ["closed"], { result: "Eumon closed this draft after 7 days, but GitHub wouldn't close the PR. Close the PR by hand." }).catch(() => false);
          continue;
        }
        await ops.comment(fix.prNumber, CLOSE_NOTE).catch(() => undefined);
      } else if (fix.status === "draft" && (await advanceFix(deps, ops, fix)) !== "waiting") changed++;
    } catch {
      // One bad repo never stops the sweep. A stale draft we still can't reach is dropped so it can't hog a slot forever.
      if (isStale(fix, now) && await transitionFix(deps.db, fix.id, STALE_FROM, { status: "closed", result: "Eumon couldn't reach this pull request after 7 days, so it stopped tracking it. Close it on GitHub if it's still open." }).catch(() => false)) changed++;
    }
  }
  return changed;
}
