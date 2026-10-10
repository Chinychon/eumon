import type { GitHubOps } from "./fix-github.ts";
import { getSite, listOpenFixes, transitionFix, type FixRecord } from "@organic-growth/db";
import { advanceFix, type WebhookDeps } from "./github-webhook.ts";

const STALE_MS = 7 * 86_400_000;
const POOL = 200;
const CLOSE_NOTE = "Eumon closed this draft after 7 days without checks passing.";

/** Stale drafts first (oldest first), then a random pick of the rest, so no fix is starved without a migration. */
function pick(fixes: FixRecord[], limit: number, now: number, random: () => number): FixRecord[] {
  const stale = fixes.filter((f) => now - new Date(f.updatedAt).getTime() >= STALE_MS).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const fresh = fixes.filter((f) => !stale.includes(f));
  for (let i = fresh.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [fresh[i], fresh[j]] = [fresh[j]!, fresh[i]!];
  }
  return [...stale, ...fresh].slice(0, limit);
}

/** Catches up on PR events the webhook missed and closes stale drafts. Returns how many fixes changed status. */
export async function sweepFixes(deps: WebhookDeps & { random?: () => number }, limit = 4): Promise<number> {
  let changed = 0;
  const opsBySite = new Map<string, Promise<GitHubOps>>();
  const now = deps.now().getTime();
  for (const fix of pick(await listOpenFixes(deps.db, POOL), limit, now, deps.random ?? Math.random)) {
    try {
      const site = await getSite(deps.db, fix.siteId);
      if (!site || !fix.prNumber) continue;
      if (!opsBySite.has(site.id)) opsBySite.set(site.id, deps.opsFor(site));
      const ops = await opsBySite.get(site.id)!;
      const pr = await ops.getPullRequest(fix.prNumber);
      if (pr.merged) {
        if (await transitionFix(deps.db, fix.id, ["draft", "ready", "failed", "closed"], { status: "merged" })) changed++;
      } else if (pr.state === "closed") {
        if (await transitionFix(deps.db, fix.id, ["draft", "ready"], { status: "rejected", result: "Closed without merging on GitHub." })) changed++;
      } else if (now - new Date(fix.updatedAt).getTime() > STALE_MS) {
        if (!(await transitionFix(deps.db, fix.id, ["draft"], { status: "closed", result: CLOSE_NOTE }))) continue;
        changed++;
        try {
          await ops.close(fix.prNumber);
        } catch {
          await transitionFix(deps.db, fix.id, ["closed"], { result: "Eumon closed this draft after 7 days, but GitHub wouldn't close the PR. Close the PR by hand." }).catch(() => false);
          continue;
        }
        await ops.comment(fix.prNumber, CLOSE_NOTE).catch(() => undefined);
      } else if ((await advanceFix(deps, ops, fix)) !== "waiting") changed++;
    } catch {
      // One bad repo never stops the sweep.
    }
  }
  return changed;
}
