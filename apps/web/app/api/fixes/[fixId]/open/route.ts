import { env } from "cloudflare:workers";
import { countOpenFixes, getFix, getFixSettings, type D1Like } from "@organic-growth/db";
import { fixRepoFor } from "../../../../../src/fix-github";
import { openStagedFixes } from "../../../../../src/fix-run";
import { fetchHtml } from "../../../../../src/fix-steps";
import { fixView } from "../../../../../src/fix-view";
import { requireOwned } from "../../../../../src/guard";
import { featureRefusal } from "../../../../../src/limits";
import { fail, settingsFor } from "../../../../../src/server";

export async function POST(request: Request, context: { params: Promise<{ fixId: string }> }) {
  const { fixId } = await context.params;
  const access = await requireOwned(request, "change", fixId, "write");
  if (access instanceof Response) return access;
  const db = env.DB as D1Like;
  const fix = await getFix(db, fixId);
  if (!fix) return fail("Fix not found.", 404);
  if (fix.status !== "staged") return fail("Only a staged fix can be opened as a pull request.", 409);
  const { site } = access;
  const refusal = await featureRefusal(db, site.workspaceId!, "pullRequests");
  if (refusal) return fail(refusal, 403);
  const { budget } = await getFixSettings(db, site.id);
  if ((await countOpenFixes(db, site.id)) >= budget) return fail(`This site already has ${budget} open Eumon pull requests. Merge or close one first, or raise the budget.`, 409);
  try {
    const { repo, pr } = await fixRepoFor(env, site);
    const settings = await settingsFor(site);
    await openStagedFixes({ db, repo, llm: null, budget: { calls: 0 }, fetchPage: fetchHtml, now: () => new Date() }, pr, { siteId: site.id, origin: settings.publicOrigin || site.baseUrl, budget, onlyId: fixId, max: 1 });
    const opened = await getFix(db, fixId);
    return Response.json({ fix: opened && fixView(opened) });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Eumon couldn't open the pull request. Check that the GitHub App can write contents and pull requests.", 502);
  }
}
