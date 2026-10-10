import type {
  CrawlCoverage,
  CrawlFamilyStats,
  CrawlIssue,
  CrawlIssueExample,
  CrawlPageResult,
  Finding,
  FrameworkFingerprint,
  LinkGraphIssues,
  ProposedChange,
  SearchMetricRow,
  SiteRecord,
} from "@organic-growth/core";
import { chunks, nowIso, runStatements, type D1Like } from "./d1.js";
import { AI_FRESHNESS_DAYS, DESCRIPTION_MAX, hammingBits, hashBits, LEAD_WORDS_MAX, LINK_DEPTH, NEAR_DUPLICATE_DISTANCE, THIN_WORDS, TITLE_LENGTH } from "@organic-growth/core";

export * from "./d1.js";
export * from "./page-engine.js";
export * from "./assistant.js";
export * from "./metrics.js";
export * from "./coverage.js";
export * from "./activity.js";
export * from "./snapshots.js";
export * from "./leads.js";
export * from "./server-logs.js";
export * from "./history.js";
export * from "./search-console.js";
export * from "./workspaces.js";
export * from "./ranks.js";
import { saveFindingKeys } from "./history.js";
import { analysisHealthPoints, upsertMetricPoints } from "./metrics.js";

export async function upsertSite(
  db: D1Like,
  site: SiteRecord,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sites (
        id, name, base_url, github_owner, github_repo, github_installation_id,
        default_branch, fingerprint_json, gsc_property, created_at, updated_at, workspace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        base_url=excluded.base_url,
        github_owner=excluded.github_owner,
        github_repo=excluded.github_repo,
        github_installation_id=excluded.github_installation_id,
        default_branch=excluded.default_branch,
        fingerprint_json=excluded.fingerprint_json,
        gsc_property=excluded.gsc_property,
        updated_at=excluded.updated_at`,
    )
    .bind(
      site.id,
      site.name,
      site.baseUrl,
      site.githubOwner ?? null,
      site.githubRepo ?? null,
      site.githubInstallationId ?? null,
      site.defaultBranch ?? null,
      site.fingerprint ? JSON.stringify(site.fingerprint) : null,
      site.gscProperty ?? null,
      site.createdAt,
      site.updatedAt,
      site.workspaceId ?? null,
    )
    .run();
}

export async function getSite(
  db: D1Like,
  siteId: string,
): Promise<SiteRecord | null> {
  const row = await db
    .prepare(`SELECT * FROM sites WHERE id = ?`)
    .bind(siteId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return mapSite(row);
}

export async function updateSiteGscProperty(db: D1Like, siteId: string, property: string): Promise<void> {
  await db.prepare("UPDATE sites SET gsc_property = ?, updated_at = ? WHERE id = ?")
    .bind(property, nowIso(), siteId).run();
}

export async function updateSiteFingerprint(db: D1Like, siteId: string, fingerprint: FrameworkFingerprint): Promise<void> {
  await db.prepare("UPDATE sites SET fingerprint_json = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(fingerprint), nowIso(), siteId).run();
}

/**
 * Deletes a site and everything it owns: every table cascades from `sites`.
 * The two largest (crawl results and links) are cleared first so no single
 * statement carries the whole cascade.
 */
export async function deleteSite(db: D1Like, siteId: string): Promise<void> {
  await runStatements(db, [
    db.prepare("DELETE FROM page_links WHERE site_id = ?").bind(siteId),
    db.prepare("DELETE FROM pages WHERE analysis_id IN (SELECT id FROM analyses WHERE site_id = ?)").bind(siteId),
    db.prepare("DELETE FROM sites WHERE id = ?").bind(siteId),
  ]);
}

/** Aggregated Search Console queries from the last synced snapshot, for scoping. */
export async function listTopQueries(db: D1Like, siteId: string, limit = 50): Promise<Array<{ query: string; impressions: number; position: number }>> {
  const { results } = await db.prepare(
    `SELECT query, SUM(impressions) AS impressions, SUM(position * impressions) / MAX(SUM(impressions), 1) AS position
     FROM search_metrics WHERE site_id = ? GROUP BY query ORDER BY impressions DESC LIMIT ?`,
  ).bind(siteId, limit).all<{ query: string; impressions: number; position: number }>();
  return results.map((row) => ({ query: row.query, impressions: Number(row.impressions), position: Number(row.position) }));
}

export async function listSites(db: D1Like): Promise<SiteRecord[]> {
  const { results } = await db
    .prepare(`SELECT * FROM sites ORDER BY updated_at DESC`)
    .all<Record<string, unknown>>();
  return results.map(mapSite);
}

function mapSite(row: Record<string, unknown>): SiteRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    githubOwner: row.github_owner ? String(row.github_owner) : undefined,
    githubRepo: row.github_repo ? String(row.github_repo) : undefined,
    githubInstallationId: row.github_installation_id
      ? String(row.github_installation_id)
      : undefined,
    defaultBranch: row.default_branch
      ? String(row.default_branch)
      : undefined,
    fingerprint: row.fingerprint_json
      ? (JSON.parse(String(row.fingerprint_json)) as FrameworkFingerprint)
      : undefined,
    gscProperty: row.gsc_property ? String(row.gsc_property) : undefined,
    ga4Property: row.ga4_property ? String(row.ga4_property) : undefined,
    reportShareVersion: row.report_share_version === undefined || row.report_share_version === null ? undefined : Number(row.report_share_version),
    workspaceId: row.workspace_id ? String(row.workspace_id) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function createAnalysis(
  db: D1Like,
  input: { id: string; siteId: string; status: string; createdAt: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO analyses (id, site_id, status, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.siteId,
      input.status,
      input.createdAt,
    )
    .run();
}

export async function getAnalysisJob(
  db: D1Like,
  id: string,
): Promise<{
  id: string;
  siteId: string;
  status: string;
  summary?: string;
  progress?: AnalysisProgress;
  error?: string;
  report?: unknown;
  createdAt: string;
} | null> {
  const row = await db.prepare("SELECT * FROM analyses WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: String(row.id),
    siteId: String(row.site_id),
    status: String(row.status),
    summary: row.summary ? String(row.summary) : undefined,
    progress: row.progress_json ? JSON.parse(String(row.progress_json)) : undefined,
    error: row.error ? String(row.error) : undefined,
    report: row.report_json ? JSON.parse(String(row.report_json)) : undefined,
    createdAt: String(row.created_at),
  };
}

export async function getLatestAnalysisForSite(db: D1Like, siteId: string) {
  const row = await db.prepare(
    "SELECT id FROM analyses WHERE site_id = ? ORDER BY created_at DESC LIMIT 1",
  ).bind(siteId).first<{ id: string }>();
  return row ? getAnalysisJob(db, String(row.id)) : null;
}

export type AnalysisProgress = {
  stage: string;
  message: string;
  /** Stage-specific facts, such as the competitor being read or how many crawl results were reused. */
  detail?: Record<string, string | number>;
  /** When each stage began, oldest first. */
  history?: Array<{ stage: string; at: string }>;
  /** The latest update: a running analysis that stops updating has stopped. */
  updatedAt?: string;
};

/** No progress for this long means the run is gone (a restarted dev server ends local Workflow runs). */
const STALL_MS = 45 * 60_000;

/** Whether a queued or running analysis has stopped making progress, so a new run may start. */
export const analysisStalled = (job: { status: string; createdAt: string; progress?: AnalysisProgress }, now = Date.now()) =>
  (job.status === "queued" || job.status === "running") && now - Date.parse(job.progress?.updatedAt ?? job.createdAt) > STALL_MS;

/** A run that hasn't finished. Once completed, failed, or cancelled, a run never changes again. */
const OPEN = "status IN ('queued', 'running')";

/**
 * Records the current stage, keeping when each stage began so the dashboard can time them.
 * Returns false once the run has finished (cancelled, say), so the run knows to stop.
 */
export async function updateAnalysisProgress(
  db: D1Like,
  id: string,
  stage: string,
  message: string,
  detail?: Record<string, string | number>,
): Promise<boolean> {
  const row = await db.prepare("SELECT progress_json FROM analyses WHERE id = ?").bind(id).first<{ progress_json: string | null }>();
  let history: NonNullable<AnalysisProgress["history"]> = [];
  try {
    history = (JSON.parse(row?.progress_json ?? "{}") as AnalysisProgress).history ?? [];
  } catch { /* a malformed record restarts the timeline */ }
  const at = nowIso();
  if (history.at(-1)?.stage !== stage) history = [...history, { stage, at }].slice(-12);
  const progress: AnalysisProgress = { stage, message, ...(detail ? { detail } : {}), history, updatedAt: at };
  return Boolean(await db.prepare(`UPDATE analyses SET progress_json = ? WHERE id = ? AND ${OPEN} RETURNING id`)
    .bind(JSON.stringify(progress), id).first());
}

/** The most recent finished analysis of a site other than `excludeId`: the crawl a re-run can reuse. */
export async function getPreviousCompletedAnalysis(
  db: D1Like,
  siteId: string,
  excludeId: string,
): Promise<{ id: string; completedAt: string } | null> {
  const row = await db.prepare(
    `SELECT id, COALESCE(completed_at, created_at) AS completed_at FROM analyses
     WHERE site_id = ? AND id != ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1`,
  ).bind(siteId, excludeId).first<{ id: string; completed_at: string }>();
  return row ? { id: String(row.id), completedAt: String(row.completed_at) } : null;
}

/**
 * The runs a re-run can reuse crawl results from, oldest first: the last
 * finished analysis, and any newer one that stopped part-way (cancelled or
 * failed), so pages it already fetched aren't fetched again.
 */
export async function listReusableAnalyses(
  db: D1Like,
  siteId: string,
  excludeId: string,
): Promise<Array<{ id: string; completedAt: string }>> {
  const finished = await getPreviousCompletedAnalysis(db, siteId, excludeId);
  const since = finished ? (await db.prepare("SELECT created_at FROM analyses WHERE id = ?").bind(finished.id).first<{ created_at: string }>())?.created_at ?? "" : "";
  const { results } = await db.prepare(
    `SELECT id, COALESCE(completed_at, created_at) AS completed_at FROM analyses
     WHERE site_id = ? AND id != ? AND status IN ('cancelled', 'failed') AND created_at > ? ORDER BY created_at DESC LIMIT 3`,
  ).bind(siteId, excludeId, since).all<{ id: string; completed_at: string }>();
  return [...(finished ? [finished] : []), ...results.reverse().map((row) => ({ id: String(row.id), completedAt: String(row.completed_at) }))];
}

/** Per URL, how an analysis's crawl ended and when. Paged, so a 25,000-URL crawl stays within D1's response size. */
export async function listCrawlStates(
  db: D1Like,
  analysisId: string,
): Promise<Map<string, { state: string; crawledAt: string | null }>> {
  const states = new Map<string, { state: string; crawledAt: string | null }>();
  for (let after = ""; ;) {
    const { results } = await db.prepare(
      "SELECT url, crawl_state, crawled_at FROM pages WHERE analysis_id = ? AND url > ? ORDER BY url LIMIT 5000",
    ).bind(analysisId, after).all<{ url: string; crawl_state: string; crawled_at: string | null }>();
    for (const row of results) states.set(row.url, { state: row.crawl_state, crawledAt: row.crawled_at });
    if (results.length < 5000) return states;
    after = results.at(-1)!.url;
  }
}

/**
 * Copies finished crawl results for `urls` from an earlier analysis into this
 * one, keeping their original `crawled_at` and marking them `reusedFrom`.
 */
export async function reuseCrawlResults(
  db: D1Like,
  input: { analysisId: string; previousAnalysisId: string; urls: string[] },
): Promise<void> {
  const createdAt = nowIso();
  const statements = chunks(input.urls, 90).map((group) => db.prepare(
    `INSERT OR IGNORE INTO pages (
      analysis_id, url, status, title, is_empty_shell, route_family, reused_from, result_json,
      crawl_state, crawled_at, created_at
    ) SELECT ?, url, status, title, is_empty_shell, route_family, ?, result_json, 'complete', crawled_at, ?
    FROM pages WHERE analysis_id = ? AND crawl_state = 'complete' AND json_extract(result_json, '$.locale') IS NOT NULL
      AND url IN (${group.map(() => "?").join(",")})`,
  ).bind(input.analysisId, input.previousAnalysisId, createdAt, input.previousAnalysisId, ...group));
  for (const group of chunks(statements, 50)) await runStatements(db, group);
  await recountCrawl(db, input.analysisId);
}

/**
 * Replaces the search section of the site's latest finished report, so
 * connecting Search Console shows search data without waiting for a new run.
 */
export async function setLatestReportSearch(db: D1Like, siteId: string, search: unknown): Promise<boolean> {
  return Boolean(await db.prepare(
    `UPDATE analyses SET report_json = json_set(report_json, '$.search', json(?))
     WHERE id = (SELECT id FROM analyses WHERE site_id = ? AND status = 'completed' AND report_json IS NOT NULL ORDER BY created_at DESC LIMIT 1)
     RETURNING id`,
  ).bind(JSON.stringify(search), siteId).first());
}

/** Stay well under D1's 2 MB row limit, leaving room for the other columns. */
const MAX_REPORT_BYTES = 1_500_000;

/**
 * Keeps a report under the row limit by dropping the bulkiest detail first:
 * sampled page records, then evidence beyond the top findings, then route
 * lists. The summary fields the dashboard leads with are never dropped.
 */
/** Size as D1 stores it: UTF-8 bytes, not UTF-16 characters (an accented or Chinese title is two or three bytes a character). */
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

export function compactReport(report: unknown, maxBytes = MAX_REPORT_BYTES): string {
  let json = JSON.stringify(report);
  if (byteLength(json) <= maxBytes || !report || typeof report !== "object") return json;
  const copy = JSON.parse(json) as Record<string, unknown>;
  const steps: Array<() => void> = [
    () => { copy.pages = []; },
    () => {
      if (Array.isArray(copy.findings)) copy.findings = copy.findings.map((finding, index) => (index < 10 ? finding : { ...finding, evidence: {} }));
    },
    () => {
      const repo = copy.repo as Record<string, unknown> | undefined;
      if (repo) copy.repo = { ...repo, routes: [], sensitivePaths: [] };
    },
    () => {
      if (Array.isArray(copy.findings)) copy.findings = copy.findings.map((finding) => ({ ...finding, evidence: {} }));
    },
  ];
  for (const step of steps) {
    step();
    json = JSON.stringify(copy);
    if (byteLength(json) <= maxBytes) return json;
  }
  return json;
}

export async function saveAnalysisReport(
  db: D1Like,
  id: string,
  report: unknown,
  summary: string,
): Promise<void> {
  const completedAt = new Date().toISOString();
  const site = await db.prepare(`UPDATE analyses SET report_json = ?, summary = ?, status = 'completed', completed_at = ? WHERE id = ? AND ${OPEN} RETURNING site_id`)
    .bind(compactReport(report), summary, completedAt, id).first<{ site_id: string }>();
  // Every finished analysis adds a site-health point to Results.
  const points = site ? analysisHealthPoints(report, completedAt.slice(0, 10)) : [];
  try {
    if (site) await upsertMetricPoints(db, site.site_id, points);
  } catch {
    // The report is what matters; a missing ledger (code deployed before its migration) only costs the health point.
  }
  try {
    if (site) await saveFindingKeys(db, site.site_id, id, completedAt.slice(0, 10), report as { findings?: Finding[] });
  } catch {
    // History's key list; without a snapshots table (code deployed before its migration) History fills it from the report later.
  }
  try {
    if (site) await pruneCrawlResults(db, site.site_id);
  } catch {
    // Pruning is housekeeping; the next finished analysis tries again.
  }
}

/** Finished analyses whose crawl rows are kept; older ones keep their report and counters. */
export const KEPT_CRAWLS = 2;

/**
 * Deletes the crawl rows of a site's older analyses: everything but the
 * latest finished ones (`keep`) and any run newer than the latest finished
 * one, which a re-run may still reuse. Reports and crawl counters stay, so
 * history and crawl pace are unaffected; a 25,000-page crawl is tens of MB,
 * and a D1 database on the Free plan holds 500 MB.
 */
export async function pruneCrawlResults(db: D1Like, siteId: string, keep = KEPT_CRAWLS): Promise<number> {
  const { results } = await db.prepare(
    `SELECT a.id FROM analyses a
     WHERE a.site_id = ?
       AND a.id NOT IN (SELECT id FROM analyses WHERE site_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT ?)
       AND a.created_at < (SELECT MAX(created_at) FROM analyses WHERE site_id = ? AND status = 'completed')
       AND EXISTS (SELECT 1 FROM pages p WHERE p.analysis_id = a.id)`,
  ).bind(siteId, siteId, keep, siteId).all<{ id: string }>();
  // One analysis per statement, so no single delete carries every old crawl at once.
  for (const { id } of results) await db.prepare("DELETE FROM pages WHERE analysis_id = ?").bind(id).run();
  return results.length;
}

export async function upsertOAuthCredential(
  db: D1Like,
  input: { id: string; siteId: string; provider: string; encryptedBlob: string; scopes?: string },
): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO oauth_credentials (id, site_id, provider, encrypted_blob, scopes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id, provider) DO UPDATE SET encrypted_blob = excluded.encrypted_blob,
       scopes = excluded.scopes, updated_at = excluded.updated_at`,
  ).bind(input.id, input.siteId, input.provider, input.encryptedBlob, input.scopes ?? null, now, now).run();
}

