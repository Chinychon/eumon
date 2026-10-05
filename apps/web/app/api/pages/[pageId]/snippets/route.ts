import { env } from "cloudflare:workers";
import { getPage, getSite, listPageQueries } from "@organic-growth/db";
import { suggestSnippets } from "@organic-growth/pages";
import { appLlm, fail, json, llmFailure, settingsFor } from "../../../../../src/server";

/** Three alternative titles/descriptions grounded in the page's facts and its real search queries. */
export async function POST(_request: Request, context: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await context.params;
  const page = await getPage(env.DB, pageId);
  if (!page) return fail("Page not found.", 404);
  const site = await getSite(env.DB, page.siteId);
  if (!site) return fail("Site not found.", 404);
  const settings = await settingsFor(site);
  const pageUrl = `${new URL(settings.publicOrigin).origin}${page.path}`;
  const queries = (await listPageQueries(env.DB, site.id, 5000)).filter((row) => row.pageUrl === pageUrl);
  const llm = appLlm();
  if (llm instanceof Response) return llm;
  try {
    const options = await suggestSnippets({ llm, page, siteName: settings.siteName, queries });
    if (!options.length) return fail("The model did not return usable options; try again.", 502);
    return json({ options, queries: queries.slice(0, 10), model: llm.model });
  } catch (error) {
    return llmFailure(error);
  }
}
