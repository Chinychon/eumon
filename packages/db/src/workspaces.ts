import { createId } from "@organic-growth/core";
import { nowIso, type D1Like } from "./d1.js";
import type { WorkspaceRole } from "./index.js";

/*
 * Workspaces are Better Auth organizations; this module reads and writes their
 * tables directly where Eumon needs more than Better Auth's API gives:
 * setting up new users, client site grants, limits, usage, and GitHub installations.
 */

export const INITIAL_WORKSPACE_ID = "ws_initial";

const isAdmin = (email: string, adminEmails: string[]) => adminEmails.includes(email.trim().toLowerCase());

export async function memberRole(db: D1Like, workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const row = await db.prepare(`SELECT role FROM member WHERE organizationId = ? AND userId = ?`).bind(workspaceId, userId).first<{ role: string }>();
  return row && ["owner", "member", "client"].includes(row.role) ? row.role as WorkspaceRole : null;
}

async function addMember(db: D1Like, workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
  await db.prepare(
    `INSERT INTO member (id, organizationId, userId, role, createdAt)
     SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM member WHERE organizationId = ? AND userId = ?)`,
  ).bind(createId("mem"), workspaceId, userId, role, nowIso(), workspaceId, userId).run();
}

/**
 * Runs once when Better Auth creates a user. A listed admin with a verified email
 * joins the initial workspace as owner; anyone else gets a workspace of their own,
 * unless an invitation is waiting for their email (they join that one instead).
 */
export async function setUpNewUser(db: D1Like, user: { id: string; name: string; email: string; emailVerified: boolean }, adminEmails: string[]): Promise<void> {
  if (user.emailVerified && isAdmin(user.email, adminEmails)) {
    await addMember(db, INITIAL_WORKSPACE_ID, user.id, "owner");
    return;
  }
  if (await hasLiveInvitation(db, user.email)) return;
  await createPersonalWorkspace(db, user);
}

/** Better Auth stores expiresAt as an ISO string, which sorts like time. */
async function hasLiveInvitation(db: D1Like, email: string): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 AS yes FROM invitation WHERE lower(email) = lower(?) AND status = 'pending' AND expiresAt > ? LIMIT 1`).bind(email, nowIso()).first());
}

async function createPersonalWorkspace(db: D1Like, user: { id: string; name: string; email: string }): Promise<string> {
  const id = createId("ws");
  const name = `${(user.name || user.email.split("@")[0] || "My").trim().slice(0, 60)}'s workspace`;
  await db.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)`).bind(id, name, id, nowIso()).run();
  await addMember(db, id, user.id, "owner");
  return id;
}

/** The workspace a new session opens in: the initial one for admins (joining it if the list grew since sign-up), else the user's first. */
export async function workspaceForNewSession(db: D1Like, userId: string, adminEmails: string[]): Promise<string | null> {
  const user = await db.prepare(`SELECT name, email, emailVerified FROM "user" WHERE id = ?`).bind(userId).first<{ name: string; email: string; emailVerified: number }>();
  if (user && Number(user.emailVerified) === 1 && isAdmin(user.email, adminEmails)) {
    await addMember(db, INITIAL_WORKSPACE_ID, userId, "owner");
    return INITIAL_WORKSPACE_ID;
  }
  const row = await db.prepare(`SELECT organizationId FROM member WHERE userId = ? ORDER BY createdAt LIMIT 1`).bind(userId).first<{ organizationId: string }>();
  if (row) return row.organizationId;
  // Nobody is left without a workspace, unless an invitation is waiting for them.
  if (!user || (await hasLiveInvitation(db, user.email))) return null;
  return createPersonalWorkspace(db, { id: userId, ...user });
}

/** A removed member's client grants must not outlive their membership. */
export async function revokeWorkspaceSiteAccess(db: D1Like, workspaceId: string, userId: string): Promise<void> {
  await db.prepare(`DELETE FROM site_access WHERE user_id = ? AND site_id IN (SELECT id FROM sites WHERE workspace_id = ?)`).bind(userId, workspaceId).run();
}

export async function addSiteInvites(db: D1Like, invitationId: string, siteIds: string[]): Promise<void> {
  for (const siteId of siteIds) {
    await db.prepare(`INSERT OR IGNORE INTO site_access_invites (invitation_id, site_id) VALUES (?, ?)`).bind(invitationId, siteId).run();
  }
}

export async function grantInvitedSites(db: D1Like, invitationId: string, userId: string): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO site_access (user_id, site_id, created_at) SELECT ?, site_id, ? FROM site_access_invites WHERE invitation_id = ?`,
  ).bind(userId, nowIso(), invitationId).run();
}

