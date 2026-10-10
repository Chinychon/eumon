import type { SiteRecord } from "@organic-growth/core";
import { nowIso, type D1Like } from "./d1.js";
import { getSite } from "./index.js";

export type FixStatus = "staged" | "skipped" | "draft" | "ready" | "merged" | "failed" | "rejected" | "closed" | "reverted";
export type FixRecord = {
  id: string; siteId: string; analysisId: string; kind: string; route: string; filePath: string; fileSha?: string;
  title: string; reason: string; files: Record<string, string>; original: Record<string, string>; urls: string[]; problems: string[];
  snippet?: string; beforeSnippet?: string; afterSnippet?: string; promptSha?: string; warnings: string[]; score: number;
  status: FixStatus; prUrl?: string; prNumber?: number; branch?: string; headSha?: string; prNodeId?: string;
  previewUrl?: string; verification?: Record<string, unknown>; result?: string; createdAt: string; updatedAt: string;
};
export type FixSettings = { allowAiSearch: boolean; budget: number; autopilot: boolean };
export type PageHeadRow = { url: string; status: number; title?: string; description?: string; canonical?: string; hreflang: Array<{ lang: string; href: string }>; jsonLdTypes: string[]; heading?: string };

const opt = (value: unknown) => (value === null || value === undefined ? undefined : String(value));

function parse<T>(text: unknown, fallback: T): T {
  try {
    const value = JSON.parse(String(text ?? ""));
    return value === null || typeof value !== "object" ? fallback : (value as T);
  } catch {
    return fallback;
  }
}

function mapFix(row: Record<string, unknown>): FixRecord {
  const evidence = parse(row.evidence_json, {}) as { files?: Record<string, string>; original?: Record<string, string>; urls?: string[]; problems?: string[]; snippet?: string };
  return {
    id: String(row.id), siteId: String(row.site_id), analysisId: String(row.analysis_id), kind: String(row.fix_kind ?? ""), route: String(row.route ?? ""),
    filePath: String(row.file_path ?? ""), fileSha: opt(row.file_sha), title: String(row.title), reason: String(row.reason),
    files: evidence.files ?? {}, original: evidence.original ?? {}, urls: evidence.urls ?? [], problems: evidence.problems ?? [], snippet: evidence.snippet,
    beforeSnippet: opt(row.before_snippet), afterSnippet: opt(row.after_snippet), promptSha: opt(row.prompt_sha),
    warnings: parse<string[]>(row.warnings_json, []), score: Number(row.score ?? 0), status: String(row.status) as FixStatus,
    prUrl: opt(row.pr_url), prNumber: row.pr_number === null || row.pr_number === undefined ? undefined : Number(row.pr_number),
    branch: opt(row.branch), headSha: opt(row.head_sha), prNodeId: opt(row.pr_node_id), previewUrl: opt(row.preview_url),
    verification: row.verification_json ? parse<Record<string, unknown> | undefined>(row.verification_json, undefined) : undefined,
    result: opt(row.result), createdAt: String(row.created_at), updatedAt: String(row.updated_at ?? row.created_at),
  };
}

