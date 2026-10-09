import { nowIso, runStatements, type D1Like } from "./d1.js";

export type AssistantThread = { id: string; siteId: string; title: string; createdAt: string; updatedAt: string };
export type AssistantMessageRecord = { id: string; threadId: string; role: "user" | "assistant"; content: unknown; createdAt: string };

const thread = (row: Record<string, unknown>): AssistantThread => ({
  id: String(row.id), siteId: String(row.site_id), title: String(row.title), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
});

export async function createAssistantThread(db: D1Like, input: { id: string; siteId: string; title: string }): Promise<AssistantThread> {
  const at = nowIso();
  await db.prepare("INSERT INTO assistant_threads (id, site_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(input.id, input.siteId, input.title, at, at).run();
  return { id: input.id, siteId: input.siteId, title: input.title, createdAt: at, updatedAt: at };
}

/** A site's conversations, most recently active first. */
export async function listAssistantThreads(db: D1Like, siteId: string, limit = 30): Promise<AssistantThread[]> {
  const { results } = await db.prepare("SELECT * FROM assistant_threads WHERE site_id = ? ORDER BY updated_at DESC LIMIT ?")
    .bind(siteId, limit).all<Record<string, unknown>>();
  return results.map(thread);
}

/** One conversation, only if it belongs to the site: thread ids from the client are never trusted alone. */
export async function getAssistantThread(db: D1Like, siteId: string, threadId: string): Promise<AssistantThread | null> {
  const row = await db.prepare("SELECT * FROM assistant_threads WHERE id = ? AND site_id = ?").bind(threadId, siteId).first<Record<string, unknown>>();
  return row ? thread(row) : null;
}

export async function listAssistantMessages(db: D1Like, threadId: string): Promise<AssistantMessageRecord[]> {
  const { results } = await db.prepare("SELECT * FROM assistant_messages WHERE thread_id = ? ORDER BY created_at, rowid")
    .bind(threadId).all<Record<string, unknown>>();
  return results.map((row) => {
    let content: unknown = null;
    try { content = JSON.parse(String(row.content_json)); } catch { /* a malformed message stays listed, empty */ }
    return { id: String(row.id), threadId: String(row.thread_id), role: row.role === "user" ? "user" : "assistant", content, createdAt: String(row.created_at) };
  });
}

export async function appendAssistantMessage(
  db: D1Like,
  input: { id: string; threadId: string; role: "user" | "assistant"; content: unknown },
): Promise<void> {
  const at = nowIso();
  await runStatements(db, [
    db.prepare("INSERT INTO assistant_messages (id, thread_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(input.id, input.threadId, input.role, JSON.stringify(input.content), at),
    db.prepare("UPDATE assistant_threads SET updated_at = ? WHERE id = ?").bind(at, input.threadId),
  ]);
}

export async function deleteAssistantThread(db: D1Like, siteId: string, threadId: string): Promise<void> {
  await runStatements(db, [
    db.prepare("DELETE FROM assistant_messages WHERE thread_id IN (SELECT id FROM assistant_threads WHERE id = ? AND site_id = ?)").bind(threadId, siteId),
    db.prepare("DELETE FROM assistant_threads WHERE id = ? AND site_id = ?").bind(threadId, siteId),
  ]);
}

/** Conversion events per day and event name since `since` (an ISO time), oldest first. */
export async function conversionCounts(db: D1Like, siteId: string, since: string): Promise<Array<{ day: string; event: string; count: number }>> {
  const { results } = await db.prepare(
    `SELECT substr(occurred_at, 1, 10) AS day, event, COUNT(*) AS n FROM conversion_events
     WHERE site_id = ? AND occurred_at >= ? GROUP BY day, event ORDER BY day, event`,
  ).bind(siteId, since).all<{ day: string; event: string; n: number }>();
  return results.map((row) => ({ day: String(row.day), event: String(row.event), count: Number(row.n) }));
}
