import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { AppEnv } from "../cloudflare.config";
import { createLlm, describeModelError, LlmError } from "@organic-growth/ai";
import {
  enqueueScrapeUrls,
  getDataset,
  listRecords,
  listSources,
  markScrapeResults,
  nextScrapeBatch,
  refreshSourceRecordCount,
  scrapeQueueCounts,
  updateJob,
  upsertDataset,
  upsertRecords,
  upsertSource,
} from "@organic-growth/db";
import { expandSource, extractRecordsFromHtml, PoliteFetcher, RobotsBlockedError, sleep } from "@organic-growth/scraper";
import { mergeDuplicateRecords } from "./dedupe";
import { runSupabasePull, type PullStep } from "./supabase-source";

export interface ScrapePayload {
  jobId: string;
  siteId: string;
  datasetId: string;
  sourceIds: string[];
}

/** Pages per step: small enough to retry cheaply, large enough to keep step counts low. */
const BATCH_SIZE = 8;
const MAX_STEPS = 900;
/** Minimum spacing between requests to a third-party host; own-site sources may go faster. */
const THIRD_PARTY_DELAY_MS = 1500;
const OWN_SITE_DELAY_MS = 300;
const MAX_CRAWL_DELAY_MS = 20_000;

export class ScrapeWorkflow extends WorkflowEntrypoint<AppEnv, ScrapePayload> {
  async run(event: WorkflowEvent<ScrapePayload>, step: WorkflowStep) {
    const { jobId, datasetId, sourceIds } = event.payload;
    const db = this.env.DB;
    try {
      const setup = await step.do("load", async () => {
        await updateJob(db, jobId, { status: "running", progress: { message: "Finding pages to collect", done: 0, total: 0 } });
        const dataset = await getDataset(db, datasetId);
        if (!dataset) throw new NonRetryableError("The dataset no longer exists.");
        if (dataset.status === "proposed") {
          await upsertDataset(db, { ...dataset, status: "active", updatedAt: new Date().toISOString() });
        }
        const sources = (await listSources(db, datasetId)).filter((source) => sourceIds.includes(source.id) && source.status === "approved");
        if (!sources.length) throw new NonRetryableError("Approve at least one source before collecting data.");
        return { dataset, sources };
      });

      // A Supabase table is read a page a step, not crawled; its error, if any, is on the source row.
      const tables = setup.sources.filter((source) => source.kind === "supabase");
      const pull: PullStep = { do: (name, fn) => step.do(name, { retries: { limit: 2, delay: "15 seconds", backoff: "exponential" } }, fn as never) as never };
      for (const source of tables) {
        try {
          await runSupabasePull({ db, encryptionKey: this.env.OAUTH_ENCRYPTION_KEY }, pull, source, setup.dataset, jobId);
        } catch {
          // Recorded on the source by the pull; the other sources still run.
        }
      }
      for (const source of setup.sources.filter((source) => source.kind !== "supabase")) {
        await step.do(`expand-${source.id}`, { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } }, async () => {
          try {
            const expanded = await expandSource(source, new PoliteFetcher());
            await enqueueScrapeUrls(db, jobId, source.id, expanded.urls);
            await upsertSource(db, {
              ...source,
              robotsAllowed: expanded.urls.length > 0 || expanded.blocked === 0,
              error: expanded.urls.length ? undefined : expanded.notes[0] ?? "No matching pages were found.",
            });
            return expanded.urls.length;
          } catch (error) {
            const message = error instanceof RobotsBlockedError
              ? "robots.txt does not allow collecting from this source."
              : error instanceof Error ? error.message : "Could not read this source.";
            await upsertSource(db, { ...source, robotsAllowed: !(error instanceof RobotsBlockedError), error: message });
            return 0;
          }
        });
      }

      const queued = await step.do("queued", async () => {
        const counts = await scrapeQueueCounts(db, jobId);
        if (!counts.total && !tables.length) throw new NonRetryableError("None of the approved sources produced pages to collect. Preview each source to check its URL pattern and robots.txt.");
        if (counts.total) await updateJob(db, jobId, { progress: { message: `Collecting from ${counts.total.toLocaleString()} pages`, done: 0, total: counts.total } });
        return counts.total;
      });

      const ownSite = new Set(setup.sources.filter((source) => source.kind === "own_site").map((source) => source.id));
      for (let batch = 0; queued && batch < MAX_STEPS; batch++) {
        const processed = await step.do(`scrape-batch-${batch}`, { retries: { limit: 2, delay: "15 seconds", backoff: "exponential" } }, async () => {
          const items = await nextScrapeBatch(db, jobId, BATCH_SIZE);
          if (!items.length) return 0;
          const llm = createLlm(this.env);
          const fetcher = new PoliteFetcher();
          const lastRequest = new Map<string, number>();
          const results: Parameters<typeof markScrapeResults>[2] = [];
          for (const item of items) {
            const host = new URL(item.url).host;
            const policy = await fetcher.policy(item.url);
            const spacing = Math.min(
              Math.max(ownSite.has(item.sourceId) ? OWN_SITE_DELAY_MS : THIRD_PARTY_DELAY_MS, (policy.crawlDelay ?? 0) * 1000),
              MAX_CRAWL_DELAY_MS,
            );
            const wait = (lastRequest.get(host) ?? 0) + spacing - Date.now();
            if (wait > 0) await sleep(wait);
            lastRequest.set(host, Date.now());
            let response;
            try {
              response = await fetcher.fetch(item.url);
            } catch (error) {
              results.push({
                url: item.url,
                state: error instanceof RobotsBlockedError ? "skipped" : "failed",
                error: error instanceof Error ? error.message : "Fetch failed.",
              });
              continue;
            }
            if (response.status >= 400) {
              results.push({ url: item.url, state: "failed", error: `HTTP ${response.status}` });
              continue;
            }
            let records;
            try {
              ({ records } = await extractRecordsFromHtml({ llm, dataset: setup.dataset, url: response.finalUrl, html: response.body }));
            } catch (error) {
              // A bad answer about one page fails that page; an unavailable
              // model (auth, rate limit, outage) fails the step so it retries.
              if (!(error instanceof LlmError)) throw error;
              results.push({ url: item.url, state: "failed", error: error.message });
              continue;
            }
            await upsertRecords(db, records.map((record) => ({
              siteId: setup.dataset.siteId,
              datasetId,
              key: record.key,
              data: record.data,
              sourceId: item.sourceId,
              sourceUrl: response.finalUrl,
            })), setup.dataset.fields);
            results.push({ url: item.url, state: "done", recordsFound: records.length });
          }
          await markScrapeResults(db, jobId, results);
          const counts = await scrapeQueueCounts(db, jobId);
          await updateJob(db, jobId, {
            progress: {
              message: `Read ${(counts.total - counts.pending).toLocaleString()} of ${counts.total.toLocaleString()} pages (${counts.records.toLocaleString()} entries found)`,
              done: counts.total - counts.pending,
              total: counts.total,
            },
          });
          return items.length;
        });
        if (processed === 0) break;
      }

      // Pages list the same entity many times, so scraped records are merged by name. A table is the authority for its
      // rows: its namesakes stay apart for the inventory to show, and the operator merges by hand.
      const mergedCount = tables.length === setup.sources.length ? 0 : await step.do("merge-duplicates", async () => {
        await updateJob(db, jobId, { progress: { message: "Merging records that name the same thing", done: 1, total: 1 } });
        try {
          const merges = await mergeDuplicateRecords(db, createLlm(this.env), setup.dataset);
          return merges.reduce((sum, merge) => sum + merge.merged.length, 0);
        } catch {
          return 0; // Collection still succeeded; duplicates can be merged later from the dashboard.
        }
      });

      await step.do("finish", async () => {
        for (const source of setup.sources) if (source.kind !== "supabase") await refreshSourceRecordCount(db, source.id);
        const counts = await scrapeQueueCounts(db, jobId);
        const { total: uniqueRecords } = await listRecords(db, datasetId, { limit: 1 });
        const failedNote = (mergedCount ? ` Merged ${mergedCount.toLocaleString()} duplicate names.` : "")
          + (counts.failed ? ` ${counts.failed.toLocaleString()} pages could not be read.` : "");
        await updateJob(db, jobId, {
          status: "completed",
          progress: {
            // Entries repeat across pages (e.g. one mall in many projects); records are merged by name.
            message: counts.total
              ? `Read ${counts.total.toLocaleString()} pages and found ${counts.records.toLocaleString()} entries; the dataset now has ${uniqueRecords.toLocaleString()} records.${failedNote}`
              : `Read ${tables.length === 1 ? "the table" : `${tables.length} tables`}; the dataset now has ${uniqueRecords.toLocaleString()} records.`,
            done: counts.total,
            total: counts.total,
          },
        });
      });
      return { jobId, status: "completed" };
    } catch (error) {
      await updateJob(db, jobId, { status: "failed", error: describeModelError(error) });
      throw error;
    }
  }
}