export async function getOAuthCredential(
  db: D1Like,
  siteId: string,
  provider: string,
): Promise<{ encryptedBlob: string; scopes?: string } | null> {
  const row = await db.prepare(
    "SELECT encrypted_blob, scopes FROM oauth_credentials WHERE site_id = ? AND provider = ? ORDER BY updated_at DESC LIMIT 1",
  ).bind(siteId, provider).first<{ encrypted_blob: string; scopes?: string }>();
  return row ? { encryptedBlob: row.encrypted_blob, scopes: row.scopes } : null;
}

export async function deleteOAuthCredential(db: D1Like, siteId: string, provider: string): Promise<void> {
  await db.prepare("DELETE FROM oauth_credentials WHERE site_id = ? AND provider = ?").bind(siteId, provider).run();
}

export async function setSiteCompetitorDomains(
  db: D1Like,
  siteId: string,
  domains: string[],
): Promise<void> {
  await db.prepare("DELETE FROM site_competitor_domains WHERE site_id = ?").bind(siteId).run();
  for (const domain of domains) {
    await db.prepare("INSERT INTO site_competitor_domains (site_id, domain, created_at) VALUES (?, ?, ?)")
      .bind(siteId, domain, new Date().toISOString()).run();
  }
}

export async function listSiteCompetitorDomains(db: D1Like, siteId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT domain FROM site_competitor_domains WHERE site_id = ? ORDER BY domain")
    .bind(siteId).all<{ domain: string }>();
  return results.map((row) => row.domain);
}

/** Countries the business targets (Search Console alpha-3 codes). */
export async function setSiteMarkets(db: D1Like, siteId: string, countries: string[]): Promise<void> {
  await runStatements(db, [
    db.prepare("DELETE FROM site_markets WHERE site_id = ?").bind(siteId),
    ...[...new Set(countries)].map((country) => db.prepare("INSERT INTO site_markets (site_id, country) VALUES (?, ?)").bind(siteId, country)),
  ]);
}

export async function listSiteMarkets(db: D1Like, siteId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT country FROM site_markets WHERE site_id = ? ORDER BY country").bind(siteId).all<{ country: string }>();
  return results.map((row) => row.country);
}

/**
 * Record keys (slugs of entity names) with their entity type, so search
 * analysis can recognize queries that name a specific doctor, product, or place.
 */
export async function listRecordKeys(db: D1Like, siteId: string, limit = 50_000): Promise<Array<{ key: string; entityType: string }>> {
  const { results } = await db.prepare(
    `SELECT r.record_key AS key, d.entity_type AS entity_type FROM data_records r JOIN datasets d ON d.id = r.dataset_id
     WHERE r.site_id = ? AND d.status != 'archived' LIMIT ?`,
  ).bind(siteId, limit).all<{ key: string; entity_type: string }>();
  return results.map((row) => ({ key: row.key, entityType: row.entity_type }));
}

export async function updateAnalysisStatus(
  db: D1Like,
  id: string,
  status: string,
  extra?: { summary?: string; error?: string; completedAt?: string },
): Promise<boolean> {
  return Boolean(await db
    .prepare(
      `UPDATE analyses SET status = ?, summary = COALESCE(?, summary),
       error = COALESCE(?, error), completed_at = COALESCE(?, completed_at)
       WHERE id = ? AND ${OPEN} RETURNING id`,
    )
    .bind(
      status,
      extra?.summary ?? null,
      extra?.error ?? null,
      extra?.completedAt ?? null,
      id,
    )
    .first());
}

/**
 * Queues sitemap URLs for the full crawl. URLs robots.txt blocks for Googlebot
 * are recorded as `blocked` and never fetched; Google can't crawl them either.
 */
export async function enqueueAnalysisCrawlUrls(
  db: D1Like,
  input: { analysisId: string; siteId: string; urls: Array<{ url: string; routeFamily: string; blocked?: boolean }> },
): Promise<number> {
  const seen = new Set<string>();
  const urls = input.urls.filter((entry) => !seen.has(entry.url) && seen.add(entry.url));
  const createdAt = nowIso();
  for (const group of chunks(urls, 100)) {
    const statements = group.map((entry) => db.prepare(
      `INSERT OR IGNORE INTO pages (analysis_id, url, route_family, result_json, crawl_state, created_at)
       VALUES (?, ?, ?, '{}', ?, ?)`,
    ).bind(
      input.analysisId,
      entry.url,
      entry.routeFamily,
      entry.blocked ? "blocked" : "pending",
      createdAt,
    ));
    await runStatements(db, statements);
  }
  await recountCrawl(db, input.analysisId);
  return urls.length;
}

