import { env } from "cloudflare:workers";
import { getPage, listPageQueries } from "@organic-growth/db";
import { suggestSnippets } from "@organic-growth/pages";
import { charge } from "../../../../../src/limits";
import { appLlm, fail, json, llmFailure, settingsFor } from "../../../../../src/server";
import { requireOwned } from "../../../../../src/guard";

/** Three alternative titles/descriptions grounded in the page's facts and its real search queries. */
export async function POST(request: Request, context: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await context.params;
  const access = await requireOwned(request, "page", pageId, "write");
  if (access instanceof Response) return access;
  const page = await getPage(env.DB, pageId);
  if (!page) return fail("Page not found.", 404);
  const { site } = access;
  const settings = await settingsFor(site);
  const pageUrl = `${new URL(settings.publicOrigin).origin}${page.path}`;
  const queries = (await listPageQueries(env.DB, site.id, 5000)).filter((row) => row.pageUrl === pageUrl);
  const llm = appLlm();
  if (llm instanceof Response) return llm;
  const refusal = await charge(env.DB, site.workspaceId!, "aiRunsPerDay");
  if (refusal) return fail(refusal, 429);
  try {
    const options = await suggestSnippets({ llm, page, siteName: settings.siteName, queries, language: settings.language });
    if (!options.length) return fail("The model did not return usable options; try again.", 502);
    return json({ options, queries: queries.slice(0, 10), model: llm.model });
  } catch (error) {
    return llmFailure(error);
  }
}
