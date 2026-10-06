import type {
  CompetitorProfile,
  CrawlCoverage,
  CrawlFamilyStats,
  CrawlIssue,
  CrawlIssueExample,
  CrawlPageResult,
  Finding,
  FrameworkFingerprint,
  GrowthPlan,
  Opportunity,
  ProposedChange,
  SearchMetricRow,
  SiteRecord,
} from "@organic-growth/core";
import { chunks, nowIso, runStatements, type D1Like } from "./d1.js";

export * from "./d1.js";
export * from "./page-engine.js";

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
    "findings", "pages", "crawl_snapshots", "search_metrics", "competitors", "opportunities", "growth_plans",
    "changes", "conversion_events", "oauth_credentials", "site_competitor_domains", "analyses",
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
  progress?: { stage: string; message: string };
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

export async function updateAnalysisProgress(
  db: D1Like,
  id: string,
  stage: string,
  message: string,
): Promise<void> {
  await db.prepare("UPDATE analyses SET progress_json = ? WHERE id = ?")
    .bind(JSON.stringify({ stage, message }), id).run();
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
  await db.prepare("UPDATE analyses SET report_json = ?, summary = ?, status = 'completed', completed_at = ? WHERE id = ?")
    .bind(compactReport(report), summary, new Date().toISOString(), id).run();
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

export async function updateAnalysisStatus(
  db: D1Like,
  id: string,
  status: string,
  extra?: { summary?: string; error?: string; completedAt?: string; startedAt?: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE analyses SET status = ?, summary = COALESCE(?, summary),
       error = COALESCE(?, error), completed_at = COALESCE(?, completed_at),
       started_at = COALESCE(?, started_at)
       WHERE id = ?`,
    )
    .bind(
      status,
      extra?.summary ?? null,
      extra?.error ?? null,
      extra?.completedAt ?? null,
      extra?.startedAt ?? null,
      id,
    )
    .run();
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
  for (const group of chunks(statements, 100)) await runStatements(db, group);
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

export async function insertFinding(db: D1Like, finding: Finding): Promise<void> {
  await db
    .prepare(
      `INSERT INTO findings (
        id, site_id, analysis_id, category, severity, title, summary,
        evidence_json, organic_impact_score, recommendation, pages_affected_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      finding.id,
      finding.siteId,
      finding.analysisId,
      finding.category,
      finding.severity,
      finding.title,
      finding.summary,
      JSON.stringify(finding.evidence),
      finding.organicImpactScore,
      finding.recommendation ?? null,
      JSON.stringify(finding.pagesAffected ?? []),
      finding.createdAt,
    )
    .run();
}

export async function listFindings(
  db: D1Like,
  siteId: string,
): Promise<Finding[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM findings WHERE site_id = ? ORDER BY organic_impact_score DESC`,
    )
    .bind(siteId)
    .all<Record<string, unknown>>();
  return results.map((row) => ({
    id: String(row.id),
    siteId: String(row.site_id),
    analysisId: String(row.analysis_id),
    category: row.category as Finding["category"],
    severity: row.severity as Finding["severity"],
    title: String(row.title),
    summary: String(row.summary),
    evidence: JSON.parse(String(row.evidence_json)),
    organicImpactScore: Number(row.organic_impact_score),
    recommendation: row.recommendation
      ? String(row.recommendation)
      : undefined,
    pagesAffected: row.pages_affected_json
      ? (JSON.parse(String(row.pages_affected_json)) as string[])
      : [],
    createdAt: String(row.created_at),
  }));
}

export async function insertGrowthPlan(
  db: D1Like,
  plan: GrowthPlan,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO growth_plans (
        id, site_id, analysis_id, situation, constraints_json,
        competitive_advantage, highest_impact_opportunity,
        priorities_json, sections_json, markdown, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      plan.id,
      plan.siteId,
      plan.analysisId,
      plan.situation,
      JSON.stringify(plan.constraints),
      plan.competitiveAdvantage,
      plan.highestImpactOpportunity,
      JSON.stringify(plan.priorities),
      JSON.stringify(plan.sections),
      plan.markdown,
      plan.createdAt,
    )
    .run();
}

export async function getLatestGrowthPlan(
  db: D1Like,
  siteId: string,
): Promise<GrowthPlan | null> {
  const row = await db
    .prepare(
      `SELECT * FROM growth_plans WHERE site_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(siteId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: String(row.id),
    siteId: String(row.site_id),
    analysisId: String(row.analysis_id),
    situation: String(row.situation),
    constraints: JSON.parse(String(row.constraints_json)) as string[],
    competitiveAdvantage: String(row.competitive_advantage),
    highestImpactOpportunity: String(row.highest_impact_opportunity),
    priorities: JSON.parse(String(row.priorities_json)),
    sections: JSON.parse(String(row.sections_json)),
    markdown: String(row.markdown),
    createdAt: String(row.created_at),
  };
}

export async function insertOpportunity(
  db: D1Like,
  opportunity: Opportunity,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO opportunities (
        id, site_id, analysis_id, title, search_demand, intent, current_rank,
        competitor_strength, current_page, potential_page, estimated_difficulty,
        business_value, conversion_potential, technical_effort, content_effort,
        priority_score, rationale, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      opportunity.id,
      opportunity.siteId,
      opportunity.analysisId,
      opportunity.title,
      opportunity.searchDemand,
      opportunity.intent,
      opportunity.currentRank ?? null,
      opportunity.competitorStrength,
      opportunity.currentPage ?? null,
      opportunity.potentialPage ?? null,
      opportunity.estimatedDifficulty,
      opportunity.businessValue,
      opportunity.conversionPotential,
      opportunity.technicalEffort,
      opportunity.contentEffort,
      opportunity.priorityScore,
      opportunity.rationale,
      new Date().toISOString(),
    )
    .run();
}

export async function listOpportunities(
  db: D1Like,
  siteId: string,
): Promise<Opportunity[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM opportunities WHERE site_id = ? ORDER BY priority_score DESC`,
    )
    .bind(siteId)
    .all<Record<string, unknown>>();
  return results.map((row) => ({
    id: String(row.id),
    siteId: String(row.site_id),
    analysisId: String(row.analysis_id),
    title: String(row.title),
    searchDemand: Number(row.search_demand),
    intent: String(row.intent),
    currentRank: row.current_rank != null ? Number(row.current_rank) : undefined,
    competitorStrength: Number(row.competitor_strength),
    currentPage: row.current_page ? String(row.current_page) : undefined,
    potentialPage: row.potential_page ? String(row.potential_page) : undefined,
    estimatedDifficulty: Number(row.estimated_difficulty),
    businessValue: Number(row.business_value),
    conversionPotential: Number(row.conversion_potential),
    technicalEffort: Number(row.technical_effort),
    contentEffort: Number(row.content_effort),
    priorityScore: Number(row.priority_score),
    rationale: String(row.rationale),
  }));
}

export async function insertCompetitor(
  db: D1Like,
  competitor: CompetitorProfile,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO competitors (
        id, site_id, domain, category, relevance_score, summary,
        architecture_notes, content_notes, conversion_notes, technical_notes,
        evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      competitor.id,
      competitor.siteId,
      competitor.domain,
      competitor.category,
      competitor.relevanceScore,
      competitor.summary,
      competitor.architectureNotes ?? null,
      competitor.contentNotes ?? null,
      competitor.conversionNotes ?? null,
      competitor.technicalNotes ?? null,
      JSON.stringify(competitor.evidence),
      new Date().toISOString(),
    )
    .run();
}

export async function listCompetitors(
  db: D1Like,
  siteId: string,
): Promise<CompetitorProfile[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM competitors WHERE site_id = ? ORDER BY relevance_score DESC`,
    )
    .bind(siteId)
    .all<Record<string, unknown>>();
  return results.map((row) => ({
    id: String(row.id),
    siteId: String(row.site_id),
    domain: String(row.domain),
    category: row.category as CompetitorProfile["category"],
    relevanceScore: Number(row.relevance_score),
    summary: String(row.summary),
    architectureNotes: row.architecture_notes
      ? String(row.architecture_notes)
      : undefined,
    contentNotes: row.content_notes ? String(row.content_notes) : undefined,
    conversionNotes: row.conversion_notes
      ? String(row.conversion_notes)
      : undefined,
    technicalNotes: row.technical_notes
      ? String(row.technical_notes)
      : undefined,
    evidence: JSON.parse(String(row.evidence_json)),
  }));
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

export async function insertSearchMetrics(
  db: D1Like,
  siteId: string,
  analysisId: string | null,
  rows: SearchMetricRow[],
): Promise<void> {
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
        analysisId,
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

/** Replaces the latest synced Search Console snapshot for a site. */
export async function replaceCurrentSearchMetrics(
  db: D1Like,
  siteId: string,
  rows: SearchMetricRow[],
): Promise<void> {
  await db.prepare("DELETE FROM search_metrics WHERE site_id = ? AND analysis_id IS NULL")
    .bind(siteId).run();
  await insertSearchMetrics(db, siteId, null, rows);
}

export async function listSearchMetrics(
  db: D1Like,
  siteId: string,
): Promise<SearchMetricRow[]> {
  const { results } = await db
    .prepare(
      `SELECT query, page, country, device, impressions, clicks, ctr, position, period_start AS periodStart, period_end AS periodEnd
       FROM search_metrics WHERE site_id = ?
       ORDER BY clicks DESC LIMIT 500`,
    )
    .bind(siteId)
    .all<SearchMetricRow>();
  return results;
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

export async function countConversionEvents(
  db: D1Like,
  siteId: string,
): Promise<Record<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT event, COUNT(*) as count FROM conversion_events
       WHERE site_id = ? GROUP BY event`,
    )
    .bind(siteId)
    .all<{ event: string; count: number }>();
  return Object.fromEntries(results.map((r) => [r.event, Number(r.count)]));
}