export async function listPendingCrawlUrls(
  db: D1Like,
  analysisId: string,
  limit: number,
): Promise<string[]> {
  const { results } = await db.prepare(
    // No ORDER BY: ordered, SQLite walks the primary key past every crawled row;
    // unordered, it reads the next pending rows off the crawl-state index.
    `SELECT url FROM pages
     WHERE analysis_id = ? AND crawl_state = 'pending'
     LIMIT ?`,
  ).bind(analysisId, limit).all<{ url: string }>();
  return results.map((row) => row.url);
}

export async function saveCrawlBatch(
  db: D1Like,
  input: {
    analysisId: string;
    outcomes: Array<{ url: string; page?: CrawlPageResult; error?: string }>;
  },
): Promise<void> {
  const crawledAt = nowIso();
  const save = (outcome: { url: string; page?: CrawlPageResult; error?: string }) => {
    if (!outcome.page) {
      return db.prepare(
        `UPDATE pages SET crawl_state = 'failed', crawled_at = ?, result_json = json_set(result_json, '$.error', ?)
         WHERE analysis_id = ? AND url = ? AND crawl_state = 'pending'`,
      ).bind(
        crawledAt,
        outcome.error ?? "The crawler could not fetch this URL.",
        input.analysisId,
        outcome.url,
      );
    }
    const page = outcome.page;
    const result = {
      finalUrl: page.finalUrl,
      description: page.description,
      canonical: page.canonical,
      robots: page.robots,
      hreflang: page.hreflang,
      jsonLdCount: page.jsonLdCount,
      contentLength: page.contentLength,
      headingOutline: page.headingOutline,
      internalLinkCount: page.internalLinkCount,
      rawTextLength: page.rawTextLength,
      renderedTextLength: page.renderedTextLength,
      renderDelta: page.renderDelta,
      fetchMode: page.fetchMode,
      h1Count: page.h1Count,
      noindex: page.noindex,
      locale: page.locale,
      textHash: page.textHash,
      softNotFound: page.softNotFound,
      jsonLdTypes: page.jsonLdTypes,
      invalidJsonLd: page.invalidJsonLd,
      routeFamily: page.routeFamily,
      canonicalMismatch: page.canonicalMismatch,
      googlebotBlockedStatus: page.googlebotBlockedStatus,
      botChallenge: page.botChallenge,
      metaRefresh: page.metaRefresh,
      redirectHops: page.redirectHops,
      hsts: page.hsts,
      titleWidth: page.titleWidth,
      lang: page.lang,
      viewport: page.viewport,
      images: page.images,
      imagesNoAlt: page.imagesNoAlt,
      mixedContent: page.mixedContent,
      httpLinks: page.httpLinks,
      externalLinks: page.externalLinks,
      h1: page.h1,
      words: page.words,
      questionHeadings: page.questionHeadings,
      listsOrTables: page.listsOrTables,
      leadWords: page.leadWords,
      statistics: page.statistics,
      quotes: page.quotes,
      modified: page.modified,
      articleLike: page.articleLike,
      author: page.author,
      snippetBlocked: page.snippetBlocked,
      landmarks: page.landmarks,
      headingSkips: page.headingSkips,
      entitySchema: page.entitySchema,
      // Whether this fetch recorded the page's links (crawls before link tracking didn't).
      linksRecorded: page.internalLinks ? true : undefined,
    };
    return db.prepare(
      `UPDATE pages SET status = ?, title = ?, is_empty_shell = ?, result_json = ?,
       route_family = COALESCE(?, route_family), crawl_state = 'complete', crawled_at = ?
       WHERE analysis_id = ? AND url = ? AND crawl_state = 'pending'`,
    ).bind(
      page.status,
      page.title ?? null,
      page.isEmptyShell ? 1 : 0,
      JSON.stringify(result),
      page.routeFamily ?? null,
      crawledAt,
      input.analysisId,
      outcome.url,
    );
  };
  // Each group saves its pages with the counters beside them, in one batch: the rows' pending counts
  // come off, the rows change, their new counts go on. Only pending rows change, and only rows stamped
  // with this save's time are added, so a retried save moves nothing twice.
  const urls = input.outcomes.map((outcome) => outcome.url);
  for (const group of chunks(input.outcomes, 40)) {
    const list = group.map(() => "?").join(",");
    const groupUrls = group.map((outcome) => outcome.url);
    await runStatements(db, [
      // `+crawl_state`: keeps SQLite on the primary key for these URLs instead of scanning every pending row.
      countDelta(db, input.analysisId, -1, `+crawl_state = 'pending' AND url IN (${list})`, groupUrls),
      ...group.map(save),
      countDelta(db, input.analysisId, 1, `crawled_at = ? AND url IN (${list})`, [crawledAt, ...groupUrls]),
    ]);
  }
  // The progress view's "just fetched" list, newest first.
  await db.prepare("UPDATE analyses SET crawl_recent = ? WHERE id = ?").bind(JSON.stringify(urls.slice(-8).reverse()), input.analysisId).run();
  // A fetched page's links replace the ones it had; pages reused from an earlier crawl keep theirs.
  const site = "(SELECT site_id FROM analyses WHERE id = ?)";
  const links = input.outcomes.flatMap((outcome) => (outcome.page?.internalLinks ? [
    db.prepare(`DELETE FROM page_links WHERE site_id = ${site} AND source_url = ?`).bind(input.analysisId, outcome.url),
    db.prepare(
      `INSERT OR IGNORE INTO page_links (site_id, source_url, source_family, target_path, target_family)
       SELECT ${site}, ?, ?, json_extract(value, '$.path'), json_extract(value, '$.family') FROM json_each(?)`,
    ).bind(input.analysisId, outcome.url, outcome.page.routeFamily ?? "page", JSON.stringify(outcome.page.internalLinks)),
  ] : []));
  for (const group of chunks(links, 100)) await runStatements(db, group);
}

/** A URL's path as `page_links` stores targets: no trailing slash, `` for the homepage. */
const URL_PATH = (column: string) => `rtrim(substr(${column}, instr(substr(${column}, 9), '/') + 8), '/')`;

export type LinkGraph = {
  /** Page types of the site and Eumon's templates; `pages` sizes each node. */
  nodes: Array<{ id: string; label: string; kind: "site" | "eumon"; pages: number }>;
  /** Links between page types (links within one type are left out), counted. */
  edges: Array<{ source: string; target: string; links: number }>;
  /** Sitemap pages no other page links to, in total and per page type; null until a crawl has recorded links. */
  orphans: { count: number; examples: string[]; byFamily: Record<string, number> } | null;
  /** Served pages in the latest crawl, and how many of them had their links recorded. */
  linkCoverage: { recorded: number; pages: number } | null;
  landingPages: { published: number; linkedFromSite: number };
};

/**
 * The site's link structure from the latest finished crawl, aggregated in SQL
 * by page type so a 25,000-page site returns a few dozen rows, plus Eumon's
 * published pages grouped by template.
 */
export async function getLinkGraph(db: D1Like, siteId: string): Promise<LinkGraph> {
  const latest = await getPreviousCompletedAnalysis(db, siteId, "");
  const [families, familyEdges, coverageRow, published, templates] = await Promise.all([
    latest ? db.prepare(
      `SELECT route_family AS family, COUNT(*) AS pages FROM pages WHERE analysis_id = ? GROUP BY family`,
    ).bind(latest.id).all<{ family: string; pages: number }>() : { results: [] },
    latest ? db.prepare(
      `SELECT source_family, target_family, COUNT(*) AS links FROM page_links
       WHERE site_id = ? AND source_family != target_family AND source_url IN (SELECT url FROM pages WHERE analysis_id = ?)
       GROUP BY source_family, target_family`,
    ).bind(siteId, latest.id).all<{ source_family: string; target_family: string; links: number }>() : { results: [] },
    latest ? linkCoverage(db, siteId, latest.id) : null,
    db.prepare("SELECT path, template_id, content_json FROM generated_pages WHERE site_id = ? AND status = 'published'")
      .bind(siteId).all<{ path: string; template_id: string; content_json: string }>(),
    db.prepare("SELECT id, name FROM page_templates WHERE site_id = ?").bind(siteId).all<{ id: string; name: string }>(),
  ]);

  const nodes: LinkGraph["nodes"] = families.results.map((row) => ({ id: `f:${row.family}`, label: row.family, kind: "site", pages: Number(row.pages) }));
  const known = new Set(nodes.map((node) => node.id));
  const edges: LinkGraph["edges"] = familyEdges.results
    .map((row) => ({ source: `f:${row.source_family}`, target: `f:${row.target_family}`, links: Number(row.links) }))
    .filter((edge) => known.has(edge.source) && known.has(edge.target));

  // Eumon's pages, one node per template; links between templates come from each page's related and entity links.
  const pathOf = (path: string) => path.replace(/\/+$/, "");
  const templateOf = new Map(published.results.map((page) => [pathOf(page.path), page.template_id]));
  const names = new Map(templates.results.map((template) => [template.id, template.name]));
  const pagesPer = new Map<string, number>();
  const between = new Map<string, number>();
  for (const page of published.results) {
    pagesPer.set(page.template_id, (pagesPer.get(page.template_id) ?? 0) + 1);
    let content: { related?: Array<{ path: string }>; items?: Array<{ fields?: Array<{ href?: string }> }> } = {};
    try { content = JSON.parse(page.content_json); } catch { /* a malformed page links nowhere */ }
    const targets = [...(content.related ?? []).map((link) => link.path), ...(content.items ?? []).flatMap((item) => (item.fields ?? []).map((field) => field.href ?? ""))];
    for (const target of new Set(targets.filter(Boolean).map(pathOf))) {
      const to = templateOf.get(target);
      if (!to || to === page.template_id) continue;
      const key = `${page.template_id}\n${to}`;
      between.set(key, (between.get(key) ?? 0) + 1);
    }
  }
  for (const [id, pages] of pagesPer) nodes.push({ id: `t:${id}`, label: names.get(id) ?? "Landing pages", kind: "eumon", pages });
  for (const [key, links] of between) {
    const [from, to] = key.split("\n");
    edges.push({ source: `t:${from}`, target: `t:${to}`, links });
  }

  // Which of Eumon's pages the site itself links to, and from which page types.
  let linkedFromSite = 0;
  if (published.results.length) {
    const { results } = await db.prepare(
      `SELECT target_path, source_family, COUNT(*) AS links FROM page_links
       WHERE site_id = ? AND target_path IN (SELECT value FROM json_each(?)) GROUP BY target_path, source_family`,
    ).bind(siteId, JSON.stringify([...templateOf.keys()])).all<{ target_path: string; source_family: string; links: number }>();
    linkedFromSite = new Set(results.map((row) => row.target_path)).size;
    const fromSite = new Map<string, number>();
    for (const row of results) {
      const key = `f:${row.source_family}\nt:${templateOf.get(row.target_path)}`;
      fromSite.set(key, (fromSite.get(key) ?? 0) + Number(row.links));
    }
    for (const [key, links] of fromSite) {
      const [source, target] = key.split("\n");
      if (known.has(source!)) edges.push({ source: source!, target: target!, links });
    }
  }

  let orphans: LinkGraph["orphans"] = null;
  if (latest && linksKnown(coverageRow)) {
    const orphan = `FROM pages p WHERE p.analysis_id = ? AND p.crawl_state = 'complete' AND p.status < 400
      AND ${PAGE_FAMILY} != 'home' AND NOT EXISTS (${LINKS_IN})`;
    const [perFamily, examples] = await Promise.all([
      db.prepare(`SELECT ${PAGE_FAMILY} AS family, COUNT(*) AS n ${orphan} GROUP BY family`).bind(latest.id, siteId).all<{ family: string; n: number }>(),
      db.prepare(`SELECT p.url ${orphan} ORDER BY p.url LIMIT 5`).bind(latest.id, siteId).all<{ url: string }>(),
    ]);
    const byFamily = Object.fromEntries(perFamily.results.map((row) => [row.family, Number(row.n)]));
    orphans = { count: Object.values(byFamily).reduce((sum, n) => sum + n, 0), examples: examples.results.map((row) => row.url), byFamily };
  }
  return { nodes, edges, orphans, linkCoverage: coverageRow, landingPages: { published: published.results.length, linkedFromSite } };
}

