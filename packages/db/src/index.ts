import type {
  CompetitorProfile,
  Finding,
  FrameworkFingerprint,
  GrowthPlan,
  Opportunity,
  ProposedChange,
  SearchMetricRow,
  SiteRecord,
} from "@organic-growth/core";

export interface D1Like {
  prepare(query: string): {
    bind(...args: unknown[]): {
      run(): Promise<unknown>;
      first<T = unknown>(): Promise<T | null>;
      all<T = unknown>(): Promise<{ results: T[] }>;
    };
    run(): Promise<unknown>;
    first<T = unknown>(): Promise<T | null>;
    all<T = unknown>(): Promise<{ results: T[] }>;
  };
  batch?(statements: unknown[]): Promise<unknown>;
}

export function nowIso(): string {
  return new Date().toISOString();
}

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

export async function saveAnalysisReport(
  db: D1Like,
  id: string,
  report: unknown,
  summary: string,
): Promise<void> {
  await db.prepare("UPDATE analyses SET report_json = ?, summary = ?, status = 'completed', completed_at = ? WHERE id = ?")
    .bind(JSON.stringify(report), summary, new Date().toISOString(), id).run();
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
  for (const row of rows) {
    const id = `sm_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO search_metrics (
          id, site_id, analysis_id, query, page, country, device,
          impressions, clicks, ctr, position, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
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
        new Date().toISOString(),
      )
      .run();
  }
}

export async function listSearchMetrics(
  db: D1Like,
  siteId: string,
): Promise<SearchMetricRow[]> {
  const { results } = await db
    .prepare(
      `SELECT query, page, country, device, impressions, clicks, ctr, position
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

export * from "./memory-store.js";
