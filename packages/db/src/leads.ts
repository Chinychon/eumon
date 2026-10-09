import type { LeadStatus, PageTypeOutcome } from "@organic-growth/core";
import { nowIso, type D1Like } from "./d1.js";

/*
 * Enquiries and what became of them. A WhatsApp click with a reference code
 * starts a lead; staff match the chat by its code and move it on. Each stage
 * keeps the moment it was reached, so outcomes count on the day they happened,
 * and the landing page comes from the session the click carried.
 */

export type Lead = {
  id: string;
  ref: string | null;
  channel: string;
  status: LeadStatus;
  sessionId: string | null;
  pageUrl: string | null;
  placement: string | null;
  value: number | null;
  note: string | null;
  clickedAt: string | null;
  chatAt: string | null;
  qualifiedAt: string | null;
  wonAt: string | null;
  lostAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** The Eumon page the visitor first landed on, and where they came from; null when they never landed on one. */
  landing: { path: string; template: string | null; source: string | null } | null;
};

type Row = Record<string, unknown>;
const text = (value: unknown) => (value == null ? null : String(value));

const SELECT = `SELECT l.*, g.path AS landing_path, t.name AS landing_template, s.source AS landing_source, s.page_id AS landing_page
  FROM leads l
  LEFT JOIN page_sessions s ON s.site_id = l.site_id AND s.session_id = l.session_id
  LEFT JOIN generated_pages g ON g.id = s.page_id
  LEFT JOIN page_templates t ON t.id = g.template_id`;

function mapLead(row: Row): Lead {
  return {
    id: String(row.id), ref: text(row.ref), channel: String(row.channel), status: String(row.status) as LeadStatus,
    sessionId: text(row.session_id), pageUrl: text(row.page_url), placement: text(row.placement),
    value: row.value == null ? null : Number(row.value), note: text(row.note),
    clickedAt: text(row.clicked_at), chatAt: text(row.chat_at), qualifiedAt: text(row.qualified_at), wonAt: text(row.won_at), lostAt: text(row.lost_at),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    landing: row.landing_page ? { path: text(row.landing_path) ?? "(a removed page)", template: text(row.landing_template), source: text(row.landing_source) } : null,
  };
}