/** A page's family, as the crawl classified it. */
const PAGE_FAMILY = "p.route_family";
/** Links into page `p` from other pages (a page linking to itself doesn't count). */
const LINKS_IN = `SELECT 1 FROM page_links l WHERE l.site_id = ? AND l.target_path = ${URL_PATH("p.url")} AND l.source_url != p.url`;

/** Served pages in a crawl, and how many of them had their links recorded. */
async function linkCoverage(db: D1Like, siteId: string, analysisId: string): Promise<{ recorded: number; pages: number }> {
  const row = await db.prepare(
    `SELECT SUM(CASE WHEN ${SERVED} THEN 1 ELSE 0 END) AS pages,
            SUM(CASE WHEN ${SERVED} AND (${crawlField("linksRecorded")} = 1
              OR EXISTS (SELECT 1 FROM page_links l WHERE l.site_id = ? AND l.source_url = pages.url)) THEN 1 ELSE 0 END) AS recorded
     FROM pages WHERE analysis_id = ?`,
  ).bind(siteId, analysisId).first<{ pages: number | null; recorded: number | null }>();
  return { recorded: Number(row?.recorded ?? 0), pages: Number(row?.pages ?? 0) };
}

/** Orphans are only meaningful once nearly every page's links are known; otherwise most pages would read as orphans. */
const linksKnown = (coverage: { recorded: number; pages: number } | null) => Boolean(coverage?.pages && coverage.recorded >= coverage.pages * 0.9);

export type LinkFamily = {
  family: string;
  /** Served pages of this type in the latest crawl. */
  pages: number;
  /** Other page types linking into this one, and this one's links out to other types, most links first. */
  from: Array<{ family: string; links: number }>;
  to: Array<{ family: string; links: number }>;
  /** Links between this type's own pages. */
  within: number;
  /** Its pages with the most links in from other pages. */
  topPages: Array<{ url: string; inbound: number }>;
  /** Its pages nothing links to; null until links are known for the whole crawl (and for the homepage). */
  orphans: { count: number; examples: string[] } | null;
};

