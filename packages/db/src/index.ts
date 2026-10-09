import type {
  CrawlCoverage,
  CrawlFamilyStats,
  CrawlIssue,
  CrawlIssueExample,
  CrawlPageResult,
  FrameworkFingerprint,
  ProposedChange,
  SearchMetricRow,
  SiteRecord,
} from "@organic-growth/core";
import { chunks, nowIso, runStatements, type D1Like } from "./d1.js";

export * from "./d1.js";
export * from "./page-engine.js";
export * from "./assistant.js";
export * from "./metrics.js";
export * from "./coverage.js";
export * from "./snapshots.js";
import { analysisHealthPoints, upsertMetricPoints } from "./metrics.js";

export async function upsertSite(
  db: D1Like,
  site: SiteRecord,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sites (
        id, name, base_url, github_owner, github_repo, github_installation_id,
        default_branch, fingerprint_json, gsc_property, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

export async function deleteSite(db: D1Like, siteId: string): Promise<void> {
  // Child tables without ON DELETE CASCADE are cleared explicitly first.
  const tables = [
    "page_metrics_daily", "page_sessions", "page_search_metrics", "cta_variants", "page_settings", "site_scopes",
    "generated_pages", "page_templates", "data_records", "data_sources", "jobs", "datasets",
    "pages", "search_metrics", "changes", "conversion_events", "oauth_credentials", "site_competitor_domains", "site_markets", "analyses",
  ];
  await runStatements(db, [
    db.prepare("DELETE FROM page_revisions WHERE page_id IN (SELECT id FROM generated_pages WHERE site_id = ?)").bind(siteId),
    db.prepare("DELETE FROM scrape_queue WHERE job_id IN (SELECT id FROM jobs WHERE site_id = ?)").bind(siteId),
    ...tables.map((table) => db.prepare(`DELETE FROM ${table} WHERE site_id = ?`).bind(siteId)),
    db.prepare("DELETE FROM sites WHERE id = ?").bind(siteId),
  ]);
}

/** Aggregated Search Console queries from the last synced snapshot, for scoping. */
export async function listTopQueries(db: D1Like, siteId: string, limit = 50): Promise<Array<{ query: string; impressions: number; position: number }>> {
  const { results } = await db.prepare(
    `SELECT query, SUM(impressions) AS impressions, SUM(position * impressions) / MAX(SUM(impressions), 1) AS position
     FROM search_metrics WHERE site_id = ? AND analysis_id IS NULL GROUP BY query ORDER BY impressions DESC LIMIT ?`,
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
      id, site_id, analysis_id, url, status, title, is_empty_shell, result_json,
      crawl_state, crawl_error, crawled_at, created_at
    ) SELECT 'page_' || lower(hex(randomblob(16))), site_id, ?, url, status, title, is_empty_shell,
      json_set(result_json, '$.reusedFrom', ?), 'complete', NULL, crawled_at, ?
    FROM pages WHERE analysis_id = ? AND crawl_state = 'complete' AND url IN (${group.map(() => "?").join(",")})`,
  ).bind(input.analysisId, input.previousAnalysisId, createdAt, input.previousAnalysisId, ...group));
  for (const group of chunks(statements, 50)) await runStatements(db, group);
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
export function compactReport(report: unknown, maxBytes = MAX_REPORT_BYTES): string {
  let json = JSON.stringify(report);
  if (json.length <= maxBytes || !report || typeof report !== "object") return json;
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
    if (json.length <= maxBytes) return json;
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
  extra?: { summary?: string; error?: string; completedAt?: string; startedAt?: string },
): Promise<boolean> {
  return Boolean(await db
    .prepare(
      `UPDATE analyses SET status = ?, summary = COALESCE(?, summary),
       error = COALESCE(?, error), completed_at = COALESCE(?, completed_at),
       started_at = COALESCE(?, started_at)
       WHERE id = ? AND ${OPEN} RETURNING id`,
    )
    .bind(
      status,
      extra?.summary ?? null,
      extra?.error ?? null,
      extra?.completedAt ?? null,
      extra?.startedAt ?? null,
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
      `INSERT OR IGNORE INTO pages (
        id, site_id, analysis_id, url, status, is_empty_shell, result_json,
        crawl_state, created_at
      ) VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?)`,
    ).bind(
      `page_${crypto.randomUUID()}`,
      input.siteId,
      input.analysisId,
      entry.url,
      JSON.stringify({ routeFamily: entry.routeFamily }),
      entry.blocked ? "blocked" : "pending",
      createdAt,
    ));
    await runStatements(db, statements);
  }
  return urls.length;
}

export async function listPendingCrawlUrls(
  db: D1Like,
  analysisId: string,
  limit: number,
): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT url FROM pages
     WHERE analysis_id = ? AND crawl_state = 'pending'
     ORDER BY url LIMIT ?`,
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
  const statements = input.outcomes.map((outcome) => {
    if (!outcome.page) {
      return db.prepare(
        `UPDATE pages SET crawl_state = 'failed', crawl_error = ?, crawled_at = ?, result_json = json_set(result_json, '$.error', ?)
         WHERE analysis_id = ? AND url = ?`,
      ).bind(
        outcome.error ?? "The crawler could not fetch this URL.",
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
      jsonLdTypes: page.jsonLdTypes,
      invalidJsonLd: page.invalidJsonLd,
      routeFamily: page.routeFamily,
      canonicalMismatch: page.canonicalMismatch,
      googlebotBlockedStatus: page.googlebotBlockedStatus,
      botChallenge: page.botChallenge,
      metaRefresh: page.metaRefresh,
      // Whether this fetch recorded the page's links (crawls before link tracking didn't).
      linksRecorded: page.internalLinks ? true : undefined,
    };
    return db.prepare(
      `UPDATE pages SET status = ?, title = ?, is_empty_shell = ?, result_json = ?,
       crawl_state = 'complete', crawl_error = NULL, crawled_at = ?
       WHERE analysis_id = ? AND url = ?`,
    ).bind(
      page.status,
      page.title ?? null,
      page.isEmptyShell ? 1 : 0,
      JSON.stringify(result),
      crawledAt,
      input.analysisId,
      outcome.url,
    );
  });
  // A fetched page's links replace the ones it had; pages reused from an earlier crawl keep theirs.
  const site = "(SELECT site_id FROM analyses WHERE id = ?)";
  const links = input.outcomes.flatMap((outcome) => (outcome.page?.internalLinks ? [
    db.prepare(`DELETE FROM page_links WHERE site_id = ${site} AND source_url = ?`).bind(input.analysisId, outcome.url),
    db.prepare(
      `INSERT OR IGNORE INTO page_links (site_id, source_url, source_family, target_path, target_family)
       SELECT ${site}, ?, ?, json_extract(value, '$.path'), json_extract(value, '$.family') FROM json_each(?)`,
    ).bind(input.analysisId, outcome.url, outcome.page.routeFamily ?? "page", JSON.stringify(outcome.page.internalLinks)),
  ] : []));
  for (const group of chunks([...statements, ...links], 100)) await runStatements(db, group);
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
      `SELECT COALESCE(${crawlField("routeFamily")}, 'other') AS family, COUNT(*) AS pages FROM pages WHERE analysis_id = ? GROUP BY family`,
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
const PAGE_FAMILY = "COALESCE(json_extract(p.result_json, '$.routeFamily'), 'other')";
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
const DETAIL_PAGE = `COALESCE(${crawlField("routeFamily")}, '') NOT IN ('home', 'page')`;

/** SQL conditions for each crawl issue, plus the stored value worth showing beside an example URL. */
const CRAWL_ISSUES: Record<Exclude<CrawlIssue, "duplicateTitle">, { where: string; detail?: string }> = {
  robotsBlocked: { where: `crawl_state = 'blocked'` },
  noindex: { where: `${SERVED} AND ${crawlField("noindex")} = 1`, detail: crawlField("robots") },
  canonicalMismatch: { where: `${SERVED} AND ${crawlField("canonicalMismatch")} = 1`, detail: crawlField("canonical") },
  redirected: {
    where: `${SERVED} AND ((${crawlField("finalUrl")} IS NOT NULL AND ${crawlField("finalUrl")} != url) OR ${crawlField("metaRefresh")} IS NOT NULL)`,
    detail: `COALESCE(${crawlField("metaRefresh")}, ${crawlField("finalUrl")})`,
  },
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

/** Titles shared by several indexable pages (pages that canonicalize elsewhere are expected to repeat). */
const DUPLICATE_TITLES = `SELECT title, COUNT(*) AS n, substr(group_concat(url, ' '), 1, 1200) AS urls
  FROM pages
  WHERE analysis_id = ? AND ${SERVED} AND is_empty_shell = 0 AND TRIM(COALESCE(title, '')) != ''
    AND COALESCE(${crawlField("noindex")}, 0) = 0 AND COALESCE(${crawlField("canonicalMismatch")}, 0) = 0
  GROUP BY title HAVING n > 1`;

export async function getCrawlCoverage(
  db: D1Like,
  analysisId: string,
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
      SUM(CASE WHEN ${SERVED} AND (title IS NULL OR LENGTH(TRIM(title)) < 15) THEN 1 ELSE 0 END) AS missing_title_urls,
      ${issueKeys.map((key) => `SUM(CASE WHEN ${CRAWL_ISSUES[key].where} THEN 1 ELSE 0 END) AS issue_${key}`).join(",\n      ")}
     FROM pages WHERE analysis_id = ?`,
  ).bind(analysisId).first<Record<string, number | null>>();

  const issues: Partial<Record<CrawlIssue, number>> = {};
  for (const key of issueKeys) issues[key] = Number(row?.[`issue_${key}`] ?? 0);

  const issueExamples: Partial<Record<CrawlIssue, CrawlIssueExample[]>> = {};
  await Promise.all(issueKeys.filter((key) => issues[key]).map(async (key) => {
    const { where, detail } = CRAWL_ISSUES[key];
    const { results } = await db.prepare(
      `SELECT url, ${detail ?? "NULL"} AS detail FROM pages WHERE analysis_id = ? AND ${where} ORDER BY url LIMIT 8`,
    ).bind(analysisId).all<{ url: string; detail: unknown }>();
    issueExamples[key] = results.map((example) => (example.detail == null || example.detail === ""
      ? { url: example.url }
      : { url: example.url, detail: String(example.detail).slice(0, 300) }));
  }));

  const [duplicates, topDuplicates, families] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS groups, COALESCE(SUM(n), 0) AS urls FROM (${DUPLICATE_TITLES})`).bind(analysisId).first<{ groups: number; urls: number }>(),
    db.prepare(`${DUPLICATE_TITLES} ORDER BY n DESC, title LIMIT 8`).bind(analysisId).all<{ title: string; n: number; urls: string }>(),
    db.prepare(
      `SELECT COALESCE(${crawlField("routeFamily")}, 'other') AS family,
        COUNT(*) AS urls,
        SUM(CASE WHEN crawl_state = 'complete' THEN 1 ELSE 0 END) AS crawled,
        SUM(CASE WHEN crawl_state = 'complete' AND is_empty_shell = 1 THEN 1 ELSE 0 END) AS empty_shells,
        SUM(CASE WHEN crawl_state = 'failed' OR (crawl_state = 'complete' AND status >= 400 AND NOT (${CHALLENGE})) THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN ${CRAWL_ISSUES.noindex.where} THEN 1 ELSE 0 END) AS noindex,
        SUM(CASE WHEN ${CRAWL_ISSUES.missingStructuredData.where} THEN 1 ELSE 0 END) AS missing_structured_data
       FROM pages WHERE analysis_id = ?
       GROUP BY family ORDER BY urls DESC, family LIMIT 25`,
    ).bind(analysisId).all<Record<string, number | string>>(),
  ]);
  issues.duplicateTitle = Number(duplicates?.urls ?? 0);

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
    duplicateTitleGroups: topDuplicates.results.map((group) => ({
      title: group.title,
      count: Number(group.n),
      examples: String(group.urls ?? "").split(" ").filter(Boolean).slice(0, 4),
    })),
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

const FRESH = `${crawlField("reusedFrom")} IS NULL`;

/** Live crawl counts while an analysis runs: what the progress view shows every few seconds. */
export async function getCrawlProgress(db: D1Like, analysisId: string): Promise<CrawlProgress> {
  const [totals, families, recent] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN crawl_state = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN crawl_state IN ('complete', 'failed') AND ${FRESH} THEN 1 ELSE 0 END) AS crawled,
        SUM(CASE WHEN crawl_state = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN crawl_state = 'blocked' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN crawl_state = 'complete' AND NOT (${FRESH}) THEN 1 ELSE 0 END) AS reused,
        SUM(CASE WHEN ${SERVED} AND NOT (${CHALLENGE}) THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN crawl_state = 'complete' AND status >= 400 AND NOT (${CHALLENGE}) THEN 1 ELSE 0 END) AS http_errors,
        SUM(CASE WHEN crawl_state = 'complete' AND is_empty_shell = 1 THEN 1 ELSE 0 END) AS empty_shells,
        SUM(CASE WHEN ${CRAWL_ISSUES.noindex.where} THEN 1 ELSE 0 END) AS noindex,
        SUM(CASE WHEN crawl_state = 'complete' AND ${CHALLENGE} THEN 1 ELSE 0 END) AS challenges,
        MIN(CASE WHEN crawl_state IN ('complete', 'failed') AND ${FRESH} THEN crawled_at END) AS first_at,
        MAX(CASE WHEN crawl_state IN ('complete', 'failed') AND ${FRESH} THEN crawled_at END) AS last_at
       FROM pages WHERE analysis_id = ?`,
    ).bind(analysisId).first<Record<string, number | string | null>>(),
    db.prepare(
      `SELECT COALESCE(${crawlField("routeFamily")}, 'other') AS family, COUNT(*) AS total,
        SUM(CASE WHEN crawl_state != 'pending' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN crawl_state IN ('complete', 'failed') AND ${FRESH} THEN 1 ELSE 0 END) AS fetched,
        SUM(CASE WHEN crawl_state = 'blocked' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN crawl_state = 'complete' AND is_empty_shell = 1 THEN 1 ELSE 0 END) AS empty_shells,
        SUM(CASE WHEN crawl_state = 'failed' OR (crawl_state = 'complete' AND status >= 400 AND NOT (${CHALLENGE})) THEN 1 ELSE 0 END) AS errors
       FROM pages WHERE analysis_id = ? GROUP BY family ORDER BY total DESC, family LIMIT 40`,
    ).bind(analysisId).all<Record<string, number | string>>(),
    db.prepare(
      `SELECT url, status, is_empty_shell, crawl_state, crawled_at, COALESCE(${crawlField("routeFamily")}, 'other') AS family
       FROM pages WHERE analysis_id = ? AND crawl_state IN ('complete', 'failed') AND ${FRESH}
       ORDER BY crawled_at DESC, url LIMIT 8`,
    ).bind(analysisId).all<Record<string, number | string | null>>(),
  ]);
  const count = (key: string) => Number(totals?.[key] ?? 0);
  return {
    total: count("total"),
    pending: count("pending"),
    crawled: count("crawled"),
    failed: count("failed"),
    blocked: count("blocked"),
    reused: count("reused"),
    ok: count("ok"),
    httpErrors: count("http_errors"),
    emptyShells: count("empty_shells"),
    noindex: count("noindex"),
    challenges: count("challenges"),
    ...(totals?.first_at ? { firstCrawledAt: String(totals.first_at), lastCrawledAt: String(totals.last_at) } : {}),
    families: families.results.map((row) => ({
      family: String(row.family),
      total: Number(row.total ?? 0),
      done: Number(row.done ?? 0),
      fetched: Number(row.fetched ?? 0),
      blocked: Number(row.blocked ?? 0),
      emptyShells: Number(row.empty_shells ?? 0),
      errors: Number(row.errors ?? 0),
    })),
    recent: recent.results.map((row) => ({
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
    "SELECT id FROM analyses WHERE site_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 5",
  ).bind(siteId).all<{ id: string }>();
  for (const { id } of results) {
    const row = await db.prepare(
      `SELECT COUNT(*) AS n, MIN(crawled_at) AS first_at, MAX(crawled_at) AS last_at FROM pages
       WHERE analysis_id = ? AND crawl_state IN ('complete', 'failed') AND ${FRESH}`,
    ).bind(id).first<{ n: number; first_at: string | null; last_at: string | null }>();
    const minutes = row?.first_at && row.last_at ? (Date.parse(row.last_at) - Date.parse(row.first_at)) / 60_000 : 0;
    if (Number(row?.n) >= 500 && minutes >= 1) return { perMinute: Math.round(Number(row!.n) / minutes) };
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
  await db.prepare("DELETE FROM search_metrics WHERE site_id = ? AND analysis_id IS NULL")
    .bind(siteId).run();
  const createdAt = nowIso();
  for (const group of chunks(rows, 100)) {
    const statements = group.map((row) => db.prepare(
        `INSERT INTO search_metrics (
          id, site_id, analysis_id, query, page, country, device,
          impressions, clicks, ctr, position, period_start, period_end, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `sm_${crypto.randomUUID()}`,
        siteId,
        null,
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

