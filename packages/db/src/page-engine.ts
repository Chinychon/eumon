import { mergeRecordData } from "@organic-growth/core";
import type {
  CtaVariant,
  DataRecord,
  DatasetField,
  DataSource,
  Dataset,
  GeneratedPage,
  GeneratedPageStatus,
  Job,
  JobStatus,
  JsonObject,
  PageSettings,
  PageTemplate,
} from "@organic-growth/core";
import { chunks, nowIso, runStatements, type D1Like } from "./d1.js";

type Row = Record<string, unknown>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

const optional = (value: unknown) => (value == null ? undefined : String(value));

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

function mapDataset(row: Row): Dataset {
  return {
    id: String(row.id),
    siteId: String(row.site_id),
    name: String(row.name),
    entityType: String(row.entity_type),
    description: String(row.description),
    fields: parseJson(row.fields_json, []),
    keyField: String(row.key_field),
    pageIdeas: parseJson(row.page_ideas_json, []),
    status: String(row.status) as Dataset["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function upsertDataset(db: D1Like, dataset: Dataset): Promise<void> {
  await db.prepare(
    `INSERT INTO datasets (id, site_id, name, entity_type, description, fields_json, key_field, page_ideas_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, entity_type = excluded.entity_type,
       description = excluded.description, fields_json = excluded.fields_json, key_field = excluded.key_field,
       page_ideas_json = excluded.page_ideas_json, status = excluded.status, updated_at = excluded.updated_at`,
  ).bind(
    dataset.id, dataset.siteId, dataset.name, dataset.entityType, dataset.description,
    JSON.stringify(dataset.fields), dataset.keyField, JSON.stringify(dataset.pageIdeas),
    dataset.status, dataset.createdAt, dataset.updatedAt,
  ).run();
}

export async function getDataset(db: D1Like, id: string): Promise<Dataset | null> {
  const row = await db.prepare("SELECT * FROM datasets WHERE id = ?").bind(id).first<Row>();
  return row ? mapDataset(row) : null;
}

export async function listDatasets(db: D1Like, siteId: string): Promise<Array<Dataset & { recordCount: number }>> {
  const { results } = await db.prepare(
    `SELECT d.*, (SELECT COUNT(*) FROM data_records r WHERE r.dataset_id = d.id) AS record_count
     FROM datasets d WHERE d.site_id = ? AND d.status != 'archived' ORDER BY d.created_at`,
  ).bind(siteId).all<Row>();
  return results.map((row) => ({ ...mapDataset(row), recordCount: Number(row.record_count ?? 0) }));
}

export async function deleteDataset(db: D1Like, id: string): Promise<void> {
  // D1 enforces foreign keys, so remove dependants explicitly in dependency order.
  await runStatements(db, [
    db.prepare("DELETE FROM generated_pages WHERE template_id IN (SELECT id FROM page_templates WHERE dataset_id = ?)").bind(id),
    db.prepare("DELETE FROM page_templates WHERE dataset_id = ?").bind(id),
    db.prepare("DELETE FROM data_records WHERE dataset_id = ?").bind(id),
    db.prepare("DELETE FROM data_sources WHERE dataset_id = ?").bind(id),
    db.prepare("DELETE FROM datasets WHERE id = ?").bind(id),
  ]);
}

export type SiteScope = { goal?: string; businessSummary: string; conversionGoal: string; updatedAt: string };

export async function getSiteScope(db: D1Like, siteId: string): Promise<SiteScope | null> {
  const row = await db.prepare("SELECT * FROM site_scopes WHERE site_id = ?").bind(siteId).first<Row>();
  return row ? {
    goal: optional(row.goal), businessSummary: String(row.business_summary),
    conversionGoal: String(row.conversion_goal), updatedAt: String(row.updated_at),
  } : null;
}

export async function saveSiteScope(db: D1Like, siteId: string, scope: Omit<SiteScope, "updatedAt">): Promise<void> {
  await db.prepare(
    `INSERT INTO site_scopes (site_id, goal, business_summary, conversion_goal, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(site_id) DO UPDATE SET goal = excluded.goal, business_summary = excluded.business_summary,
       conversion_goal = excluded.conversion_goal, updated_at = excluded.updated_at`,
  ).bind(siteId, scope.goal ?? null, scope.businessSummary, scope.conversionGoal, nowIso()).run();
}

/** Removes proposals the owner never acted on, before a fresh scoping run. */
export async function deleteUnusedProposedDatasets(db: D1Like, siteId: string): Promise<void> {
  const { results } = await db.prepare(
    `SELECT id FROM datasets d WHERE site_id = ? AND status = 'proposed'
       AND NOT EXISTS (SELECT 1 FROM data_records r WHERE r.dataset_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM page_templates t WHERE t.dataset_id = d.id)`,
  ).bind(siteId).all<{ id: string }>();
  for (const row of results) await deleteDataset(db, row.id);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function mapSource(row: Row): DataSource {
  return {
    id: String(row.id),
    siteId: String(row.site_id),
    datasetId: String(row.dataset_id),
    url: String(row.url),
    kind: String(row.kind) as DataSource["kind"],
    urlPattern: optional(row.url_pattern),
    maxPages: Number(row.max_pages),
    origin: String(row.origin) as DataSource["origin"],
    rationale: optional(row.rationale),
    status: String(row.status) as DataSource["status"],
    robotsAllowed: row.robots_allowed == null ? undefined : Number(row.robots_allowed) === 1,
    recordCount: Number(row.record_count ?? 0),
    lastRunAt: optional(row.last_run_at),
    error: optional(row.error),
    createdAt: String(row.created_at),
  };
}

export async function upsertSource(db: D1Like, source: DataSource): Promise<void> {
  await db.prepare(
    `INSERT INTO data_sources (id, site_id, dataset_id, url, kind, url_pattern, max_pages, origin, rationale, status,
       robots_allowed, record_count, last_run_at, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET url = excluded.url, kind = excluded.kind, url_pattern = excluded.url_pattern,
       max_pages = excluded.max_pages, rationale = excluded.rationale, status = excluded.status,
       robots_allowed = excluded.robots_allowed, record_count = excluded.record_count,
       last_run_at = excluded.last_run_at, error = excluded.error`,
  ).bind(
    source.id, source.siteId, source.datasetId, source.url, source.kind, source.urlPattern ?? null,
    source.maxPages, source.origin, source.rationale ?? null, source.status,
    source.robotsAllowed == null ? null : source.robotsAllowed ? 1 : 0,
    source.recordCount, source.lastRunAt ?? null, source.error ?? null, source.createdAt,
  ).run();
}

export async function getSource(db: D1Like, id: string): Promise<DataSource | null> {
  const row = await db.prepare("SELECT * FROM data_sources WHERE id = ?").bind(id).first<Row>();
  return row ? mapSource(row) : null;
}

export async function listSources(db: D1Like, datasetId: string): Promise<DataSource[]> {
  const { results } = await db.prepare("SELECT * FROM data_sources WHERE dataset_id = ? ORDER BY created_at")
    .bind(datasetId).all<Row>();
  return results.map(mapSource);
}

export async function deleteSource(db: D1Like, id: string): Promise<void> {
  await db.prepare("DELETE FROM data_sources WHERE id = ?").bind(id).run();
}

export async function refreshSourceRecordCount(db: D1Like, sourceId: string, error?: string): Promise<void> {
  await db.prepare(
    `UPDATE data_sources SET record_count = (SELECT COUNT(*) FROM data_records WHERE source_id = ?),
       last_run_at = ?, error = ? WHERE id = ?`,
  ).bind(sourceId, nowIso(), error ?? null, sourceId).run();
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function mapRecord(row: Row): DataRecord {
  return {
    id: String(row.id),
    siteId: String(row.site_id),
    datasetId: String(row.dataset_id),
    key: String(row.record_key),
    data: parseJson<JsonObject>(row.data_json, {}),
    sourceId: optional(row.source_id),
    sourceUrl: optional(row.source_url),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Inserts records, merging into an existing record with the same key: new
 * single values win, gaps are filled, and list values accumulate, so facts
 * spread across many pages (e.g. one mall's brands) all end up on the record.
 */
export async function upsertRecords(
  db: D1Like,
  records: Array<Pick<DataRecord, "siteId" | "datasetId" | "key" | "data" | "sourceId" | "sourceUrl">>,
  fields: DatasetField[],
): Promise<void> {
  if (!records.length) return;
  const now = nowIso();
  // Several rows in one batch can share a key (a list page naming the same entity twice).
  const incoming = new Map<string, (typeof records)[number]>();
  for (const record of records) {
    const prior = incoming.get(record.key);
    incoming.set(record.key, prior ? { ...prior, data: mergeRecordData(fields, record.data, [prior.data]) } : record);
  }
  const datasetId = records[0]!.datasetId;
  const existing = new Map<string, JsonObject>();
  for (const group of chunks([...incoming.keys()], 90)) {
    const { results } = await db.prepare(
      `SELECT record_key, data_json FROM data_records WHERE dataset_id = ? AND record_key IN (${group.map(() => "?").join(",")})`,
    ).bind(datasetId, ...group).all<{ record_key: string; data_json: string }>();
    for (const row of results) existing.set(row.record_key, parseJson<JsonObject>(row.data_json, {}));
  }
  const statements = [...incoming.values()].map((record) => {
    const prior = existing.get(record.key);
    const merged = prior ? mergeRecordData(fields, record.data, [prior]) : record.data;
    const data = Object.fromEntries(Object.entries(merged).filter(([, value]) => value != null && value !== ""));
    return db.prepare(
      `INSERT INTO data_records (id, site_id, dataset_id, record_key, data_json, source_id, source_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dataset_id, record_key) DO UPDATE SET
         data_json = excluded.data_json,
         source_id = COALESCE(data_records.source_id, excluded.source_id),
         source_url = COALESCE(data_records.source_url, excluded.source_url),
         updated_at = excluded.updated_at`,
    ).bind(
      `rec_${crypto.randomUUID()}`, record.siteId, record.datasetId, record.key, JSON.stringify(data),
      record.sourceId ?? null, record.sourceUrl ?? null, now, now,
    );
  });
  for (const group of chunks(statements, 50)) await runStatements(db, group);
}

export async function listRecords(
  db: D1Like,
  datasetId: string,
  options: { limit?: number; offset?: number; search?: string } = {},
): Promise<{ records: DataRecord[]; total: number }> {
  const search = options.search?.trim() ? `%${options.search.trim().toLowerCase()}%` : null;
  const where = search ? "dataset_id = ? AND LOWER(data_json) LIKE ?" : "dataset_id = ?";
  const params = search ? [datasetId, search] : [datasetId];
  const [{ results }, total] = await Promise.all([
    db.prepare(`SELECT * FROM data_records WHERE ${where} ORDER BY record_key LIMIT ? OFFSET ?`)
      .bind(...params, Math.min(options.limit ?? 50, 500), options.offset ?? 0).all<Row>(),
    db.prepare(`SELECT COUNT(*) AS n FROM data_records WHERE ${where}`).bind(...params).first<{ n: number }>(),
  ]);
  return { records: results.map(mapRecord), total: Number(total?.n ?? 0) };
}

/** Every record in a dataset, for page generation. Bounded to protect Worker memory. */
export async function listAllRecords(db: D1Like, datasetId: string, max = 50_000): Promise<DataRecord[]> {
  const output: DataRecord[] = [];
  for (let offset = 0; offset < max; offset += 1000) {
    const { results } = await db.prepare(
      "SELECT * FROM data_records WHERE dataset_id = ? ORDER BY record_key LIMIT 1000 OFFSET ?",
    ).bind(datasetId, offset).all<Row>();
    output.push(...results.map(mapRecord));
    if (results.length < 1000) break;
  }
  return output;
}

export async function getRecordsByIds(db: D1Like, ids: string[]): Promise<DataRecord[]> {
  const output: DataRecord[] = [];
  for (const group of chunks(ids, 90)) {
    const { results } = await db.prepare(
      `SELECT * FROM data_records WHERE id IN (${group.map(() => "?").join(",")})`,
    ).bind(...group).all<Row>();
    output.push(...results.map(mapRecord));
  }
  const order = new Map(ids.map((id, index) => [id, index]));
  return output.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** Folds duplicate records into a canonical one in a single batch. */
export async function mergeRecords(db: D1Like, input: { canonicalId: string; duplicateIds: string[]; data: JsonObject }): Promise<void> {
  const now = nowIso();
  await runStatements(db, [
    db.prepare("UPDATE data_records SET data_json = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(input.data), now, input.canonicalId),
    ...input.duplicateIds.map((id) => db.prepare("DELETE FROM data_records WHERE id = ?").bind(id)),
  ]);
}

export async function deleteRecord(db: D1Like, id: string): Promise<void> {
  await db.prepare("DELETE FROM data_records WHERE id = ?").bind(id).run();
}

// ---------------------------------------------------------------------------
// Jobs and the scrape queue
// ---------------------------------------------------------------------------

function mapJob(row: Row): Job {
  return {
    id: String(row.id),
    siteId: String(row.site_id),
    kind: String(row.kind) as Job["kind"],
    subjectId: String(row.subject_id),
    status: String(row.status) as JobStatus,
    progress: parseJson(row.progress_json, undefined),
    error: optional(row.error),
    createdAt: String(row.created_at),
    completedAt: optional(row.completed_at),
  };
}

export async function createJob(db: D1Like, job: Pick<Job, "id" | "siteId" | "kind" | "subjectId">): Promise<void> {
  await db.prepare(
    "INSERT INTO jobs (id, site_id, kind, subject_id, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)",
  ).bind(job.id, job.siteId, job.kind, job.subjectId, nowIso()).run();
}

export async function getJob(db: D1Like, id: string): Promise<Job | null> {
  const row = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<Row>();
  return row ? mapJob(row) : null;
}

export async function getLatestJob(db: D1Like, subjectId: string): Promise<Job | null> {
  const row = await db.prepare("SELECT * FROM jobs WHERE subject_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(subjectId).first<Row>();
  return row ? mapJob(row) : null;
}

export async function updateJob(
  db: D1Like,
  id: string,
  update: { status?: JobStatus; progress?: Job["progress"]; error?: string },
): Promise<void> {
  const finished = update.status === "completed" || update.status === "failed";
  await db.prepare(
    `UPDATE jobs SET status = COALESCE(?, status), progress_json = COALESCE(?, progress_json),
       error = COALESCE(?, error), completed_at = CASE WHEN ? THEN ? ELSE completed_at END WHERE id = ?`,
  ).bind(
    update.status ?? null, update.progress ? JSON.stringify(update.progress) : null,
    update.error ?? null, finished ? 1 : 0, nowIso(), id,
  ).run();
}

export async function enqueueScrapeUrls(db: D1Like, jobId: string, sourceId: string, urls: string[]): Promise<void> {
  const statements = [...new Set(urls)].map((url) =>
    db.prepare("INSERT OR IGNORE INTO scrape_queue (job_id, source_id, url) VALUES (?, ?, ?)").bind(jobId, sourceId, url));
  for (const group of chunks(statements, 100)) await runStatements(db, group);
}

export async function nextScrapeBatch(db: D1Like, jobId: string, limit: number): Promise<Array<{ url: string; sourceId: string }>> {
  const { results } = await db.prepare(
    "SELECT url, source_id FROM scrape_queue WHERE job_id = ? AND state = 'pending' ORDER BY source_id, url LIMIT ?",
  ).bind(jobId, limit).all<{ url: string; source_id: string }>();
  return results.map((row) => ({ url: row.url, sourceId: row.source_id }));
}

export async function markScrapeResults(
  db: D1Like,
  jobId: string,
  results: Array<{ url: string; state: "done" | "failed" | "skipped"; recordsFound?: number; error?: string }>,
): Promise<void> {
  await runStatements(db, results.map((result) => db.prepare(
    "UPDATE scrape_queue SET state = ?, records_found = ?, error = ? WHERE job_id = ? AND url = ?",
  ).bind(result.state, result.recordsFound ?? 0, result.error?.slice(0, 500) ?? null, jobId, result.url)));
}

export async function scrapeQueueCounts(db: D1Like, jobId: string): Promise<{ total: number; pending: number; failed: number; records: number }> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS total, SUM(state = 'pending') AS pending, SUM(state = 'failed') AS failed,
       SUM(records_found) AS records FROM scrape_queue WHERE job_id = ?`,
  ).bind(jobId).first<Record<string, number | null>>();
  return {
    total: Number(row?.total ?? 0),
    pending: Number(row?.pending ?? 0),
    failed: Number(row?.failed ?? 0),
    records: Number(row?.records ?? 0),
  };
}

export async function listScrapeFailures(db: D1Like, jobId: string, limit = 10): Promise<Array<{ url: string; error: string }>> {
  const { results } = await db.prepare(
    "SELECT url, error FROM scrape_queue WHERE job_id = ? AND state = 'failed' LIMIT ?",
  ).bind(jobId, limit).all<{ url: string; error: string | null }>();
  return results.map((row) => ({ url: row.url, error: row.error ?? "Unknown error" }));
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

type TemplateConfig = Omit<PageTemplate, "id" | "siteId" | "datasetId" | "name" | "status" | "createdAt" | "updatedAt">;

function mapTemplate(row: Row): PageTemplate {
  const config = parseJson<TemplateConfig>(row.config_json, {} as TemplateConfig);
  return {
    ...config,
    id: String(row.id),
    siteId: String(row.site_id),
    datasetId: String(row.dataset_id),
    name: String(row.name),
    status: String(row.status) as PageTemplate["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function upsertTemplate(db: D1Like, template: PageTemplate): Promise<void> {
  const { id, siteId, datasetId, name, status, createdAt, updatedAt, ...config } = template;
  await db.prepare(
    `INSERT INTO page_templates (id, site_id, dataset_id, name, config_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, config_json = excluded.config_json,
       status = excluded.status, updated_at = excluded.updated_at`,
  ).bind(id, siteId, datasetId, name, JSON.stringify(config), status, createdAt, updatedAt).run();
}

export async function getTemplate(db: D1Like, id: string): Promise<PageTemplate | null> {
  const row = await db.prepare("SELECT * FROM page_templates WHERE id = ?").bind(id).first<Row>();
  return row ? mapTemplate(row) : null;
}

export async function listTemplates(db: D1Like, siteId: string): Promise<Array<PageTemplate & { pageCounts: Record<string, number> }>> {
  const [{ results }, counts] = await Promise.all([
    db.prepare("SELECT * FROM page_templates WHERE site_id = ? ORDER BY created_at").bind(siteId).all<Row>(),
    db.prepare("SELECT template_id, status, COUNT(*) AS n FROM generated_pages WHERE site_id = ? GROUP BY template_id, status")
      .bind(siteId).all<{ template_id: string; status: string; n: number }>(),
  ]);
  return results.map((row) => {
    const template = mapTemplate(row);
    const pageCounts: Record<string, number> = {};
    for (const count of counts.results.filter((entry) => entry.template_id === template.id)) {
      pageCounts[count.status] = Number(count.n);
    }
    return { ...template, pageCounts };
  });
}

export async function deleteTemplate(db: D1Like, id: string): Promise<void> {
  await runStatements(db, [
    db.prepare("DELETE FROM page_revisions WHERE page_id IN (SELECT id FROM generated_pages WHERE template_id = ?)").bind(id),
    db.prepare("DELETE FROM generated_pages WHERE template_id = ?").bind(id),
    db.prepare("DELETE FROM page_templates WHERE id = ?").bind(id),
  ]);
}

// ---------------------------------------------------------------------------
// Generated pages
// ---------------------------------------------------------------------------

type PageContent = Pick<GeneratedPage, "groupValues" | "h1" | "intro" | "faq" | "recordIds" | "items" | "facts" | "related" | "overrides">;

function mapPage(row: Row): GeneratedPage {
  const content = parseJson<PageContent>(row.content_json, {
    groupValues: {}, h1: "", intro: "", faq: [], recordIds: [], items: [], facts: {}, related: [],
  });
  return {
    ...content,
    id: String(row.id),
    siteId: String(row.site_id),
    templateId: String(row.template_id),
    path: String(row.path),
    groupKey: String(row.group_key),
    title: String(row.title),
    description: String(row.description),
    qualityScore: Number(row.quality_score),
    qualityIssues: parseJson(row.quality_issues_json, []),
    status: String(row.status) as GeneratedPageStatus,
    publishedAt: optional(row.published_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function pageContent(page: GeneratedPage): string {
  const content: PageContent = {
    groupValues: page.groupValues, h1: page.h1, intro: page.intro, faq: page.faq,
    recordIds: page.recordIds, items: page.items, facts: page.facts, related: page.related,
    ...(page.overrides && Object.keys(page.overrides).length ? { overrides: page.overrides } : {}),
  };
  return JSON.stringify(content);
}

/** Paths of a template's pages that are or were live, which must never change. */
export async function listStablePaths(db: D1Like, templateId: string): Promise<Map<string, string>> {
  const { results } = await db.prepare(
    "SELECT group_key, path FROM generated_pages WHERE template_id = ? AND (status IN ('published', 'unpublished', 'retired') OR published_at IS NOT NULL)",
  ).bind(templateId).all<{ group_key: string; path: string }>();
  return new Map(results.map((row) => [row.group_key, row.path]));
}

/**
 * Applies a fresh generation run to a template's pages while keeping URLs
 * stable: a page that is already published keeps its path and stays live
 * unless the new run marks it thin or duplicate. Pages that disappeared from
 * the data are unpublished (served as 410) rather than silently deleted.
 */
export async function syncTemplatePages(db: D1Like, templateId: string, pages: GeneratedPage[]): Promise<{
  created: number; updated: number; retired: number;
}> {
  const { results } = await db.prepare(
    "SELECT id, group_key, path, status, published_at, content_json FROM generated_pages WHERE template_id = ?",
  ).bind(templateId).all<{ id: string; group_key: string; path: string; status: string; published_at: string | null; content_json: string }>();
  const existing = new Map(results.map((row) => [row.group_key, row]));
  const seen = new Set<string>();
  const now = nowIso();
  let created = 0;
  let updated = 0;
  const statements: ReturnType<ReturnType<D1Like["prepare"]>["bind"]>[] = [];

  for (const page of pages) {
    seen.add(page.groupKey);
    const prior = existing.get(page.groupKey);
    if (prior) {
      updated++;
      const wasLive = prior.status === "published";
      // A passing page keeps the owner's choice: live stays live, taken-offline stays offline.
      const status = page.status === "draft" && (wasLive || prior.status === "unpublished") ? prior.status : page.status;
      // Owner edits and applied optimizations outlive regeneration.
      const overrides = parseJson<PageContent>(prior.content_json, {} as PageContent).overrides;
      if (overrides) Object.assign(page, overrides, { overrides });
      statements.push(db.prepare(
        `UPDATE generated_pages SET title = ?, description = ?, content_json = ?, quality_score = ?,
           quality_issues_json = ?, status = ?, path = ?, updated_at = ? WHERE id = ?`,
      ).bind(
        page.title, page.description, pageContent(page), page.qualityScore,
        JSON.stringify(page.qualityIssues), status, wasLive ? prior.path : page.path, now, prior.id,
      ));
    } else {
      created++;
      statements.push(db.prepare(
        `INSERT INTO generated_pages (id, site_id, template_id, path, group_key, title, description, content_json,
           quality_score, quality_issues_json, status, published_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(site_id, path) DO NOTHING`,
      ).bind(
        page.id, page.siteId, templateId, page.path, page.groupKey, page.title, page.description,
        pageContent(page), page.qualityScore, JSON.stringify(page.qualityIssues), page.status, now, now,
      ));
    }
  }

  let retired = 0;
  for (const [groupKey, prior] of existing) {
    if (seen.has(groupKey)) continue;
    retired++;
    // Pages that were ever live answer 410 Gone rather than disappearing silently.
    statements.push(prior.published_at || prior.status === "published" || prior.status === "unpublished" || prior.status === "retired"
      ? db.prepare("UPDATE generated_pages SET status = 'retired', updated_at = ? WHERE id = ?").bind(now, prior.id)
      : db.prepare("DELETE FROM generated_pages WHERE id = ?").bind(prior.id));
  }

  for (const group of chunks(statements, 50)) await runStatements(db, group);
  return { created, updated, retired };
}

export async function listPages(
  db: D1Like,
  filter: { siteId: string; templateId?: string; status?: GeneratedPageStatus; limit?: number; offset?: number },
): Promise<{ pages: GeneratedPage[]; total: number }> {
  const clauses = ["site_id = ?"];
  const params: unknown[] = [filter.siteId];
  if (filter.templateId) { clauses.push("template_id = ?"); params.push(filter.templateId); }
  if (filter.status) { clauses.push("status = ?"); params.push(filter.status); }
  const where = clauses.join(" AND ");
  const [{ results }, total] = await Promise.all([
    db.prepare(`SELECT * FROM generated_pages WHERE ${where} ORDER BY quality_score DESC, path LIMIT ? OFFSET ?`)
      .bind(...params, Math.min(filter.limit ?? 50, 1000), filter.offset ?? 0).all<Row>(),
    db.prepare(`SELECT COUNT(*) AS n FROM generated_pages WHERE ${where}`).bind(...params).first<{ n: number }>(),
  ]);
  return { pages: results.map(mapPage), total: Number(total?.n ?? 0) };
}

export async function getPage(db: D1Like, id: string): Promise<GeneratedPage | null> {
  const row = await db.prepare("SELECT * FROM generated_pages WHERE id = ?").bind(id).first<Row>();
  return row ? mapPage(row) : null;
}

export async function getPageByPath(db: D1Like, siteId: string, path: string): Promise<GeneratedPage | null> {
  const row = await db.prepare("SELECT * FROM generated_pages WHERE site_id = ? AND path = ?")
    .bind(siteId, path).first<Row>();
  return row ? mapPage(row) : null;
}

/** Lightweight listing of live pages for hubs and sitemaps. */
export async function listPublishedPaths(db: D1Like, siteId: string, limit = 50_000): Promise<Array<{
  path: string; title: string; templateId: string; updatedAt: string;
}>> {
  const { results } = await db.prepare(
    "SELECT path, title, template_id, updated_at FROM generated_pages WHERE site_id = ? AND status = 'published' ORDER BY path LIMIT ?",
  ).bind(siteId, limit).all<{ path: string; title: string; template_id: string; updated_at: string }>();
  return results.map((row) => ({ path: row.path, title: row.title, templateId: row.template_id, updatedAt: row.updated_at }));
}

/**
 * Entity pages from other templates, keyed by record slug, so field values
 * (e.g. a doctor's hospital) can link to the matching entity's page.
 */
export async function listEntityPageKeys(db: D1Like, siteId: string, templateIds: string[]): Promise<Array<{ key: string; path: string; title: string }>> {
  const output: Array<{ key: string; path: string; title: string }> = [];
  for (const group of chunks(templateIds, 50)) {
    const { results } = await db.prepare(
      `SELECT group_key, path, title FROM generated_pages
       WHERE site_id = ? AND status IN ('draft', 'published') AND template_id IN (${group.map(() => "?").join(",")})`,
    ).bind(siteId, ...group).all<{ group_key: string; path: string; title: string }>();
    output.push(...results.map((row) => ({ key: row.group_key, path: row.path, title: row.title })));
  }
  return output;
}

/** The subset of internal paths that are live, so pages never link to drafts or retired pages. */
export async function filterPublishedPaths(db: D1Like, siteId: string, paths: string[]): Promise<Set<string>> {
  const live = new Set<string>();
  for (const group of chunks([...new Set(paths)], 90)) {
    const { results } = await db.prepare(
      `SELECT path FROM generated_pages WHERE site_id = ? AND status = 'published' AND path IN (${group.map(() => "?").join(",")})`,
    ).bind(siteId, ...group).all<{ path: string }>();
    for (const row of results) live.add(row.path);
  }
  return live;
}

/** Publishes every draft (quality-passing) page of a template, or takes the template offline. */
export async function setTemplatePublication(db: D1Like, templateId: string, publish: boolean): Promise<number> {
  const now = nowIso();
  const result = publish
    ? await db.prepare(
      `UPDATE generated_pages SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ?
       WHERE template_id = ? AND status IN ('draft', 'unpublished') AND quality_score > 0`,
    ).bind(now, now, templateId).run()
    : await db.prepare(
      "UPDATE generated_pages SET status = 'unpublished', updated_at = ? WHERE template_id = ? AND status = 'published'",
    ).bind(now, templateId).run();
  return Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0);
}

/** Edits a page and records the before/after so the impact can be measured later. */
export async function updatePageFields(
  db: D1Like,
  page: GeneratedPage,
  update: Partial<Pick<GeneratedPage, "title" | "description" | "h1" | "intro" | "status">>,
  meta: { reason: string; author: string },
): Promise<GeneratedPage> {
  const next: GeneratedPage = { ...page, ...update, updatedAt: nowIso() };
  if (update.status === "published" && !page.publishedAt) next.publishedAt = next.updatedAt;
  const overridden = (["title", "description", "h1", "intro"] as const).filter((field) => update[field] !== undefined);
  if (overridden.length) {
    next.overrides = { ...page.overrides };
    for (const field of overridden) next.overrides[field] = update[field];
  }
  const revisions = (Object.keys(update) as Array<keyof typeof update>)
    .filter((field) => update[field] !== undefined && update[field] !== page[field])
    .map((field) => db.prepare(
      `INSERT INTO page_revisions (id, page_id, field, before_value, after_value, reason, author, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(`rev_${crypto.randomUUID()}`, page.id, field, String(page[field] ?? ""), String(update[field] ?? ""), meta.reason, meta.author, next.updatedAt));
  await runStatements(db, [
    db.prepare(
      `UPDATE generated_pages SET title = ?, description = ?, content_json = ?, status = ?, published_at = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(next.title, next.description, pageContent(next), next.status, next.publishedAt ?? null, next.updatedAt, page.id),
    ...revisions,
  ]);
  return next;
}

export type WindowMetrics = { views: number; ctaClicks: number; searchClicks: number; searchImpressions: number };

export type RevisionImpact = {
  id: string;
  pageId: string;
  path: string;
  field: string;
  before: string;
  after: string;
  reason: string;
  author: string;
  createdAt: string;
  /** Equal-length windows either side of the change; `windowDays` shrinks while the "after" window is still filling. */
  windowDays: number;
  metricsBefore: WindowMetrics;
  metricsAfter: WindowMetrics;
};

/** Drops owner overrides so the next generation run restores the template's copy. */
export async function clearPageOverrides(db: D1Like, page: GeneratedPage): Promise<void> {
  const next: GeneratedPage = { ...page, overrides: undefined, updatedAt: nowIso() };
  await db.prepare("UPDATE generated_pages SET content_json = ?, updated_at = ? WHERE id = ?")
    .bind(pageContent(next), next.updatedAt, page.id).run();
}

/**
 * Every recorded page change with the same-length window of metrics before
 * and after it — the raw material for learning which changes work.
 */
export async function listPageRevisions(db: D1Like, siteId: string, limit = 50, maxWindowDays = 14): Promise<RevisionImpact[]> {
  const { results } = await db.prepare(
    `SELECT r.*, p.path FROM page_revisions r JOIN generated_pages p ON p.id = r.page_id
     WHERE p.site_id = ? ORDER BY r.created_at DESC LIMIT ?`,
  ).bind(siteId, limit).all<Row>();
  const now = Date.now();
  return Promise.all(results.map(async (row) => {
    const createdAt = String(row.created_at);
    const changeDay = createdAt.slice(0, 10);
    const elapsed = Math.floor((now - Date.parse(`${changeDay}T00:00:00Z`)) / 86_400_000);
    const windowDays = Math.max(0, Math.min(maxWindowDays, elapsed));
    const window = async (from: string, to: string): Promise<WindowMetrics> => {
      const totals = await db.prepare(
        `SELECT COALESCE(SUM(views), 0) AS views, COALESCE(SUM(cta_clicks), 0) AS cta_clicks,
           COALESCE(SUM(search_clicks), 0) AS search_clicks, COALESCE(SUM(search_impressions), 0) AS search_impressions
         FROM page_metrics_daily WHERE page_id = ? AND day >= ? AND day < ?`,
      ).bind(String(row.page_id), from, to).first<Record<string, number>>();
      return {
        views: Number(totals?.views ?? 0),
        ctaClicks: Number(totals?.cta_clicks ?? 0),
        searchClicks: Number(totals?.search_clicks ?? 0),
        searchImpressions: Number(totals?.search_impressions ?? 0),
      };
    };
    const shift = (days: number) => new Date(Date.parse(`${changeDay}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const [metricsBefore, metricsAfter] = await Promise.all([
      window(shift(-windowDays), changeDay),
      window(changeDay, shift(windowDays)),
    ]);
    return {
      id: String(row.id), pageId: String(row.page_id), path: String(row.path), field: String(row.field),
      before: String(row.before_value ?? ""), after: String(row.after_value ?? ""),
      reason: String(row.reason), author: String(row.author), createdAt,
      windowDays, metricsBefore, metricsAfter,
    };
  }));
}

// ---------------------------------------------------------------------------
// Settings and CTA variants
// ---------------------------------------------------------------------------

export function defaultPageSettings(siteId: string, siteName: string, baseUrl: string): PageSettings {
  return {
    siteId,
    publicOrigin: new URL(baseUrl).origin,
    mountPath: "/guides",
    siteName,
    brandColor: "#176b50",
    ctaLabel: "Get in touch",
    ctaUrl: `${baseUrl.replace(/\/$/, "")}/contact`,
    ctaCopy: "Talk to our team about your options.",
    updatedAt: nowIso(),
  };
}

export async function getPageSettings(db: D1Like, siteId: string): Promise<PageSettings | null> {
  const row = await db.prepare("SELECT * FROM page_settings WHERE site_id = ?").bind(siteId).first<Row>();
  if (!row) return null;
  return {
    siteId: String(row.site_id),
    publicOrigin: String(row.public_origin),
    mountPath: String(row.mount_path),
    siteName: String(row.site_name),
    brandColor: String(row.brand_color),
    ctaLabel: String(row.cta_label),
    ctaUrl: String(row.cta_url),
    ctaCopy: String(row.cta_copy),
    verifiedAt: optional(row.verified_at),
    updatedAt: String(row.updated_at),
  };
}

export async function upsertPageSettings(db: D1Like, settings: PageSettings): Promise<void> {
  await db.prepare(
    `INSERT INTO page_settings (site_id, public_origin, mount_path, site_name, brand_color, cta_label, cta_url, cta_copy, verified_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id) DO UPDATE SET public_origin = excluded.public_origin, mount_path = excluded.mount_path, verified_at = excluded.verified_at, site_name = excluded.site_name,
       brand_color = excluded.brand_color, cta_label = excluded.cta_label, cta_url = excluded.cta_url,
       cta_copy = excluded.cta_copy, updated_at = excluded.updated_at`,
  ).bind(
    settings.siteId, settings.publicOrigin, settings.mountPath, settings.siteName, settings.brandColor,
    settings.ctaLabel, settings.ctaUrl, settings.ctaCopy, settings.verifiedAt ?? null, settings.updatedAt,
  ).run();
}

function mapVariant(row: Row): CtaVariant {
  return {
    id: String(row.id), siteId: String(row.site_id), label: String(row.label), copy: String(row.copy),
    url: String(row.url), impressions: Number(row.impressions), clicks: Number(row.clicks),
    active: Number(row.active) === 1, createdAt: String(row.created_at),
  };
}

export async function listCtaVariants(db: D1Like, siteId: string): Promise<CtaVariant[]> {
  const { results } = await db.prepare("SELECT * FROM cta_variants WHERE site_id = ? ORDER BY created_at").bind(siteId).all<Row>();
  return results.map(mapVariant);
}

export async function insertCtaVariant(db: D1Like, variant: CtaVariant): Promise<void> {
  await db.prepare(
    "INSERT INTO cta_variants (id, site_id, label, copy, url, impressions, clicks, active, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)",
  ).bind(variant.id, variant.siteId, variant.label, variant.copy, variant.url, variant.active ? 1 : 0, variant.createdAt).run();
}

export async function setCtaVariantActive(db: D1Like, siteId: string, id: string, active: boolean): Promise<void> {
  await db.prepare("UPDATE cta_variants SET active = ? WHERE id = ? AND site_id = ?").bind(active ? 1 : 0, id, siteId).run();
}

// ---------------------------------------------------------------------------
// Page analytics
// ---------------------------------------------------------------------------

export type PageHitKind = "googlebot_hits" | "other_bot_hits" | "views" | "cta_clicks";

export async function incrementPageMetric(
  db: D1Like,
  input: { siteId: string; pageId: string; kind: PageHitKind; day?: string; variantId?: string },
): Promise<void> {
  const day = input.day ?? nowIso().slice(0, 10);
  const column = input.kind;
  const statements = [
    db.prepare(
      `INSERT INTO page_metrics_daily (site_id, page_id, day, ${column}) VALUES (?, ?, ?, 1)
       ON CONFLICT(page_id, day) DO UPDATE SET ${column} = ${column} + 1`,
    ).bind(input.siteId, input.pageId, day),
  ];
  if (input.variantId && (column === "views" || column === "cta_clicks")) {
    const counter = column === "views" ? "impressions" : "clicks";
    statements.push(db.prepare(`UPDATE cta_variants SET ${counter} = ${counter} + 1 WHERE id = ? AND site_id = ?`)
      .bind(input.variantId, input.siteId));
  }
  await runStatements(db, statements);
}

export async function recordLandingSession(db: D1Like, input: { siteId: string; sessionId: string; pageId: string }): Promise<void> {
  await db.prepare(
    "INSERT OR IGNORE INTO page_sessions (session_id, site_id, page_id, first_seen_at) VALUES (?, ?, ?, ?)",
  ).bind(input.sessionId, input.siteId, input.pageId, nowIso()).run();
}

export async function replacePageSearchMetrics(
  db: D1Like,
  siteId: string,
  rows: Array<{ pageUrl: string; query: string; clicks: number; impressions: number; ctr: number; position: number; periodStart: string; periodEnd: string }>,
): Promise<void> {
  await db.prepare("DELETE FROM page_search_metrics WHERE site_id = ?").bind(siteId).run();
  const statements = rows.map((row) => db.prepare(
    `INSERT OR REPLACE INTO page_search_metrics (site_id, page_url, query, clicks, impressions, ctr, position, period_start, period_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(siteId, row.pageUrl, row.query, row.clicks, row.impressions, row.ctr, row.position, row.periodStart, row.periodEnd));
  for (const group of chunks(statements, 100)) await runStatements(db, group);
}

/** Overwrites Search Console daily totals for pages (later syncs correct provisional days). */
export async function upsertPageSearchDaily(
  db: D1Like,
  siteId: string,
  rows: Array<{ pageId: string; day: string; clicks: number; impressions: number; position: number }>,
): Promise<void> {
  const statements = rows.map((row) => db.prepare(
    `INSERT INTO page_metrics_daily (site_id, page_id, day, search_clicks, search_impressions, search_position)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(page_id, day) DO UPDATE SET search_clicks = excluded.search_clicks,
       search_impressions = excluded.search_impressions, search_position = excluded.search_position`,
  ).bind(siteId, row.pageId, row.day, row.clicks, row.impressions, row.position));
  for (const group of chunks(statements, 100)) await runStatements(db, group);
}

/** Sites with live generated pages and a Search Console property, for the daily sync. */
export async function listSitesWithLivePages(db: D1Like): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT DISTINCT s.id FROM sites s JOIN generated_pages p ON p.site_id = s.id AND p.status = 'published'
     WHERE s.gsc_property IS NOT NULL`,
  ).all<{ id: string }>();
  return results.map((row) => row.id);
}

/** Maps public page URLs back to page IDs for Search Console imports. */
export async function mapPageIdsByPath(db: D1Like, siteId: string): Promise<Map<string, string>> {
  const { results } = await db.prepare("SELECT id, path FROM generated_pages WHERE site_id = ?")
    .bind(siteId).all<{ id: string; path: string }>();
  return new Map(results.map((row) => [row.path, row.id]));
}

export type PagePerformanceRow = {
  pageId: string;
  templateId: string;
  path: string;
  title: string;
  publishedAt?: string;
  views: number;
  ctaClicks: number;
  /** Conversion events from sessions that landed on this page (form submits, bookings, WhatsApp, calls). */
  conversions: number;
  googlebotHits: number;
  clicks: number;
  impressions: number;
  position: number | null;
};

const CONVERSION_EVENTS = ["form_submit", "booking_complete", "lead_created", "lead_qualified", "customer_created", "whatsapp_click", "phone_click", "email_click"];

/** Joins on-page analytics, Search Console, and attributed conversions for every live page. */
export async function getPagePerformance(
  db: D1Like,
  input: { siteId: string; origin: string; sinceDay: string },
): Promise<PagePerformanceRow[]> {
  const conversionList = CONVERSION_EVENTS.map(() => "?").join(",");
  const { results } = await db.prepare(
    `SELECT p.id, p.template_id, p.path, p.title, p.published_at,
       COALESCE(m.views, 0) AS views, COALESCE(m.cta_clicks, 0) AS cta_clicks,
       COALESCE(m.googlebot_hits, 0) AS googlebot_hits,
       COALESCE(a.attributed, 0) AS attributed,
       COALESCE(g.clicks, 0) AS clicks, COALESCE(g.impressions, 0) AS impressions, g.position AS position
     FROM generated_pages p
     LEFT JOIN (
       SELECT page_id, SUM(views) AS views, SUM(cta_clicks) AS cta_clicks, SUM(googlebot_hits) AS googlebot_hits
       FROM page_metrics_daily WHERE site_id = ? AND day >= ? GROUP BY page_id
     ) m ON m.page_id = p.id
     LEFT JOIN (
       SELECT ps.page_id, COUNT(*) AS attributed FROM conversion_events ce
       JOIN page_sessions ps ON ps.session_id = ce.session_id
       WHERE ce.site_id = ? AND ce.occurred_at >= ? AND ce.event IN (${conversionList})
       GROUP BY ps.page_id
     ) a ON a.page_id = p.id
     LEFT JOIN (
       SELECT page_url, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
         SUM(position * impressions) / MAX(SUM(impressions), 1) AS position
       FROM page_search_metrics WHERE site_id = ? GROUP BY page_url
     ) g ON g.page_url = ? || p.path
     WHERE p.site_id = ? AND p.status = 'published'`,
  ).bind(
    input.siteId, input.sinceDay, input.siteId, input.sinceDay, ...CONVERSION_EVENTS,
    input.siteId, input.origin, input.siteId,
  ).all<Row>();
  return results.map((row) => ({
    pageId: String(row.id),
    templateId: String(row.template_id),
    path: String(row.path),
    title: String(row.title),
    publishedAt: optional(row.published_at),
    views: Number(row.views),
    ctaClicks: Number(row.cta_clicks),
    conversions: Number(row.attributed),
    googlebotHits: Number(row.googlebot_hits),
    clicks: Number(row.clicks),
    impressions: Number(row.impressions),
    position: row.position == null ? null : Number(row.position),
  }));
}

export async function listPageQueries(db: D1Like, siteId: string, limit = 5000): Promise<Array<{
  pageUrl: string; query: string; clicks: number; impressions: number; position: number;
}>> {
  const { results } = await db.prepare(
    "SELECT page_url, query, clicks, impressions, position FROM page_search_metrics WHERE site_id = ? ORDER BY impressions DESC LIMIT ?",
  ).bind(siteId, limit).all<Row>();
  return results.map((row) => ({
    pageUrl: String(row.page_url), query: String(row.query), clicks: Number(row.clicks),
    impressions: Number(row.impressions), position: Number(row.position),
  }));
}

export async function getDailyTotals(db: D1Like, siteId: string, sinceDay: string): Promise<Array<{
  day: string; views: number; ctaClicks: number; googlebotHits: number; searchClicks: number; searchImpressions: number;
}>> {
  const { results } = await db.prepare(
    `SELECT day, SUM(views) AS views, SUM(cta_clicks) AS cta_clicks, SUM(googlebot_hits) AS googlebot_hits,
       SUM(search_clicks) AS search_clicks, SUM(search_impressions) AS search_impressions
     FROM page_metrics_daily WHERE site_id = ? AND day >= ? GROUP BY day ORDER BY day`,
  ).bind(siteId, sinceDay).all<Row>();
  return results.map((row) => ({
    day: String(row.day), views: Number(row.views), ctaClicks: Number(row.cta_clicks), googlebotHits: Number(row.googlebot_hits),
    searchClicks: Number(row.search_clicks), searchImpressions: Number(row.search_impressions),
  }));
}