/** One served page per template (not the homepage, not an empty shell, error or challenge), the largest templates first: the pages the AI crawler probe fetches. */
export async function probePages(db: D1Like, analysisId: string, limit: number): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT route_family AS family, MIN(COALESCE(${crawlField("finalUrl")}, url)) AS url, COUNT(*) AS n FROM pages
     WHERE analysis_id = ? AND ${SERVED} AND is_empty_shell = 0 AND NOT (${CHALLENGE}) AND route_family != 'home'
     GROUP BY route_family ORDER BY n DESC, family LIMIT ?`,
  ).bind(analysisId, limit).all<{ url: string }>();
  return results.map((row) => String(row.url));
}

/**
 * Internal-link problems in one crawl, from `page_links`: orphans (no page
 * links in), pages with one link in, links to pages that fail, and pages more
 * than LINK_DEPTH clicks from the homepage. All null until links are known for
 * nearly the whole crawl, as for the link map's orphans.
 */
export async function linkGraphIssues(db: D1Like, siteId: string, analysisId: string, options: { maxLinkRows?: number } = {}): Promise<LinkGraphIssues> {
  const none: LinkGraphIssues = { orphans: null, singleInbound: null, brokenLinks: null, depth: null };
  if (!linksKnown(await linkCoverage(db, siteId, analysisId))) return none;
  const links = Number((await db.prepare("SELECT COUNT(*) AS n FROM page_links WHERE site_id = ?").bind(siteId).first<{ n: number }>())?.n ?? 0);
  const served = `p.analysis_id = ? AND p.crawl_state = 'complete' AND p.status < 400 AND ${PAGE_FAMILY} != 'home'`;
  const listed = (where: string) => `SELECT COUNT(*) AS n, substr(group_concat(url, ' '), 1, 1200) AS urls FROM (SELECT p.url FROM pages p WHERE ${served} AND ${where} ORDER BY p.url)`;
  // Failing pages first (few), then their links in through idx_page_links_target. Pages Eumon could not read
  // (fetch failed, rate-limited, unavailable, or a bot challenge) are not counted as broken.
  const failing = `FROM pages p JOIN page_links l ON l.site_id = ? AND l.target_path = ${URL_PATH("p.url")} AND l.source_url != p.url
     WHERE p.analysis_id = ? AND p.crawl_state = 'complete' AND p.status >= 400 AND p.status NOT IN (429, 503) AND NOT (${CHALLENGE})`;
  const max = options.maxLinkRows ?? 200_000;
  const [orphans, single, broken, brokenTotals, deep] = await Promise.all([
    db.prepare(listed(`NOT EXISTS (${LINKS_IN})`)).bind(analysisId, siteId).first<{ n: number; urls: string | null }>(),
    db.prepare(listed(`(SELECT COUNT(*) FROM (${LINKS_IN})) = 1`)).bind(analysisId, siteId).first<{ n: number; urls: string | null }>(),
    db.prepare(`SELECT l.target_path AS path, COALESCE(p.status, 0) AS status, COUNT(DISTINCT l.source_url) AS sources ${failing} GROUP BY l.target_path, p.status ORDER BY sources DESC, path LIMIT 20`)
      .bind(siteId, analysisId).all<{ path: string; status: number; sources: number }>(),
    db.prepare(`SELECT COUNT(*) AS links, COUNT(DISTINCT l.source_url) AS sources ${failing}`).bind(siteId, analysisId).first<{ links: number; sources: number }>(),
    // Paths within LINK_DEPTH clicks of the homepage; a page with links in that is not among them is deep (one with none is an orphan).
    // The edges CTE is materialised, so SQLite indexes it; the recursion stops at LINK_DEPTH.
    // ponytail: one statement over the whole link table, capped at maxLinkRows; a BFS in its own step if a site ever passes the cap.
    links > max ? Promise.resolve(null) : db.prepare(
      `WITH RECURSIVE edges(s, t) AS MATERIALIZED (SELECT ${URL_PATH("source_url")}, target_path FROM page_links WHERE site_id = ?),
       reach(path, depth) AS (SELECT '', 0 UNION SELECT e.t, r.depth + 1 FROM reach r JOIN edges e ON e.s = r.path WHERE r.depth < ${LINK_DEPTH})
       ${listed(`${URL_PATH("p.url")} NOT IN (SELECT path FROM reach) AND EXISTS (${LINKS_IN})`)}`,
    ).bind(siteId, analysisId, siteId).first<{ n: number; urls: string | null }>(),
  ]);
  const examples = (urls: string | null | undefined) => (urls ?? "").split(" ").filter(Boolean).slice(0, 8);
  return {
    orphans: { count: Number(orphans?.n ?? 0), examples: examples(orphans?.urls) },
    singleInbound: { count: Number(single?.n ?? 0), examples: examples(single?.urls) },
    brokenLinks: { links: Number(brokenTotals?.links ?? 0), sources: Number(brokenTotals?.sources ?? 0), targets: broken.results.map((row) => ({ path: String(row.path), status: Number(row.status), from: Number(row.sources) })) },
    depth: deep ? { deep: Number(deep.n ?? 0), examples: examples(deep.urls) } : { deep: 0, examples: [], skipped: `The link map has more than ${max.toLocaleString("en")} rows; depth is not computed.` },
  };
}

/** One page type of the latest crawl, opened: its links in and out by type, and its pages by links in. */
export async function getLinkFamily(db: D1Like, siteId: string, family: string): Promise<LinkFamily | null> {
  const latest = await getPreviousCompletedAnalysis(db, siteId, "");
  if (!latest) return null;
  const typed = `FROM pages p WHERE p.analysis_id = ? AND p.crawl_state = 'complete' AND p.status < 400 AND ${PAGE_FAMILY} = ?`;
  const counted = `WITH c AS (SELECT p.url, (SELECT COUNT(*) FROM (${LINKS_IN})) AS inbound ${typed})`;
  const [links, top, totals, orphanRows, coverage] = await Promise.all([
    db.prepare(
      `SELECT source_family, target_family, COUNT(*) AS links FROM page_links
       WHERE site_id = ? AND (source_family = ? OR target_family = ?) AND target_path != ${URL_PATH("source_url")}
         AND source_url IN (SELECT url FROM pages WHERE analysis_id = ?)
       GROUP BY source_family, target_family`,
    ).bind(siteId, family, family, latest.id).all<{ source_family: string; target_family: string; links: number }>(),
    db.prepare(`${counted} SELECT url, inbound FROM c ORDER BY inbound DESC, url LIMIT 8`).bind(siteId, latest.id, family).all<{ url: string; inbound: number }>(),
    db.prepare(`${counted} SELECT COUNT(*) AS pages, SUM(inbound = 0) AS orphans FROM c`).bind(siteId, latest.id, family).first<{ pages: number; orphans: number | null }>(),
    db.prepare(`${counted} SELECT url FROM c WHERE inbound = 0 ORDER BY url LIMIT 8`).bind(siteId, latest.id, family).all<{ url: string }>(),
    linkCoverage(db, siteId, latest.id),
  ]);
  const families = new Set((await db.prepare(`SELECT DISTINCT ${PAGE_FAMILY} AS family FROM pages p WHERE p.analysis_id = ?`).bind(latest.id).all<{ family: string }>()).results.map((row) => row.family));
  const side = (key: "source_family" | "target_family", other: "source_family" | "target_family") => links.results
    .filter((row) => row[other] === family && row[key] !== family && families.has(row[key]))
    .map((row) => ({ family: row[key], links: Number(row.links) }))
    .sort((a, b) => b.links - a.links || a.family.localeCompare(b.family));
  return {
    family,
    pages: Number(totals?.pages ?? 0),
    from: side("source_family", "target_family"),
    to: side("target_family", "source_family"),
    within: Number(links.results.find((row) => row.source_family === family && row.target_family === family)?.links ?? 0),
    topPages: top.results.map((row) => ({ url: row.url, inbound: Number(row.inbound) })),
    orphans: linksKnown(coverage) && family !== "home"
      ? { count: Number(totals?.orphans ?? 0), examples: orphanRows.results.map((row) => row.url) }
      : null,
  };
}

const crawlField = (path: string) => `json_extract(result_json, '$.${path}')`;
/** A fetched page that served real content (not an error or a bot challenge). */
const SERVED = `crawl_state = 'complete' AND status < 400`;
const CHALLENGE = `COALESCE(${crawlField("botChallenge")}, 0) = 1`;
const DETAIL_PAGE = "route_family NOT IN ('home', 'page')";

/** SQL conditions for each crawl issue, plus the stored value worth showing beside an example URL. */
const F = crawlField;
/** A title's display width: CJK characters count twice (`titleWidth`, written when the title has any). */
const TITLE_WIDTH = `COALESCE(${crawlField("titleWidth")}, LENGTH(TRIM(title)))`;
/** No title, or one too short to say what the page is. */
const WEAK_TITLE = `(title IS NULL OR ${TITLE_WIDTH} < 15)`;
/*
 * Conditions on fields the content signals always write (viewport, words, articleLike, author, landmarks,
 * listsOrTables) guard the checks that would otherwise fire on rows from crawls before those fields existed.
 */
const CRAWL_ISSUES: Record<Exclude<CrawlIssue, "duplicateTitle" | "nearDuplicate" | "duplicateDescription">, { where: string; detail?: string }> = {
  softNotFound: { where: `${SERVED} AND ${crawlField("softNotFound")} = 1`, detail: "title" },
  robotsBlocked: { where: `crawl_state = 'blocked'` },
  noindex: { where: `${SERVED} AND ${crawlField("noindex")} = 1`, detail: crawlField("robots") },
  canonicalMismatch: { where: `${SERVED} AND ${crawlField("canonicalMismatch")} = 1`, detail: crawlField("canonical") },
  // One hop only; chains and meta refreshes are their own checks.
  redirected: {
    where: `${SERVED} AND ${crawlField("finalUrl")} IS NOT NULL AND ${crawlField("finalUrl")} != url AND COALESCE(${F("redirectHops")}, 1) < 2 AND ${F("metaRefresh")} IS NULL`,
    detail: crawlField("finalUrl"),
  },
  redirectChain: { where: `${SERVED} AND ${F("redirectHops")} >= 2`, detail: F("finalUrl") },
  metaRefresh: { where: `${SERVED} AND ${F("metaRefresh")} IS NOT NULL`, detail: F("metaRefresh") },
  mixedContent: { where: `${SERVED} AND ${F("mixedContent")} > 0`, detail: F("mixedContent") },
  httpLinks: { where: `${SERVED} AND ${F("httpLinks")} > 0`, detail: F("httpLinks") },
  titleLength: { where: `${SERVED} AND is_empty_shell = 0 AND ${F("words")} IS NOT NULL AND title IS NOT NULL AND (${TITLE_WIDTH} < ${TITLE_LENGTH.min} OR ${TITLE_WIDTH} > ${TITLE_LENGTH.max})`, detail: "title" },
  descriptionLength: { where: `${SERVED} AND LENGTH(COALESCE(${F("description")}, '')) > ${DESCRIPTION_MAX}`, detail: `LENGTH(${F("description")})` },
  h1EqualsTitle: { where: `${SERVED} AND ${F("h1")} IS NOT NULL AND LOWER(TRIM(${F("h1")})) = LOWER(TRIM(title))`, detail: "title" },
  headingSkips: { where: `${SERVED} AND ${F("headingSkips")} = 1` },
  langMissing: { where: `${SERVED} AND is_empty_shell = 0 AND ${F("viewport")} IS NOT NULL AND ${F("lang")} IS NULL` },
  viewportMissing: { where: `${SERVED} AND is_empty_shell = 0 AND ${F("viewport")} = 0` },
  imagesNoAlt: { where: `${SERVED} AND ${F("imagesNoAlt")} > 0`, detail: F("imagesNoAlt") },
  thinContent: { where: `${SERVED} AND is_empty_shell = 0 AND ${DETAIL_PAGE} AND ${F("words")} IS NOT NULL AND ${F("words")} < ${THIN_WORDS} AND COALESCE(${F("softNotFound")}, 0) = 0`, detail: F("words") },
  yearInSlug: { where: `${SERVED} AND ${F("articleLike")} = 1 AND url GLOB '*[-/]20[0-9][0-9]*'` },
  snippetBlocked: { where: `${SERVED} AND ${F("snippetBlocked")} = 1 AND COALESCE(${F("noindex")}, 0) = 0`, detail: F("robots") },
  stale: { where: `${SERVED} AND ${F("articleLike")} = 1 AND ${F("modified")} IS NOT NULL AND ${F("modified")} < date('now', '-${AI_FRESHNESS_DAYS} days')`, detail: F("modified") },
  noDate: { where: `${SERVED} AND ${F("articleLike")} = 1 AND ${F("modified")} IS NULL` },
  noAnswerStructure: { where: `${SERVED} AND is_empty_shell = 0 AND (${DETAIL_PAGE} OR ${F("articleLike")} = 1) AND ${F("words")} >= ${THIN_WORDS} AND COALESCE(${F("questionHeadings")}, 0) = 0 AND ${F("listsOrTables")} = 0 AND ${F("leadWords")} > ${LEAD_WORDS_MAX}` },
  lowEvidence: { where: `${SERVED} AND ${F("articleLike")} = 1 AND ${F("words")} >= ${THIN_WORDS} AND COALESCE(${F("statistics")}, 0) = 0 AND COALESCE(${F("quotes")}, 0) = 0 AND COALESCE(${F("externalLinks")}, 0) = 0` },
  noAuthor: { where: `${SERVED} AND ${F("articleLike")} = 1 AND ${F("author")} = 0` },
  noLandmarks: { where: `${SERVED} AND is_empty_shell = 0 AND ${F("landmarks")} = 0` },
  missingH1: { where: `${SERVED} AND is_empty_shell = 0 AND ${crawlField("h1Count")} = 0` },
  multipleH1: { where: `${SERVED} AND is_empty_shell = 0 AND ${crawlField("h1Count")} > 1`, detail: crawlField("h1Count") },
  missingDescription: {
    where: `${SERVED} AND is_empty_shell = 0 AND ${crawlField("h1Count")} IS NOT NULL AND LENGTH(COALESCE(${crawlField("description")}, '')) < 40`,
    detail: crawlField("description"),
  },
  missingStructuredData: { where: `${SERVED} AND is_empty_shell = 0 AND ${DETAIL_PAGE} AND ${crawlField("jsonLdCount")} = 0` },
  invalidStructuredData: { where: `${SERVED} AND ${crawlField("invalidJsonLd")} > 0`, detail: crawlField("invalidJsonLd") },
  botFallback: { where: `${crawlField("googlebotBlockedStatus")} IS NOT NULL`, detail: crawlField("googlebotBlockedStatus") },
  botChallenge: { where: `crawl_state = 'complete' AND ${CHALLENGE}`, detail: "status" },
};

/** Indexable pages: crawled, not noindex, not canonicalising elsewhere, not a single redirect. A redirect chain stays in, so its error counts. */
const INDEXABLE = `crawl_state = 'complete' AND COALESCE(${F("noindex")}, 0) = 0 AND COALESCE(${F("canonicalMismatch")}, 0) = 0
  AND (${F("finalUrl")} IS NULL OR ${F("finalUrl")} = url OR ${F("redirectHops")} >= 2)`;
/** Error-class page checks per pillar; mirrors PAGE_ERROR_CHECKS in packages/core/src/checks/health.ts (its test keeps them equal). */
const BASE_ERRORS = [
  "status >= 400", // http.error
  "is_empty_shell = 1", // render.empty_shell
  CHALLENGE, // access.bot_challenge
];
const SEO_ERRORS = [
  ...BASE_ERRORS,
  CRAWL_ISSUES.softNotFound.where, // content.soft_404
  CRAWL_ISSUES.mixedContent.where, // security.mixed_content
  CRAWL_ISSUES.redirectChain.where, // http.redirect_chain
  CRAWL_ISSUES.metaRefresh.where, // http.meta_refresh
  WEAK_TITLE, // title.weak
].map((condition) => `(${condition})`).join(" OR ");
const AI_ERRORS = [
  ...BASE_ERRORS,
  CRAWL_ISSUES.snippetBlocked.where, // ai.snippet_blocked
].map((condition) => `(${condition})`).join(" OR ");

/** Descriptions shared by several indexable pages. */
const DUPLICATE_DESCRIPTIONS = `SELECT ${F("description")} AS description, COUNT(*) AS n, substr(group_concat(url, ' '), 1, 1200) AS urls
  FROM pages
  WHERE analysis_id = ? AND ${SERVED} AND is_empty_shell = 0 AND LENGTH(TRIM(COALESCE(${F("description")}, ''))) >= 40
    AND COALESCE(${F("noindex")}, 0) = 0 AND COALESCE(${F("canonicalMismatch")}, 0) = 0
  GROUP BY description HAVING n > 1`;

/** Titles shared by several indexable pages (pages that canonicalize elsewhere are expected to repeat). */
const DUPLICATE_TITLES = `SELECT title, COUNT(*) AS n, substr(group_concat(url, ' '), 1, 1200) AS urls
  FROM pages
  WHERE analysis_id = ? AND ${SERVED} AND is_empty_shell = 0 AND TRIM(COALESCE(title, '')) != ''
    AND COALESCE(${crawlField("noindex")}, 0) = 0 AND COALESCE(${crawlField("canonicalMismatch")}, 0) = 0
  GROUP BY title HAVING n > 1`;

export async function getCrawlCoverage(
  db: D1Like,
  analysisId: string,
  options: { notFoundTitle?: string | null } = {},
): Promise<CrawlCoverage> {
  const issueKeys = Object.keys(CRAWL_ISSUES) as Array<keyof typeof CRAWL_ISSUES>;
  const row = await db.prepare(
    `SELECT
      COUNT(*) AS total_urls,
      SUM(CASE WHEN crawl_state = 'complete' THEN 1 ELSE 0 END) AS completed_urls,
      SUM(CASE WHEN crawl_state = 'failed' THEN 1 ELSE 0 END) AS failed_urls,
      SUM(CASE WHEN crawl_state = 'pending' THEN 1 ELSE 0 END) AS pending_urls,
      SUM(CASE WHEN crawl_state = 'complete' AND is_empty_shell = 1 THEN 1 ELSE 0 END) AS empty_shell_urls,
      SUM(CASE WHEN crawl_state = 'complete' AND status >= 400 AND NOT (${CHALLENGE}) THEN 1 ELSE 0 END) AS http_error_urls,
      SUM(CASE WHEN ${SERVED} AND ${WEAK_TITLE} THEN 1 ELSE 0 END) AS missing_title_urls,
      SUM(CASE WHEN ${INDEXABLE} THEN 1 ELSE 0 END) AS indexable,
      SUM(CASE WHEN ${INDEXABLE} AND (${SEO_ERRORS}) THEN 1 ELSE 0 END) AS unhealthy_seo,
      SUM(CASE WHEN ${INDEXABLE} AND (${AI_ERRORS}) THEN 1 ELSE 0 END) AS unhealthy_ai,
      SUM(CASE WHEN crawl_state = 'complete' AND ${F("viewport")} IS NOT NULL THEN 1 ELSE 0 END) AS checked_rows,
      ${issueKeys.map((key) => `SUM(CASE WHEN ${CRAWL_ISSUES[key].where} THEN 1 ELSE 0 END) AS issue_${key}`).join(",\n      ")}
     FROM pages WHERE analysis_id = ?`,
  ).bind(analysisId).first<Record<string, number | null>>();

  const issues: Partial<Record<CrawlIssue, number>> = {};
  for (const key of issueKeys) issues[key] = Number(row?.[`issue_${key}`] ?? 0);

  // Eight examples per issue in one statement: one query per issue would pass the Free plan's 50 queries a request,
  // and a UNION of one SELECT per issue passes D1's limit on compound SELECT terms. So each page is paired with the
  // issue keys and kept where that issue's condition holds, then numbered per issue.
  const issueExamples: Partial<Record<CrawlIssue, CrawlIssueExample[]>> = {};
  const withExamples = issueKeys.filter((key) => issues[key]);
  if (withExamples.length) {
    const when = (pick: (key: (typeof withExamples)[number]) => string) => withExamples.map((key) => `WHEN '${key}' THEN (${pick(key)})`).join(" ");
    const { results } = await db.prepare(
      `SELECT issue, url, detail FROM (
         SELECT issue_keys.value AS issue, pages.url AS url, CASE issue_keys.value ${when((key) => CRAWL_ISSUES[key].detail ?? "NULL")} END AS detail,
           ROW_NUMBER() OVER (PARTITION BY issue_keys.value ORDER BY pages.url) AS rn
         FROM pages JOIN json_each(?2) AS issue_keys
         WHERE pages.analysis_id = ?1 AND (CASE issue_keys.value ${when((key) => CRAWL_ISSUES[key].where)} ELSE 0 END))
       WHERE rn <= 8 ORDER BY issue, url`,
    ).bind(analysisId, JSON.stringify(withExamples)).all<{ issue: CrawlIssue; url: string; detail: unknown }>();
    for (const example of results) {
      (issueExamples[example.issue] ??= []).push(example.detail == null || example.detail === ""
        ? { url: example.url }
        : { url: example.url, detail: String(example.detail).slice(0, 300) });
    }
  }

  const [duplicates, topDuplicates, families, descriptions, site] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS groups, COALESCE(SUM(n), 0) AS urls FROM (${DUPLICATE_TITLES})`).bind(analysisId).first<{ groups: number; urls: number }>(),
    db.prepare(`${DUPLICATE_TITLES} ORDER BY n DESC, title LIMIT 8`).bind(analysisId).all<{ title: string; n: number; urls: string }>(),
    db.prepare(
      `SELECT route_family AS family,
        COUNT(*) AS urls,
        SUM(CASE WHEN crawl_state = 'complete' THEN 1 ELSE 0 END) AS crawled,
        SUM(CASE WHEN crawl_state = 'complete' AND is_empty_shell = 1 THEN 1 ELSE 0 END) AS empty_shells,
        SUM(CASE WHEN crawl_state = 'failed' OR (crawl_state = 'complete' AND status >= 400 AND NOT (${CHALLENGE})) THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN ${CRAWL_ISSUES.noindex.where} THEN 1 ELSE 0 END) AS noindex,
        SUM(CASE WHEN ${CRAWL_ISSUES.missingStructuredData.where} THEN 1 ELSE 0 END) AS missing_structured_data
       FROM pages WHERE analysis_id = ?
       GROUP BY family ORDER BY urls DESC, family LIMIT 25`,
    ).bind(analysisId).all<Record<string, number | string>>(),
    db.prepare(`${DUPLICATE_DESCRIPTIONS} ORDER BY n DESC, description LIMIT 20`).bind(analysisId).all<{ description: string; n: number; urls: string }>(),
    db.prepare("SELECT site_id FROM analyses WHERE id = ?").bind(analysisId).first<{ site_id: string }>(),
  ]);
  issues.duplicateTitle = Number(duplicates?.urls ?? 0);
  issues.duplicateDescription = descriptions.results.reduce((total, group) => total + Number(group.n), 0);
  const linkGraph = site ? await linkGraphIssues(db, site.site_id, analysisId) : undefined;

  // Pages carrying the title the site gives a URL that cannot exist are soft 404s whatever their words: real pages only
  // (not the homepage, not empty shells), and only when the title is not the site's template (on more than a fifth of pages).
  const PROBE_TITLE = `${SERVED} AND is_empty_shell = 0 AND route_family != 'home' AND title = ? AND COALESCE(${crawlField("softNotFound")}, 0) = 0`;
  let probeTitle: string | null = null;
  if (options.notFoundTitle) {
    const [matching, served] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS n FROM pages WHERE analysis_id = ? AND ${PROBE_TITLE}`).bind(analysisId, options.notFoundTitle).first<{ n: number }>(),
      db.prepare(`SELECT COUNT(*) AS n FROM pages WHERE analysis_id = ? AND ${SERVED}`).bind(analysisId).first<{ n: number }>(),
    ]);
    const count = Number(matching?.n ?? 0);
    if (count > 0 && count <= Math.max(1, Number(served?.n ?? 0)) * 0.2) {
      probeTitle = options.notFoundTitle;
      issues.softNotFound = (issues.softNotFound ?? 0) + count;
      const { results } = await db.prepare(`SELECT url FROM pages WHERE analysis_id = ? AND ${PROBE_TITLE} ORDER BY url LIMIT 8`).bind(analysisId, options.notFoundTitle).all<{ url: string }>();
      issueExamples.softNotFound = [...(issueExamples.softNotFound ?? []), ...results.map((row) => ({ url: String(row.url), detail: options.notFoundTitle! }))].slice(0, 8);
    }
  }

  // Near-duplicates: within the biggest duplicate-title groups, pages whose text hashes sit within a few bits of another's.
  const { results: members } = await db.prepare(
    `SELECT title, url, ${crawlField("textHash")} AS hash FROM pages
     WHERE analysis_id = ? AND ${SERVED} AND is_empty_shell = 0 AND ${crawlField("textHash")} IS NOT NULL
       AND COALESCE(${crawlField("noindex")}, 0) = 0 AND COALESCE(${crawlField("canonicalMismatch")}, 0) = 0
       AND title IN (SELECT title FROM (${DUPLICATE_TITLES}) ORDER BY n DESC LIMIT 50)
     ORDER BY title, url LIMIT 1000`,
  ).bind(analysisId, analysisId).all<{ title: string; url: string; hash: string }>();
  const nearDuplicateGroups: NonNullable<CrawlCoverage["nearDuplicateGroups"]> = [];
  const byTitle = new Map<string, Array<{ url: string; bits: [number, number] }>>();
  for (const row of members) {
    const bits = hashBits(String(row.hash));
    if (bits) byTitle.set(String(row.title), [...(byTitle.get(String(row.title)) ?? []), { url: String(row.url), bits }]);
  }
  for (const [title, group] of byTitle) {
    const marked = group.filter((row) => group.some((other) => other.url !== row.url && hammingBits(row.bits, other.bits) <= NEAR_DUPLICATE_DISTANCE)).map((row) => row.url);
    if (marked.length < 2) continue;
    // A code on the end of the address has a digit in it; a hospital or town name on the end is a different page's name.
    const stem = (url: string) => url.replace(/-(?=[a-z]*\d)[a-z0-9]{4,}\/?$/i, "");
    const suffixed = marked.every((url) => marked.some((other) => other !== url && (stem(url) === other || stem(other) === url || stem(url) === stem(other))));
    nearDuplicateGroups.push({ title, urls: marked, suffixed });
  }
  nearDuplicateGroups.sort((a, b) => b.urls.length - a.urls.length || a.title.localeCompare(b.title));
  issues.nearDuplicate = nearDuplicateGroups.reduce((total, group) => total + group.urls.length, 0);
  const nearDuplicateTruncated = members.length >= 1000 || Number(duplicates?.groups ?? 0) > 50;

  // Language versions, from the URL's locale prefix; one version is no split.
  const { results: localeRows } = await db.prepare(
    `SELECT ${crawlField("locale")} AS locale, COUNT(*) AS urls,
       SUM(CASE WHEN crawl_state = 'complete' THEN 1 ELSE 0 END) AS crawled,
       SUM(CASE WHEN crawl_state = 'complete' AND is_empty_shell = 1 THEN 1 ELSE 0 END) AS empty_shells,
       SUM(CASE WHEN crawl_state = 'failed' OR (crawl_state = 'complete' AND status >= 400 AND NOT (${CHALLENGE})) THEN 1 ELSE 0 END) AS errors,
       SUM(CASE WHEN ${CRAWL_ISSUES.noindex.where} THEN 1 ELSE 0 END) AS noindex,
       SUM(CASE WHEN ${CRAWL_ISSUES.redirected.where} THEN 1 ELSE 0 END) AS redirected,
       SUM(CASE WHEN ${CRAWL_ISSUES.missingDescription.where} THEN 1 ELSE 0 END) AS missing_description,
       SUM(CASE WHEN ${CRAWL_ISSUES.missingStructuredData.where} THEN 1 ELSE 0 END) AS missing_structured_data,
       SUM(CASE WHEN ${CRAWL_ISSUES.softNotFound.where}${probeTitle ? ` OR (${PROBE_TITLE})` : ""} THEN 1 ELSE 0 END) AS soft_not_found
     FROM pages WHERE analysis_id = ? AND ${crawlField("locale")} IS NOT NULL
     GROUP BY locale ORDER BY urls DESC, locale`,
  ).bind(...(probeTitle ? [probeTitle] : []), analysisId).all<Record<string, number | string>>();
  const locales = localeRows.length > 1 ? localeRows.map((row) => ({
    locale: String(row.locale), urls: Number(row.urls), crawled: Number(row.crawled), emptyShells: Number(row.empty_shells), errors: Number(row.errors), noindex: Number(row.noindex),
    redirected: Number(row.redirected), missingDescription: Number(row.missing_description), missingStructuredData: Number(row.missing_structured_data), softNotFound: Number(row.soft_not_found),
  })) : undefined;

  return {
    totalUrls: Number(row?.total_urls ?? 0),
    completedUrls: Number(row?.completed_urls ?? 0),
    failedUrls: Number(row?.failed_urls ?? 0),
    pendingUrls: Number(row?.pending_urls ?? 0),
    emptyShellUrls: Number(row?.empty_shell_urls ?? 0),
    httpErrorUrls: Number(row?.http_error_urls ?? 0),
    missingTitleUrls: Number(row?.missing_title_urls ?? 0),
    issues,
    issueExamples,
    health: {
      indexable: Number(row?.indexable ?? 0), unhealthySeo: Number(row?.unhealthy_seo ?? 0), unhealthyAi: Number(row?.unhealthy_ai ?? 0),
      // Nine in ten crawled rows must carry the content signals: a re-run reuses unchanged rows from before them for up to 30 days.
      checked: Number(row?.checked_rows ?? 0) > 0 && Number(row?.checked_rows ?? 0) >= Number(row?.completed_urls ?? 0) * 0.9,
    },
    duplicateDescriptionGroups: descriptions.results.map((group) => ({ description: String(group.description), count: Number(group.n), examples: String(group.urls).split(" ").slice(0, 8) })),
    ...(linkGraph ? { linkGraph } : {}),
    duplicateTitleGroups: topDuplicates.results.map((group) => ({
      title: group.title,
      count: Number(group.n),
      examples: String(group.urls ?? "").split(" ").filter(Boolean).slice(0, 4),
    })),
    nearDuplicateGroups: nearDuplicateGroups.slice(0, 8),
    ...(nearDuplicateTruncated ? { nearDuplicateTruncated: true } : {}),
    ...(locales ? { locales } : {}),
    ...(options.notFoundTitle !== undefined ? { notFoundTitle: options.notFoundTitle } : {}),
    families: families.results.map((family): CrawlFamilyStats => ({
      family: String(family.family),
      urls: Number(family.urls ?? 0),
      crawled: Number(family.crawled ?? 0),
      emptyShells: Number(family.empty_shells ?? 0),
      errors: Number(family.errors ?? 0),
      noindex: Number(family.noindex ?? 0),
      missingStructuredData: Number(family.missing_structured_data ?? 0),
    })),
  };
}

export type CrawlProgress = {
  total: number;
  pending: number;
  /** Fetched during this analysis (successfully or not), excluding reused results. */
  crawled: number;
  failed: number;
  blocked: number;
  /** Unchanged results carried over from an earlier crawl. */
  reused: number;
  ok: number;
  httpErrors: number;
  emptyShells: number;
  noindex: number;
  challenges: number;
  /** First and last fetch of this analysis, for the crawl rate. */
  firstCrawledAt?: string;
  lastCrawledAt?: string;
  /** Per page type: `done` is everything no longer pending; `fetched` is what this run fetched itself (the rest was reused or blocked). */
  families: Array<{ family: string; total: number; done: number; fetched: number; blocked: number; emptyShells: number; errors: number }>;
  recent: Array<{ url: string; status: number | null; family: string; emptyShell: boolean; failed: boolean; crawledAt: string }>;
};

const FRESH = "reused_from IS NULL";

/**
 * The crawl counters (`crawl_counts`, one row per analysis and page type),
 * each a condition on a crawl row. The progress view reads these rows
 * instead of counting a 25,000-row crawl on every poll.
 */
const COUNTS: Array<[column: string, condition: string]> = [
  ["total", "1"],
  ["pending", "crawl_state = 'pending'"],
  ["blocked", "crawl_state = 'blocked'"],
  ["fetched", `crawl_state IN ('complete', 'failed') AND ${FRESH}`],
  ["failed", "crawl_state = 'failed'"],
  ["reused", `crawl_state = 'complete' AND NOT (${FRESH})`],
  ["ok", `${SERVED} AND NOT (${CHALLENGE})`],
  ["http_errors", `crawl_state = 'complete' AND status >= 400 AND NOT (${CHALLENGE})`],
  ["empty_shells", "crawl_state = 'complete' AND is_empty_shell = 1"],
  ["noindex", CRAWL_ISSUES.noindex.where],
  ["challenges", `crawl_state = 'complete' AND ${CHALLENGE}`],
];

/**
 * Adds (`sign` 1) or takes away (-1) the counts of the crawl rows matching
 * `where`, per page type. Adding also widens the first and last fetch times.
 */
function countDelta(db: D1Like, analysisId: string, sign: 1 | -1, where: string, params: unknown[]) {
  const columns = COUNTS.map(([column]) => column);
  const fetched = COUNTS.find(([column]) => column === "fetched")![1];
  return db.prepare(
    `INSERT INTO crawl_counts (analysis_id, family, ${columns.join(", ")}, first_at, last_at)
     SELECT analysis_id, route_family, ${COUNTS.map(([, condition]) => `${sign} * SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END)`).join(", ")},
       ${sign > 0 ? `MIN(CASE WHEN ${fetched} THEN crawled_at END), MAX(CASE WHEN ${fetched} THEN crawled_at END)` : "NULL, NULL"}
     FROM pages WHERE analysis_id = ? AND ${where} GROUP BY route_family
     ON CONFLICT (analysis_id, family) DO UPDATE SET ${columns.map((column) => `${column} = ${column} + excluded.${column}`).join(", ")},
       first_at = CASE WHEN excluded.first_at IS NOT NULL AND (first_at IS NULL OR excluded.first_at < first_at) THEN excluded.first_at ELSE first_at END,
       last_at = CASE WHEN excluded.last_at IS NOT NULL AND (last_at IS NULL OR excluded.last_at > last_at) THEN excluded.last_at ELSE last_at END`,
  ).bind(analysisId, ...params);
}

/** Counts an analysis's crawl rows from scratch: after queueing, and after anything that edits rows directly. */
export async function recountCrawl(db: D1Like, analysisId: string): Promise<void> {
  await runStatements(db, [
    db.prepare("DELETE FROM crawl_counts WHERE analysis_id = ?").bind(analysisId),
    countDelta(db, analysisId, 1, "1 = 1", []),
  ]);
}

/** Live crawl counts while an analysis runs: what the progress view shows every few seconds, read from the counters. */
export async function getCrawlProgress(db: D1Like, analysisId: string): Promise<CrawlProgress> {
  const [{ results: rows }, analysis] = await Promise.all([
    db.prepare("SELECT * FROM crawl_counts WHERE analysis_id = ?").bind(analysisId).all<Record<string, number | string | null>>(),
    db.prepare("SELECT crawl_recent FROM analyses WHERE id = ?").bind(analysisId).first<{ crawl_recent: string | null }>(),
  ]);
  let recentUrls: string[] = [];
  try { recentUrls = JSON.parse(analysis?.crawl_recent ?? "[]") as string[]; } catch { /* no list yet */ }
  const { results: recent } = recentUrls.length ? await db.prepare(
    `SELECT url, status, is_empty_shell, crawl_state, crawled_at, route_family AS family
     FROM pages WHERE analysis_id = ? AND crawl_state IN ('complete', 'failed') AND ${FRESH} AND url IN (${recentUrls.map(() => "?").join(",")})
     ORDER BY crawled_at DESC, url`,
  ).bind(analysisId, ...recentUrls).all<Record<string, number | string | null>>() : { results: [] };
  const sum = (key: string) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  const times = (key: "first_at" | "last_at") => rows.map((row) => row[key]).filter((value): value is string => typeof value === "string").sort();
  const [first, last] = [times("first_at")[0], times("last_at").at(-1)];
  return {
    total: sum("total"),
    pending: sum("pending"),
    crawled: sum("fetched"),
    failed: sum("failed"),
    blocked: sum("blocked"),
    reused: sum("reused"),
    ok: sum("ok"),
    httpErrors: sum("http_errors"),
    emptyShells: sum("empty_shells"),
    noindex: sum("noindex"),
    challenges: sum("challenges"),
    ...(first && last ? { firstCrawledAt: first, lastCrawledAt: last } : {}),
    families: rows
      .map((row) => ({
        family: String(row.family),
        total: Number(row.total ?? 0),
        done: Number(row.total ?? 0) - Number(row.pending ?? 0),
        fetched: Number(row.fetched ?? 0),
        blocked: Number(row.blocked ?? 0),
        emptyShells: Number(row.empty_shells ?? 0),
        errors: Number(row.failed ?? 0) + Number(row.http_errors ?? 0),
      }))
      .filter((family) => family.total > 0)
      .sort((a, b) => b.total - a.total || a.family.localeCompare(b.family))
      .slice(0, 40),
    recent: recent.map((row) => ({
      url: String(row.url),
      status: row.status == null ? null : Number(row.status),
      family: String(row.family),
      emptyShell: Number(row.is_empty_shell ?? 0) === 1,
      failed: row.crawl_state === "failed",
      crawledAt: String(row.crawled_at),
    })),
  };
}

/**
 * How fast this site's crawls run: pages a minute from the most recent
 * finished analysis that fetched enough pages itself to measure, from its
 * first fetch to its last. Null until one exists.
 */
export async function crawlPace(db: D1Like, siteId: string): Promise<{ perMinute: number } | null> {
  const { results } = await db.prepare(
    `SELECT a.id, SUM(c.fetched) AS n, MIN(c.first_at) AS first_at, MAX(c.last_at) AS last_at
     FROM (SELECT id, created_at FROM analyses WHERE site_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 5) a
     JOIN crawl_counts c ON c.analysis_id = a.id GROUP BY a.id ORDER BY a.created_at DESC`,
  ).bind(siteId).all<{ id: string; n: number; first_at: string | null; last_at: string | null }>();
  for (const row of results) {
    const minutes = row.first_at && row.last_at ? (Date.parse(row.last_at) - Date.parse(row.first_at)) / 60_000 : 0;
    if (Number(row.n) >= 500 && minutes >= 1) return { perMinute: Math.round(Number(row.n) / minutes) };
  }
  return null;
}

/**
 * Crawl pace and time left: the average rate since this analysis's first
 * fetch. Left out until a minute and 100 pages have passed, so an early burst
 * or a slow first batch never promises a wrong finish time.
 */
export function estimateCrawl(progress: Pick<CrawlProgress, "crawled" | "pending" | "firstCrawledAt" | "lastCrawledAt">, now = Date.now()): { perMinute?: number; secondsLeft?: number } {
  if (!progress.firstCrawledAt) return {};
  // A finished crawl's pace ends at its last fetch, not now.
  const end = progress.pending === 0 && progress.lastCrawledAt ? Date.parse(progress.lastCrawledAt) : now;
  const minutes = (end - Date.parse(progress.firstCrawledAt)) / 60_000;
  if (!(minutes >= 1) || progress.crawled < 100) return {};
  const perMinute = progress.crawled / minutes;
  return { perMinute: Math.round(perMinute), secondsLeft: Math.round((progress.pending / perMinute) * 60) };
}

export async function listCrawlPageResults(
  db: D1Like,
  analysisId: string,
  limit = 100,
): Promise<CrawlPageResult[]> {
  const { results } = await db.prepare(
    `SELECT url, status, title, is_empty_shell, result_json
     FROM pages WHERE analysis_id = ? AND crawl_state = 'complete'
     ORDER BY is_empty_shell DESC, status DESC, url LIMIT ?`,
  ).bind(analysisId, limit).all<Record<string, unknown>>();
  return results.map((row) => {
    let details: Record<string, unknown> = {};
    try { details = JSON.parse(String(row.result_json)) as Record<string, unknown>; } catch { /* malformed rows remain inspectable */ }
    return {
      url: String(row.url),
      status: Number(row.status ?? 0),
      finalUrl: typeof details.finalUrl === "string" ? details.finalUrl : undefined,
      title: row.title ? String(row.title) : undefined,
      description: typeof details.description === "string" ? details.description : undefined,
      canonical: typeof details.canonical === "string" ? details.canonical : undefined,
      robots: typeof details.robots === "string" ? details.robots : undefined,
      hreflang: Array.isArray(details.hreflang) ? details.hreflang as CrawlPageResult["hreflang"] : [],
      jsonLdCount: Number(details.jsonLdCount ?? 0),
      contentLength: Number(details.contentLength ?? 0),
      isEmptyShell: Number(row.is_empty_shell ?? 0) === 1,
      headingOutline: Array.isArray(details.headingOutline) ? details.headingOutline.filter((item): item is string => typeof item === "string") : [],
      internalLinkCount: Number(details.internalLinkCount ?? 0),
      rawTextLength: Number(details.rawTextLength ?? 0),
      renderedTextLength: Number(details.renderedTextLength ?? 0),
      renderDelta: Number(details.renderDelta ?? 0),
      fetchMode: "googlebot",
      h1Count: typeof details.h1Count === "number" ? details.h1Count : undefined,
      noindex: typeof details.noindex === "boolean" ? details.noindex : undefined,
      jsonLdTypes: Array.isArray(details.jsonLdTypes) ? details.jsonLdTypes.filter((item): item is string => typeof item === "string") : undefined,
      invalidJsonLd: typeof details.invalidJsonLd === "number" ? details.invalidJsonLd : undefined,
      routeFamily: typeof details.routeFamily === "string" ? details.routeFamily : undefined,
      canonicalMismatch: typeof details.canonicalMismatch === "boolean" ? details.canonicalMismatch : undefined,
      metaRefresh: typeof details.metaRefresh === "string" ? details.metaRefresh : undefined,
    };
  });
}

export async function insertChange(
  db: D1Like,
  change: ProposedChange,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO changes (
        id, site_id, analysis_id, opportunity_id, finding_id, title, reason,
        evidence_json, files_changed_json, pages_affected_json, patch, status,
        pr_url, pr_number, author, ai_model, result, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      change.id,
      change.siteId,
      change.analysisId,
      change.opportunityId ?? null,
      change.findingId ?? null,
      change.title,
      change.reason,
      JSON.stringify(change.evidence),
      JSON.stringify(change.filesChanged),
      JSON.stringify(change.pagesAffected),
      change.patch,
      change.status,
      change.prUrl ?? null,
      change.prNumber ?? null,
      change.author,
      change.aiModel ?? null,
      change.result ?? null,
      change.createdAt,
    )
    .run();
}

export async function getChange(db: D1Like, id: string): Promise<ProposedChange | null> {
  const row = await db.prepare("SELECT * FROM changes WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: String(row.id), siteId: String(row.site_id), analysisId: String(row.analysis_id),
    opportunityId: row.opportunity_id ? String(row.opportunity_id) : undefined,
    findingId: row.finding_id ? String(row.finding_id) : undefined,
    title: String(row.title), reason: String(row.reason), evidence: JSON.parse(String(row.evidence_json)),
    filesChanged: JSON.parse(String(row.files_changed_json)), pagesAffected: JSON.parse(String(row.pages_affected_json)),
    patch: String(row.patch), status: row.status as ProposedChange["status"], prUrl: row.pr_url ? String(row.pr_url) : undefined,
    prNumber: row.pr_number != null ? Number(row.pr_number) : undefined, author: String(row.author),
    aiModel: row.ai_model ? String(row.ai_model) : undefined, createdAt: String(row.created_at), result: row.result ? String(row.result) : undefined,
  };
}

export async function updateChangeStatus(
  db: D1Like,
  id: string,
  status: string,
  extra?: { prUrl?: string; prNumber?: number; result?: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE changes SET status = ?, pr_url = COALESCE(?, pr_url),
       pr_number = COALESCE(?, pr_number), result = COALESCE(?, result)
       WHERE id = ?`,
    )
    .bind(
      status,
      extra?.prUrl ?? null,
      extra?.prNumber ?? null,
      extra?.result ?? null,
      id,
    )
    .run();
}

