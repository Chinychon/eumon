import { env } from "cloudflare:workers";
import { importExport } from "../../../../../../src/search-console-import";
import { requireSite } from "../../../../../../src/guard";
import { fail, json, readText } from "../../../../../../src/server";

/** Largest export read: a 25,000-URL list is about 2 MB. */
const MAX_EXPORT_BYTES = 8 * 1024 * 1024;

/** One Search Console export as CSV text; `?reason=` names a URL list's reason when the file name doesn't, `?name=` is the file name. */
export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const { site } = access;
  const text = await readText(request, MAX_EXPORT_BYTES);
  if (text === null) return fail("The file is too large: send at most 8 MB.", 413);
  const query = new URL(request.url).searchParams;
  const outcome = await importExport(env.DB, site, text, { reason: query.get("reason"), fileName: query.get("name") });
  return "error" in outcome ? fail(outcome.error) : json(outcome);
}