export async function stageFix(db: D1Like, fix: FixRecord): Promise<void> {
  await db.prepare(
    `INSERT INTO changes (id, site_id, analysis_id, title, reason, evidence_json, files_changed_json, pages_affected_json, patch, status, author, created_at,
       fix_kind, route, file_path, file_sha, before_snippet, after_snippet, prompt_sha, warnings_json, score, updated_at, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'eumon-fix-engine', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    fix.id, fix.siteId, fix.analysisId, fix.title, fix.reason,
    JSON.stringify({ files: fix.files, original: fix.original, urls: fix.urls, problems: fix.problems, snippet: fix.snippet }),
    JSON.stringify(Object.keys(fix.files)), JSON.stringify(fix.urls.slice(0, 50)), fix.afterSnippet ?? "", fix.status, fix.createdAt,
    fix.kind, fix.route, fix.filePath, fix.fileSha ?? null, fix.beforeSnippet ?? null, fix.afterSnippet ?? null, fix.promptSha ?? null,
    JSON.stringify(fix.warnings), fix.score, fix.updatedAt, fix.result ?? null,
  ).run();
}

export async function getFix(db: D1Like, id: string): Promise<FixRecord | null> {
  const row = await db.prepare("SELECT * FROM changes WHERE id = ? AND fix_kind IS NOT NULL").bind(id).first<Record<string, unknown>>();
  return row ? mapFix(row) : null;
}

export async function listFixes(db: D1Like, siteId: string, statuses?: FixStatus[]): Promise<FixRecord[]> {
  const filter = statuses?.length ? ` AND status IN (${statuses.map(() => "?").join(", ")})` : "";
  const { results } = await db.prepare(`SELECT * FROM changes WHERE site_id = ? AND fix_kind IS NOT NULL${filter} ORDER BY score DESC, created_at DESC LIMIT 200`)
    .bind(siteId, ...(statuses ?? [])).all<Record<string, unknown>>();
  return results.map(mapFix);
}

export async function listOpenFixes(db: D1Like, limit: number): Promise<FixRecord[]> {
  const { results } = await db.prepare("SELECT * FROM changes WHERE fix_kind IS NOT NULL AND status = 'draft' ORDER BY updated_at LIMIT ?").bind(limit).all<Record<string, unknown>>();
  return results.map(mapFix);
}

export async function findFixByPr(db: D1Like, siteId: string, prNumber: number): Promise<FixRecord | null> {
  const row = await db.prepare("SELECT * FROM changes WHERE site_id = ? AND pr_number = ? AND fix_kind IS NOT NULL").bind(siteId, prNumber).first<Record<string, unknown>>();
  return row ? mapFix(row) : null;
}

export async function findFixByHeadSha(db: D1Like, headSha: string, siteId: string): Promise<FixRecord | null> {
  const row = await db.prepare("SELECT * FROM changes WHERE head_sha = ? AND site_id = ? AND fix_kind IS NOT NULL").bind(headSha, siteId).first<Record<string, unknown>>();
  return row ? mapFix(row) : null;
}

export async function updateFix(db: D1Like, id: string, patch: Partial<Pick<FixRecord, "status" | "prUrl" | "prNumber" | "branch" | "headSha" | "prNodeId" | "previewUrl" | "verification" | "result">>): Promise<void> {
  const columns: Record<string, unknown> = {
    status: patch.status, pr_url: patch.prUrl, pr_number: patch.prNumber, branch: patch.branch, head_sha: patch.headSha, pr_node_id: patch.prNodeId,
    preview_url: patch.previewUrl, verification_json: patch.verification ? JSON.stringify(patch.verification) : undefined, result: patch.result,
  };
  const set = Object.entries(columns).filter(([, v]) => v !== undefined);
  await db.prepare(`UPDATE changes SET ${[...set.map(([k]) => `${k} = ?`), "updated_at = ?"].join(", ")} WHERE id = ?`)
    .bind(...set.map(([, v]) => v), nowIso(), id).run();
}

export async function hasLiveFix(db: D1Like, siteId: string, route: string, kind: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS yes FROM changes WHERE site_id = ? AND route = ? AND fix_kind = ? AND status IN ('staged', 'draft', 'ready', 'rejected') LIMIT 1")
    .bind(siteId, route, kind).first();
  return Boolean(row);
}

export async function countOpenFixes(db: D1Like, siteId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM changes WHERE site_id = ? AND fix_kind IS NOT NULL AND status IN ('draft', 'ready')").bind(siteId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function getFixSettings(db: D1Like, siteId: string): Promise<FixSettings> {
  const row = await db.prepare("SELECT allow_ai_search, fix_budget, autopilot FROM site_fix_settings WHERE site_id = ?").bind(siteId).first<{ allow_ai_search: number; fix_budget: number; autopilot: number }>();
  return row ? { allowAiSearch: Number(row.allow_ai_search) === 1, budget: Number(row.fix_budget), autopilot: Number(row.autopilot) === 1 } : { allowAiSearch: false, budget: 3, autopilot: true };
}

export async function setFixSettings(db: D1Like, siteId: string, settings: FixSettings): Promise<void> {
  await db.prepare(`INSERT INTO site_fix_settings (site_id, allow_ai_search, fix_budget, autopilot) VALUES (?, ?, ?, ?)
    ON CONFLICT (site_id) DO UPDATE SET allow_ai_search = excluded.allow_ai_search, fix_budget = excluded.fix_budget, autopilot = excluded.autopilot`)
    .bind(siteId, settings.allowAiSearch ? 1 : 0, Math.min(5, Math.max(1, Math.round(settings.budget))), settings.autopilot ? 1 : 0).run();
}

export async function listPageHeads(db: D1Like, analysisId: string): Promise<PageHeadRow[]> {
  const { results } = await db.prepare("SELECT url, status, title, result_json FROM pages WHERE analysis_id = ? AND crawl_state = 'complete'").bind(analysisId)
    .all<{ url: string; status: number; title: string | null; result_json: string | null }>();
  return results.map((row) => {
    const r = JSON.parse(row.result_json ?? "{}") as { description?: string; canonical?: string; hreflang?: Array<{ lang: string; href: string }>; jsonLdTypes?: string[]; headingOutline?: string[] };
    const h1 = r.headingOutline?.find((h) => h.startsWith("h1:"))?.slice(3);
    return {
      url: row.url, status: Number(row.status), ...(row.title ? { title: row.title } : {}), ...(r.description ? { description: r.description } : {}),
      ...(r.canonical ? { canonical: r.canonical } : {}), hreflang: r.hreflang ?? [], jsonLdTypes: r.jsonLdTypes ?? [], ...(h1 ? { heading: h1 } : {}),
    };
  });
}

export async function findSitesByRepo(db: D1Like, owner: string, repo: string): Promise<SiteRecord[]> {
  const { results } = await db.prepare("SELECT id FROM sites WHERE lower(github_owner) = lower(?) AND lower(github_repo) = lower(?) ORDER BY created_at, id").bind(owner, repo).all<{ id: string }>();
  const sites = await Promise.all(results.map((row) => getSite(db, row.id)));
  return sites.filter((site): site is SiteRecord => site !== null);
}