export async function listChanges(
  db: D1Like,
  siteId: string,
): Promise<ProposedChange[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM changes WHERE site_id = ? ORDER BY created_at DESC`,
    )
    .bind(siteId)
    .all<Record<string, unknown>>();
  return results.map((row) => ({
    id: String(row.id),
    siteId: String(row.site_id),
    analysisId: String(row.analysis_id),
    opportunityId: row.opportunity_id
      ? String(row.opportunity_id)
      : undefined,
    findingId: row.finding_id ? String(row.finding_id) : undefined,
    title: String(row.title),
    reason: String(row.reason),
    evidence: JSON.parse(String(row.evidence_json)),
    filesChanged: JSON.parse(String(row.files_changed_json)) as string[],
    pagesAffected: JSON.parse(String(row.pages_affected_json)) as string[],
    patch: String(row.patch),
    status: row.status as ProposedChange["status"],
    prUrl: row.pr_url ? String(row.pr_url) : undefined,
    prNumber: row.pr_number != null ? Number(row.pr_number) : undefined,
    author: String(row.author),
    aiModel: row.ai_model ? String(row.ai_model) : undefined,
    createdAt: String(row.created_at),
    result: row.result ? String(row.result) : undefined,
  }));
}

/** Replaces the latest synced Search Console snapshot for a site. */
export async function replaceCurrentSearchMetrics(
  db: D1Like,
  siteId: string,
  rows: SearchMetricRow[],
): Promise<void> {
  await db.prepare("DELETE FROM search_metrics WHERE site_id = ?")
    .bind(siteId).run();
  const createdAt = nowIso();
  for (const group of chunks(rows, 100)) {
    const statements = group.map((row) => db.prepare(
        `INSERT INTO search_metrics (
          id, site_id, query, page, country, device,
          impressions, clicks, ctr, position, period_start, period_end, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `sm_${crypto.randomUUID()}`,
        siteId,
        row.query,
        row.page,
        row.country,
        row.device,
        row.impressions,
        row.clicks,
        row.ctr,
        row.position,
        row.periodStart ?? null,
        row.periodEnd ?? null,
        createdAt,
      ));
    await runStatements(db, statements);
  }
}

