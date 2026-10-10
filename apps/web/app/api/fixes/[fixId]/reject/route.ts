import { env } from "cloudflare:workers";
import { getFix, transitionFix, type D1Like, type FixStatus } from "@organic-growth/db";
import { githubOpsFor } from "../../../../../src/fix-github";
import { fixView } from "../../../../../src/fix-view";
import { requireOwned } from "../../../../../src/guard";
import { fail } from "../../../../../src/server";

export async function POST(request: Request, context: { params: Promise<{ fixId: string }> }) {
  const { fixId } = await context.params;
  const access = await requireOwned(request, "change", fixId, "write");
  if (access instanceof Response) return access;
  const db = env.DB as D1Like;
  const fix = await getFix(db, fixId);
  if (!fix) return fail("Fix not found.", 404);
  // A failed fix without a PR has nothing to reject; Eumon prepares it again on the next run.
  const from: FixStatus[] = fix.prNumber ? ["staged", "draft", "ready", "failed"] : ["staged", "draft", "ready"];
  // Compare-and-set, so a webhook that merged or closed the PR first wins and GitHub is only touched by the winner.
  if (!(await transitionFix(db, fixId, from, { status: "rejected", result: "Rejected in Eumon." }))) {
    return fail("This fix has already moved on, so it can't be rejected. Reload to see where it stands.", 409);
  }
  if (fix.prNumber) {
    // GitHub failing must not undo the rejection; the pull request can be closed there by hand.
    try {
      const ops = await githubOpsFor(env, access.site);
      await ops.comment(fix.prNumber, "Rejected in Eumon; it won't propose this fix for this route again.");
      await ops.close(fix.prNumber);
    } catch { /* ignored on purpose */ }
  }
  const rejected = await getFix(db, fixId);
  return Response.json({ fix: rejected && fixView(rejected) });
}
