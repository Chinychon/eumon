import { env } from "cloudflare:workers";
import type { PageLink, PageTemplate, SiteRecord } from "@organic-growth/core";
import { auditSitemap, defaultFetcher, parseHtmlSignals } from "@organic-growth/crawler";
import {
  getDataset,
  listAllRecords,
  listEntityPageKeys,
  listStablePaths,
  listTemplates,
  listTopQueries,
  syncTemplatePages,
} from "@organic-growth/db";
import { generatePages } from "@organic-growth/pages";
import { extractLinks, htmlToText, summarizeRoutePatterns, type SiteEvidence } from "@organic-growth/scraper";
import { prettySiteName, settingsFor } from "./server";

const MAX_EVIDENCE_PAGES = 8;
/** Generation runs in one request; this keeps memory well inside a Worker's limit. */
const MAX_RECORDS_PER_GENERATION = 20_000;

/**
 * Collects what a strategist would look at before scoping: the homepage, the
 * pages it links to, one example of each sitemap route family, and the
 * queries the site already appears for.
 */
export async function gatherSiteEvidence(site: SiteRecord, goal?: string): Promise<SiteEvidence> {
  const origin = new URL(site.baseUrl).origin;
  const { urls } = await auditSitemap(site.baseUrl, defaultFetcher, { maxUrls: 1 }).catch(() => ({ urls: [] as string[] }));
  const routeGroups = summarizeRoutePatterns(urls, 12);

  const home = await defaultFetcher(`${origin}/`).catch(() => null);
  const candidates = [
    `${origin}/`,
    ...routeGroups.slice(0, 4).map((group) => group.examples[0]!),
    // Small sites often keep their richest lists (projects, locations, catalogues) one click from home.
    ...(home ? extractLinks(home.body, home.finalUrl).filter((url) => new URL(url).pathname.split("/").filter(Boolean).length <= 2) : []),
  ];
  const unique = [...new Set(candidates.map((url) => url.replace(/\/$/, "") || url))].slice(0, MAX_EVIDENCE_PAGES);

  const pages = (await Promise.all(unique.map(async (url) => {
    try {
      const response = url.replace(/\/$/, "") === origin && home ? home : await defaultFetcher(url);
      if (response.status >= 400) return null;
      const signals = parseHtmlSignals(response.body);
      return {
        url: response.finalUrl,
        title: signals.title,
        description: signals.description,
        headings: signals.headingOutline.slice(0, 15),
        text: htmlToText(response.body, 2500),
      };
    } catch {
      return null;
    }
  }))).filter((page): page is NonNullable<typeof page> => page !== null);

  return {
    name: prettySiteName(site),
    baseUrl: site.baseUrl,
    goal,
    pages,
    routeGroups,
    topQueries: await listTopQueries(env.DB, site.id, 40),
    framework: site.fingerprint?.framework,
  };
}

/**
 * Regenerates a template's pages from the current records. Published pages
 * keep their URLs; pages whose data disappeared are retired (410), and field
 * values that name another entity link to that entity's page.
 */
export async function regenerateTemplate(site: SiteRecord, template: PageTemplate): Promise<{
  created: number; updated: number; retired: number; draft: number; thin: number; duplicate: number;
}> {
  const dataset = await getDataset(env.DB, template.datasetId);
  if (!dataset) throw new Error("The dataset for this template no longer exists.");
  const [records, settings, templates, stablePaths] = await Promise.all([
    listAllRecords(env.DB, dataset.id, MAX_RECORDS_PER_GENERATION),
    settingsFor(site),
    listTemplates(env.DB, site.id),
    listStablePaths(env.DB, template.id),
  ]);
  if (records.length >= MAX_RECORDS_PER_GENERATION) {
    throw new Error(`This dataset has more than ${MAX_RECORDS_PER_GENERATION.toLocaleString()} records. Generation is limited to ${MAX_RECORDS_PER_GENERATION.toLocaleString()} per template for now; split the dataset or archive records you don't need pages for.`);
  }
  const entityTemplateIds = templates
    .filter((entry) => entry.id !== template.id && entry.groupBy.length === 0)
    .map((entry) => entry.id);
  const entityLinks = new Map<string, PageLink>(
    (await listEntityPageKeys(env.DB, site.id, entityTemplateIds)).map((entry) => [entry.key, { path: entry.path, title: entry.title }]),
  );
  const pages = generatePages({
    siteId: site.id,
    siteName: settings.siteName,
    template,
    dataset,
    records,
    mountPath: settings.mountPath,
    entityLinks,
    stablePaths,
  });
  const result = await syncTemplatePages(env.DB, template.id, pages);
  const count = (status: string) => pages.filter((page) => page.status === status).length;
  return { ...result, draft: count("draft"), thin: count("thin"), duplicate: count("duplicate") };
}