/** Starts a lead for a WhatsApp click that carried a code. A code seen before is ignored: the first click wins. */
export async function recordLeadClick(db: D1Like, input: { id: string; siteId: string; ref: string; sessionId?: string; pageUrl?: string; placement?: string; at: string }): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO leads (id, site_id, ref, channel, status, session_id, page_url, placement, clicked_at, created_at, updated_at)
     VALUES (?, ?, ?, 'whatsapp', 'clicked', ?, ?, ?, ?, ?, ?)`,
  ).bind(input.id, input.siteId, input.ref, input.sessionId ?? null, input.pageUrl ?? null, input.placement ?? null, input.at, input.at, input.at).run();
}

/** An enquiry without a code (a call, a walk-in, a chat that lost its code), entered by hand. */
export async function createLead(db: D1Like, input: { id: string; siteId: string; channel: string; note?: string; at: string }): Promise<void> {
  await db.prepare(
    `INSERT INTO leads (id, site_id, channel, status, note, chat_at, created_at, updated_at) VALUES (?, ?, ?, 'chat', ?, ?, ?, ?)`,
  ).bind(input.id, input.siteId, input.channel, input.note ?? null, input.at, input.at, input.at).run();
}

export async function getLead(db: D1Like, siteId: string, id: string): Promise<Lead | null> {
  const row = await db.prepare(`${SELECT} WHERE l.site_id = ? AND l.id = ?`).bind(siteId, id).first<Row>();
  return row ? mapLead(row) : null;
}

export async function getLeadByRef(db: D1Like, siteId: string, ref: string): Promise<Lead | null> {
  const row = await db.prepare(`${SELECT} WHERE l.site_id = ? AND l.ref = ?`).bind(siteId, ref).first<Row>();
  return row ? mapLead(row) : null;
}

/** The latest leads, newest first; `open` leaves out lost leads and customers. */
export async function listLeads(db: D1Like, siteId: string, options: { limit?: number; open?: boolean } = {}): Promise<Lead[]> {
  const { results } = await db.prepare(
    `${SELECT} WHERE l.site_id = ? ${options.open ? "AND l.status NOT IN ('won', 'lost')" : ""} ORDER BY l.created_at DESC LIMIT ?`,
  ).bind(siteId, options.limit ?? 50).all<Row>();
  return results.map(mapLead);
}

/** The stages in order; a lead at a stage has passed every one before it. */
const STAGES: Array<{ status: LeadStatus; column: string }> = [
  { status: "chat", column: "chat_at" }, { status: "qualified", column: "qualified_at" }, { status: "won", column: "won_at" },
];

/**
 * Moves a lead to a status. Reaching a stage fills in any stage before it not
 * yet reached (a customer was a chat first); moving back clears the stages
 * after it, so counts always follow the current status. `lost` keeps the
 * stages reached and records when it was lost.
 */
export async function updateLead(db: D1Like, siteId: string, id: string, input: { status?: LeadStatus; value?: number | null; note?: string | null; at?: string }): Promise<void> {
  const at = input.at ?? nowIso();
  const sets: string[] = ["updated_at = ?"];
  const args: unknown[] = [at];
  if (input.status) {
    sets.push("status = ?");
    args.push(input.status);
    if (input.status === "lost") {
      sets.push("lost_at = COALESCE(lost_at, ?)");
      args.push(at);
    } else {
      sets.push("lost_at = NULL");
      const reached = STAGES.findIndex((stage) => stage.status === input.status);
      STAGES.forEach((stage, index) => {
        if (index <= reached) { sets.push(`${stage.column} = COALESCE(${stage.column}, ?)`); args.push(at); }
        else sets.push(`${stage.column} = NULL`);
      });
    }
  }
  if (input.value !== undefined) { sets.push("value = ?"); args.push(input.value); }
  if (input.note !== undefined) { sets.push("note = ?"); args.push(input.note); }
  await db.prepare(`UPDATE leads SET ${sets.join(", ")} WHERE site_id = ? AND id = ?`).bind(...args, siteId, id).run();
}

/** Per day: WhatsApp clicks with a code, chats matched, leads qualified, customers won and their value. */
export async function dailyLeadOutcomes(db: D1Like, siteId: string, sinceDay: string): Promise<Array<{ day: string; clicks: number; chats: number; qualified: number; won: number; revenue: number }>> {
  const { results } = await db.prepare(
    `WITH events AS (
       SELECT substr(clicked_at, 1, 10) AS day, 1 AS clicks, 0 AS chats, 0 AS qualified, 0 AS won, 0 AS revenue FROM leads WHERE site_id = ?1 AND clicked_at >= ?2
       UNION ALL SELECT substr(chat_at, 1, 10), 0, 1, 0, 0, 0 FROM leads WHERE site_id = ?1 AND chat_at >= ?2
       UNION ALL SELECT substr(qualified_at, 1, 10), 0, 0, 1, 0, 0 FROM leads WHERE site_id = ?1 AND qualified_at >= ?2
       UNION ALL SELECT substr(won_at, 1, 10), 0, 0, 0, 1, COALESCE(value, 0) FROM leads WHERE site_id = ?1 AND won_at >= ?2
     )
     SELECT day, SUM(clicks) AS clicks, SUM(chats) AS chats, SUM(qualified) AS qualified, SUM(won) AS won, SUM(revenue) AS revenue
     FROM events GROUP BY day ORDER BY day`,
  ).bind(siteId, sinceDay).all<Row>();
  return results.map((row) => ({ day: String(row.day), clicks: Number(row.clicks), chats: Number(row.chats), qualified: Number(row.qualified), won: Number(row.won), revenue: Number(row.revenue) }));
}

/**
 * Leads started on or after `since`, by the kind of Eumon page the visitor
 * first landed on (its template), counted by how far each has got. Visitors
 * who never landed on an Eumon page are "Rest of the site".
 */
export async function outcomesByPageType(db: D1Like, siteId: string, since: string): Promise<PageTypeOutcome[]> {
  const { results } = await db.prepare(
    `SELECT COALESCE(t.name, CASE WHEN s.page_id IS NULL THEN 'Rest of the site' ELSE 'Removed pages' END) AS page_type,
            COUNT(*) AS leads,
            SUM(CASE WHEN l.chat_at IS NOT NULL THEN 1 ELSE 0 END) AS chats,
            SUM(CASE WHEN l.qualified_at IS NOT NULL THEN 1 ELSE 0 END) AS qualified,
            SUM(CASE WHEN l.won_at IS NOT NULL THEN 1 ELSE 0 END) AS won,
            SUM(CASE WHEN l.won_at IS NOT NULL THEN COALESCE(l.value, 0) ELSE 0 END) AS revenue
     FROM leads l
     LEFT JOIN page_sessions s ON s.site_id = l.site_id AND s.session_id = l.session_id
     LEFT JOIN generated_pages g ON g.id = s.page_id
     LEFT JOIN page_templates t ON t.id = g.template_id
     WHERE l.site_id = ? AND l.created_at >= ?
     GROUP BY page_type ORDER BY revenue DESC, won DESC, leads DESC`,
  ).bind(siteId, since).all<Row>();
  return results.map((row) => ({ pageType: String(row.page_type), leads: Number(row.leads), chats: Number(row.chats), qualified: Number(row.qualified), won: Number(row.won), revenue: Number(row.revenue) }));
}