/** Whether the user owns a workspace already; being a Member or Client of others doesn't count. */
export async function ownsWorkspace(db: D1Like, userId: string): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 AS yes FROM member WHERE userId = ? AND role = 'owner' LIMIT 1`).bind(userId).first());
}

/** Members (any role) plus invitations still pending: what the members limit counts. */
export async function memberSlotsUsed(db: D1Like, workspaceId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM member WHERE organizationId = ?) + (SELECT COUNT(*) FROM invitation WHERE organizationId = ? AND status = 'pending') AS n`,
  ).bind(workspaceId, workspaceId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * Adds `amount` to today's counter unless that would pass `limit` (null: no limit).
 * One upsert: the conflict branch only updates while the total stays within the limit,
 * and RETURNING yields no row when it doesn't.
 */
export async function chargeUsage(db: D1Like, input: { workspaceId: string; day: string; metric: string; amount: number; limit: number | null }): Promise<boolean> {
  const limit = input.limit ?? Number.MAX_SAFE_INTEGER;
  if (input.amount > limit) return false;
  const row = await db.prepare(
    `INSERT INTO workspace_usage (workspace_id, day, metric, count) VALUES (?, ?, ?, ?)
     ON CONFLICT (workspace_id, day, metric) DO UPDATE SET count = count + excluded.count WHERE count + excluded.count <= ?
     RETURNING count`,
  ).bind(input.workspaceId, input.day, input.metric, input.amount, limit).first<{ count: number }>();
  return Boolean(row);
}

/** Gives back an amount charged for an action that then didn't run. */
export async function refundUsage(db: D1Like, input: { workspaceId: string; day: string; metric: string; amount: number }): Promise<void> {
  await db.prepare(`UPDATE workspace_usage SET count = MAX(count - ?, 0) WHERE workspace_id = ? AND day = ? AND metric = ?`)
    .bind(input.amount, input.workspaceId, input.day, input.metric).run();
}

export async function getLimitOverrides(db: D1Like, workspaceId: string): Promise<Record<string, unknown>> {
  const row = await db.prepare(`SELECT limits_json FROM workspace_limits WHERE workspace_id = ?`).bind(workspaceId).first<{ limits_json: string }>();
  return row ? JSON.parse(row.limits_json) as Record<string, unknown> : {};
}

export async function setLimitOverrides(db: D1Like, workspaceId: string, overrides: Record<string, unknown>): Promise<void> {
  await db.prepare(
    `INSERT INTO workspace_limits (workspace_id, limits_json) VALUES (?, ?) ON CONFLICT (workspace_id) DO UPDATE SET limits_json = excluded.limits_json`,
  ).bind(workspaceId, JSON.stringify(overrides)).run();
}

export async function listWorkspacesForAdmin(db: D1Like, day: string): Promise<Array<{ id: string; name: string; createdAt: string; sites: number; members: number; usage: Record<string, number>; overrides: Record<string, unknown> }>> {
  const { results } = await db.prepare(
    `SELECT o.id, o.name, o.createdAt,
       (SELECT COUNT(*) FROM sites s WHERE s.workspace_id = o.id) AS sites,
       (SELECT COUNT(*) FROM member m WHERE m.organizationId = o.id) AS members,
       (SELECT limits_json FROM workspace_limits l WHERE l.workspace_id = o.id) AS limits_json
     FROM organization o ORDER BY o.createdAt DESC`,
  ).all<{ id: string; name: string; createdAt: string; sites: number; members: number; limits_json: string | null }>();
  const { results: usage } = await db.prepare(`SELECT workspace_id, metric, count FROM workspace_usage WHERE day = ?`).bind(day).all<{ workspace_id: string; metric: string; count: number }>();
  return results.map((row) => ({
    id: row.id, name: row.name, createdAt: String(row.createdAt), sites: Number(row.sites), members: Number(row.members),
    usage: Object.fromEntries(usage.filter((u) => u.workspace_id === row.id).map((u) => [u.metric, Number(u.count)])),
    overrides: row.limits_json ? JSON.parse(row.limits_json) as Record<string, unknown> : {},
  }));
}

export async function addGithubInstallation(db: D1Like, workspaceId: string, installationId: string): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO workspace_github_installations (workspace_id, installation_id, created_at) VALUES (?, ?, ?)`).bind(workspaceId, installationId, nowIso()).run();
}

export async function listGithubInstallations(db: D1Like, workspaceId: string): Promise<string[]> {
  const { results } = await db.prepare(`SELECT installation_id FROM workspace_github_installations WHERE workspace_id = ? ORDER BY created_at`).bind(workspaceId).all<{ installation_id: string }>();
  return results.map((row) => row.installation_id);
}
