import { env } from "cloudflare:workers";
import { getDataset, getSource, upsertSource } from "@organic-growth/db";
import { expandSource, extractRecordsFromHtml, PoliteFetcher, RobotsBlockedError } from "@organic-growth/scraper";
import { charge } from "../../../../../src/limits";
import { appLlm, fail, json, llmFailure } from "../../../../../src/server";
import { requireOwned } from "../../../../../src/guard";

/**
 * Dry run for one source: how many pages match, whether robots.txt allows
 * them, and what the extractor pulls from the first page — before any
 * bulk collection is started.
 */
export async function POST(request: Request, context: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await context.params;
  const access = await requireOwned(request, "source", sourceId, "write");
  if (access instanceof Response) return access;
  const source = await getSource(env.DB, sourceId);
  if (!source) return fail("Source not found.", 404);
  const dataset = await getDataset(env.DB, source.datasetId);
  if (!dataset) return fail("Dataset not found.", 404);
  const fetcher = new PoliteFetcher();
  let expanded;
  try {
    expanded = await expandSource(source, fetcher);
  } catch (error) {
    const blocked = error instanceof RobotsBlockedError;
    const message = blocked ? "robots.txt does not allow Eumon to read this source." : error instanceof Error ? error.message : "Could not read this source.";
    await upsertSource(env.DB, { ...source, robotsAllowed: !blocked, error: message });
    return json({ matched: 0, blocked: blocked ? 1 : 0, urls: [], notes: [message], sample: null });
  }
  await upsertSource(env.DB, {
    ...source,
    robotsAllowed: expanded.urls.length > 0 || expanded.blocked === 0,
    error: expanded.urls.length ? undefined : expanded.notes[0] ?? "No matching pages were found.",
  });

  const first = expanded.urls[0];
  let sample: { url: string; summary: string; records: unknown[] } | null = null;
  let sampleError: string | undefined;
  if (first) {
    const llm = appLlm();
    // Only the sample extraction uses the model, so only it is charged; the match count and robots check stay free.
    const refusal = llm instanceof Response ? null : await charge(env.DB, access.site.workspaceId!, "aiRunsPerDay");
    if (llm instanceof Response) {
      sampleError = ((await llm.json()) as { error: string }).error;
    } else if (refusal) {
      sampleError = refusal;
    } else {
      try {
        const response = await fetcher.fetch(first);
        if (response.status >= 400) {
          sampleError = `The first page returned HTTP ${response.status}.`;
        } else {
          const extracted = await extractRecordsFromHtml({ llm, dataset, url: response.finalUrl, html: response.body, maxRecords: 20 });
          sample = { url: response.finalUrl, summary: extracted.summary, records: extracted.records.map((record) => record.data) };
        }
      } catch (error) {
        const failure = llmFailure(error);
        sampleError = ((await failure.json()) as { error: string }).error;
      }
    }
  }
  return json({ matched: expanded.matched, blocked: expanded.blocked, urls: expanded.urls.slice(0, 10), total: expanded.urls.length, notes: expanded.notes, sample, sampleError });
}
