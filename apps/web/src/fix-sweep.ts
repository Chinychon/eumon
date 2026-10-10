import { getSite, listOpenFixes, transitionFix } from "@organic-growth/db";
import { advanceFix, type WebhookDeps } from "./github-webhook.ts";

const STALE_MS = 7 * 86_400_000;

/** Catches up on PR events the webhook missed and closes stale drafts. Returns how many fixes changed status. */
export async function sweepFixes(deps: WebhookDeps, limit = 8): Promise<number> {
  let changed = 0;
  for (const fix of await listOpenFixes(deps.db, limit)) {
    try {
      const site = await getSite(deps.db, fix.siteId);
      if (!site || !fix.prNumber) continue;
      const ops = await deps.opsFor(site);
      const pr = await ops.getPullRequest(fix.prNumber);
      if (pr.merged) {
        if (await transitionFix(deps.db, fix.id, ["draft", "ready", "failed", "closed"], { status: "merged" })) changed++;
      } else if (pr.state === "closed") {
        if (await transitionFix(deps.db, fix.id, ["draft", "ready"], { status: "rejected", result: "Closed without merging on GitHub." })) changed++;
      } else if (deps.now().getTime() - new Date(fix.updatedAt).getTime() > STALE_MS) {
        if (!(await transitionFix(deps.db, fix.id, ["draft"], { status: "closed", result: "Eumon closed this draft after 7 days without checks passing." }))) continue;
        changed++;
        try {
          await ops.close(fix.prNumber);
          await ops.comment(fix.prNumber, "Eumon closed this draft after 7 days without checks passing.");
        } catch {
          await transitionFix(deps.db, fix.id, ["closed"], { result: "Eumon closed this draft after 7 days, but GitHub wouldn't close the PR. Close the PR by hand." }).catch(() => false);
        }
      } else if ((await advanceFix(deps, ops, fix)) !== "waiting") changed++;
    } catch {
      // One bad repo never stops the sweep.
    }
  }
  return changed;
}
