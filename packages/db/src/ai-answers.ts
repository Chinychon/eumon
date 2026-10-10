import type { AiAnswerCheck, AiAnswerEngine } from "@organic-growth/core";
import { chunks, runStatements, type D1Like } from "./d1.js";

/*
 * AI answer tracking: the questions (`ai_prompts`), the names the brand goes
 * by (`ai_brand_names`), and one row per question, market, engine and day
 * (`ai_answer_checks`). Answers aren't kept, only what was read from them.
 */

/** Replaces the list; `created_at` is spaced a millisecond apart so the given order is the listed order. */
export async function setAiPrompts(db: D1Like, siteId: string, prompts: string[]): Promise<void> {
  const base = Date.now();
  await runStatements(db, [
    db.prepare("DELETE FROM ai_prompts WHERE site_id = ?").bind(siteId),
    ...prompts.map((prompt, index) => db.prepare("INSERT INTO ai_prompts (site_id, prompt, created_at) VALUES (?, ?, ?)").bind(siteId, prompt, new Date(base + index).toISOString())),
  ]);
}

export async function listAiPrompts(db: D1Like, siteId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT prompt FROM ai_prompts WHERE site_id = ? ORDER BY created_at, prompt").bind(siteId).all<{ prompt: string }>();
  return results.map((row) => row.prompt);
}

export async function setAiBrandNames(db: D1Like, siteId: string, names: string[]): Promise<void> {
  await runStatements(db, [
    db.prepare("DELETE FROM ai_brand_names WHERE site_id = ?").bind(siteId),
    ...names.map((name) => db.prepare("INSERT INTO ai_brand_names (site_id, name) VALUES (?, ?)").bind(siteId, name)),
  ]);
}

export async function listAiBrandNames(db: D1Like, siteId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT name FROM ai_brand_names WHERE site_id = ? ORDER BY rowid").bind(siteId).all<{ name: string }>();
  return results.map((row) => row.name);
}

/** One row per question, market, engine and day; a day saved twice keeps the later values. */
export async function saveAiAnswerChecks(db: D1Like, siteId: string, rows: AiAnswerCheck[]): Promise<void> {
  const statements = rows.map((row) => db.prepare(
    `INSERT INTO ai_answer_checks (site_id, prompt, market, engine, day, mentioned, cited, cited_rank, sources_json, rivals_json, excerpt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id, prompt, market, engine, day) DO UPDATE SET mentioned = excluded.mentioned, cited = excluded.cited, cited_rank = excluded.cited_rank,
       sources_json = excluded.sources_json, rivals_json = excluded.rivals_json, excerpt = excluded.excerpt`,
  ).bind(siteId, row.prompt, row.market, row.engine, row.day, row.mentioned ? 1 : 0, row.cited ? 1 : 0, row.citedRank, JSON.stringify(row.sources), JSON.stringify(row.rivals), row.excerpt));
  for (const group of chunks(statements, 100)) await runStatements(db, group);
}

type CheckRow = { prompt: string; market: string; engine: string; day: string; mentioned: number; cited: number; cited_rank: number | null; sources_json: string; rivals_json: string; excerpt: string };

/** Checks from `fromDay` on, oldest first. */
export async function listAiAnswerChecks(db: D1Like, siteId: string, fromDay: string): Promise<AiAnswerCheck[]> {
  const { results } = await db.prepare(
    "SELECT prompt, market, engine, day, mentioned, cited, cited_rank, sources_json, rivals_json, excerpt FROM ai_answer_checks WHERE site_id = ? AND day >= ? ORDER BY day, prompt, market, engine",
  ).bind(siteId, fromDay).all<CheckRow>();
  return results.map((row) => ({
    prompt: row.prompt, market: row.market, engine: row.engine as AiAnswerEngine, day: row.day,
    mentioned: Boolean(row.mentioned), cited: Boolean(row.cited), citedRank: row.cited_rank === null ? null : Number(row.cited_rank),
    sources: JSON.parse(row.sources_json), rivals: JSON.parse(row.rivals_json), excerpt: row.excerpt,
  }));
}

/** Each (prompt, market, engine)'s latest checked day, keyed `prompt|market|engine`, in one query, for deciding what is due. */
export async function aiLastChecked(db: D1Like, siteId: string): Promise<Map<string, string>> {
  const { results } = await db.prepare("SELECT prompt, market, engine, MAX(day) AS day FROM ai_answer_checks WHERE site_id = ? GROUP BY prompt, market, engine")
    .bind(siteId).all<{ prompt: string; market: string; engine: string; day: string }>();
  return new Map(results.map((row) => [`${row.prompt}|${row.market}|${row.engine}`, row.day]));
}

export async function pruneAiAnswerChecks(db: D1Like, siteId: string, beforeDay: string): Promise<void> {
  await db.prepare("DELETE FROM ai_answer_checks WHERE site_id = ? AND day < ?").bind(siteId, beforeDay).run();
}
