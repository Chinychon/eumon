import { env } from "cloudflare:workers";
import { createId } from "@organic-growth/core";
import { deleteUnusedProposedDatasets, getSiteScope, saveSiteScope, upsertDataset, upsertSource } from "@organic-growth/db";
import { proposeScope } from "@organic-growth/scraper";
import { gatherSiteEvidence } from "../../../../../src/page-engine";
import { appLlm, fail, findSite, json, llmFailure, readJson } from "../../../../../src/server";

export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await findSite(siteId))) return fail("Site not found.", 404);
  return json({ scope: await getSiteScope(env.DB, siteId) });
}

/**
 * Breaks the business down into the granular things people search for and
 * proposes a dataset (with fields, page ideas, and sources) for each.
 * Proposals stay proposals until the owner approves sources and collects data.
 */
export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await findSite(siteId);
  if (!site) return fail("Site not found.", 404);
  const body = (await readJson<{ goal?: unknown }>(request)) ?? {};
  const goal = typeof body.goal === "string" ? body.goal.trim().slice(0, 600) : undefined;
  const llm = appLlm();
  if (llm instanceof Response) return llm;

  const evidence = await gatherSiteEvidence(site, goal);
  if (!evidence.pages.length) return fail("Eumon could not read the website's homepage. Check that the URL is public and loads without a login.", 422);

  let proposal;
  try {
    proposal = await proposeScope(llm, evidence);
  } catch (error) {
    return llmFailure(error);
  }
  if (!proposal.datasets.length) return fail("The model did not return a usable scope. Try again, or describe your goal in more detail.", 502);

  await deleteUnusedProposedDatasets(env.DB, siteId);
  await saveSiteScope(env.DB, siteId, { goal, businessSummary: proposal.businessSummary, conversionGoal: proposal.conversionGoal });
  const now = new Date().toISOString();
  for (const proposed of proposal.datasets) {
    const datasetId = createId("ds");
    await upsertDataset(env.DB, {
      id: datasetId, siteId, name: proposed.name, entityType: proposed.entityType, description: proposed.description,
      fields: proposed.fields, keyField: proposed.keyField, pageIdeas: proposed.pageIdeas,
      status: "proposed", createdAt: now, updatedAt: now,
    });
    for (const source of proposed.sources) {
      await upsertSource(env.DB, {
        id: createId("src"), siteId, datasetId, url: source.url, kind: source.kind, urlPattern: source.urlPattern,
        maxPages: source.kind === "page" ? 1 : source.kind === "own_site" ? 2000 : 300,
        origin: source.kind === "own_site" ? "own_site" : "ai", rationale: source.rationale,
        status: "proposed", recordCount: 0, createdAt: now,
      });
    }
  }
  return json({
    scope: { businessSummary: proposal.businessSummary, conversionGoal: proposal.conversionGoal, goal },
    routeGroups: evidence.routeGroups,
    model: llm.model,
  }, 201);
}