export async function insertConversionEvent(
  db: D1Like,
  event: {
    id: string;
    siteId: string;
    event: string;
    destination?: string;
    pageUrl?: string;
    sessionId?: string;
    properties?: Record<string, unknown>;
    occurredAt: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO conversion_events (
        id, site_id, event, destination, page_url, session_id, properties_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.id,
      event.siteId,
      event.event,
      event.destination ?? null,
      event.pageUrl ?? null,
      event.sessionId ?? null,
      event.properties ? JSON.stringify(event.properties) : null,
      event.occurredAt,
    )
    .run();
}

export async function getConversionSummary(db: D1Like, siteId: string): Promise<{ totalEvents: number; leads: number; last28Days: number }> {
  const row = await db.prepare(`SELECT COUNT(*) AS total_events,
    SUM(CASE WHEN event IN ('lead_created','lead_qualified','customer_created') THEN 1 ELSE 0 END) AS leads,
    SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END) AS last_28_days
    FROM conversion_events WHERE site_id = ?`).bind(new Date(Date.now() - 28 * 86400_000).toISOString(), siteId)
    .first<{ total_events: number; leads: number | null; last_28_days: number }>();
  return { totalEvents: Number(row?.total_events ?? 0), leads: Number(row?.leads ?? 0), last28Days: Number(row?.last_28_days ?? 0) };
}



export type WorkspaceRole = "owner" | "member" | "client";

/** The site and the user's role on it: owners and members see their workspace's sites; clients only the ones granted to them. */
export async function siteForUser(db: D1Like, userId: string, siteId: string): Promise<{ site: SiteRecord; role: WorkspaceRole } | null> {
  const row = await db.prepare(
    `SELECT s.*, m.role AS member_role,
       EXISTS (SELECT 1 FROM site_access a WHERE a.user_id = m.userId AND a.site_id = s.id) AS granted
     FROM sites s JOIN member m ON m.organizationId = s.workspace_id AND m.userId = ?
     WHERE s.id = ?`,
  ).bind(userId, siteId).first<Record<string, unknown>>();
  if (!row) return null;
  const role = String(row.member_role);
  if (role === "owner" || role === "member") return { site: mapSite(row), role };
  if (role === "client" && Number(row.granted) === 1) return { site: mapSite(row), role: "client" };
  return null;
}

export async function listSitesForUser(db: D1Like, userId: string, workspaceId: string): Promise<SiteRecord[]> {
  const { results } = await db.prepare(
    `SELECT s.* FROM sites s JOIN member m ON m.organizationId = s.workspace_id AND m.userId = ?
     WHERE s.workspace_id = ?
       AND (m.role IN ('owner', 'member') OR EXISTS (SELECT 1 FROM site_access a WHERE a.user_id = m.userId AND a.site_id = s.id))
     ORDER BY s.updated_at DESC`,
  ).bind(userId, workspaceId).all<Record<string, unknown>>();
  return results.map(mapSite);
}

export async function countWorkspaceSites(db: D1Like, workspaceId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM sites WHERE workspace_id = ?").bind(workspaceId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function setSiteWorkspace(db: D1Like, siteId: string, workspaceId: string): Promise<void> {
  await db.prepare("UPDATE sites SET workspace_id = ? WHERE id = ?").bind(workspaceId, siteId).run();
}

/** The site's own log token, once rotated; null while the derived token is still the one in use. Never part of SiteRecord, so it never reaches site lists. */
export async function getSiteLogToken(db: D1Like, siteId: string): Promise<string | null> {
  const row = await db.prepare("SELECT log_token FROM sites WHERE id = ?").bind(siteId).first<{ log_token: string | null }>();
  return row?.log_token ?? null;
}

export async function setSiteLogToken(db: D1Like, siteId: string, token: string): Promise<void> {
  await db.prepare("UPDATE sites SET log_token = ? WHERE id = ?").bind(token, siteId).run();
}
export * from "./fixes.js";
