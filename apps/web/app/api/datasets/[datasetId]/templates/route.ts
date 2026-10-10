import { env } from "cloudflare:workers";
import { createId, type PageIdea, type PageTemplate } from "@organic-growth/core";
import { getDataset, getSiteScope, listAllRecords, listRecords, upsertTemplate } from "@organic-growth/db";
import { defaultTemplate, proposeTemplate } from "@organic-growth/pages";
import { regenerateTemplate } from "../../../../../src/page-engine";
import { describeModelError } from "@organic-growth/ai";
import { charge } from "../../../../../src/limits";
import { appLlm, fail, json, readJson, settingsFor } from "../../../../../src/server";
import { requireOwned } from "../../../../../src/guard";

/**
 * Designs a page template for one of the dataset's page ideas (AI-written
 * copy patterns when a model is available, a data-only default otherwise)
 * and generates its pages as drafts.
 */
export async function POST(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
  const access = await requireOwned(request, "dataset", datasetId, "write");
  if (access instanceof Response) return access;
  const dataset = await getDataset(env.DB, datasetId);
  if (!dataset) return fail("Dataset not found.", 404);
  const { site } = access;
  const body = (await readJson<{ ideaIndex?: unknown; groupBy?: unknown; useAi?: unknown }>(request)) ?? {};
  const keys = new Set(dataset.fields.map((field) => field.key));
  const idea: PageIdea | undefined = typeof body.ideaIndex === "number"
    ? dataset.pageIdeas[body.ideaIndex]
    : Array.isArray(body.groupBy)
      ? { name: "", groupBy: body.groupBy.filter((key): key is string => typeof key === "string" && keys.has(key)).slice(0, 2), exampleTitle: "", exampleQueries: [], intent: "", rationale: "" }
      : dataset.pageIdeas.find((entry) => entry.groupBy.length === 0);
  if (!idea) return fail("Choose a page idea or the fields to group pages by.");

  const { records: firstRecords, total } = await listRecords(env.DB, datasetId, { limit: 200 });
  if (!total) return fail("Collect or import some records before designing pages.", 409);
  // Show the model the most complete records, so its copy reflects the best pages.
  const filled = (record: (typeof firstRecords)[number]) => Object.values(record.data).filter((value) => value != null && value !== "" && !(Array.isArray(value) && !value.length)).length;
  const records = [...firstRecords].sort((a, b) => filled(b) - filled(a)).slice(0, 5);
  const settings = await settingsFor(site);
  let draft = defaultTemplate(dataset, idea, settings.mountPath, settings.language);
  let model: string | null = null;
  let aiError: string | null = null;
  if (body.useAi !== false) {
    const llm = appLlm();
    if (llm instanceof Response) {
      aiError = "No language model is configured.";
    } else {
      const refusal = await charge(env.DB, site.workspaceId!, "aiRunsPerDay");
      if (refusal) return fail(refusal, 429);
      try {
        const scope = await getSiteScope(env.DB, site.id);
        draft = await proposeTemplate({
          llm, dataset, idea, sampleRecords: records, coverageRecords: await listAllRecords(env.DB, datasetId, 5000),
          siteName: settings.siteName, mountPath: settings.mountPath, language: settings.language,
          businessContext: scope ? `${scope.businessSummary} Conversion: ${scope.conversionGoal}` : undefined,
        });
        model = llm.model;
      } catch (error) {
        // Fall back to the data-only template; the owner can edit copy afterwards.
        aiError = describeModelError(error);
      }
    }
  }
  const now = new Date().toISOString();
  const template: PageTemplate = { ...draft, id: createId("tpl"), siteId: site.id, datasetId, status: "draft", createdAt: now, updatedAt: now };
  await upsertTemplate(env.DB, template);
  const generation = await regenerateTemplate(site, template);
  return json({ template, generation, model, aiError }, 201);
}
