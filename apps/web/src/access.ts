import type { D1Like, WorkspaceRole } from "@organic-growth/db";

export type Need = "read" | "write" | "admin";

/** Owners do anything; members everything but workspace administration; clients only read. */
export function allows(role: WorkspaceRole, need: Need): boolean {
  if (role === "owner") return true;
  if (role === "member") return need !== "admin";
  return need === "read";
}

/** Every table a route can name a row of by ID; each carries its site. */
const OWNER_TABLES = {
  analysis: "analyses",
  change: "changes",
  job: "jobs",
  record: "data_records",
  dataset: "datasets",
  source: "data_sources",
  template: "page_templates",
  page: "generated_pages",
} as const;

export type OwnedKind = keyof typeof OWNER_TABLES;

export async function resolveSiteId(db: D1Like, kind: OwnedKind, id: string): Promise<string | null> {
  const row = await db.prepare(`SELECT site_id FROM ${OWNER_TABLES[kind]} WHERE id = ?`).bind(id).first<{ site_id: string }>();
  return row?.site_id ?? null;
}
