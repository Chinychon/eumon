import { env } from "cloudflare:workers";
import type { SiteRecord } from "@organic-growth/core";
import { memberRole, siteForUser, type WorkspaceRole } from "@organic-growth/db";
import { allows, resolveSiteId, type Need, type OwnedKind } from "./access";
import { adminEmails, authFor, type AuthEnv } from "./auth";
import { fail } from "./server";

/*
 * Who is asking, and may they? Every API route calls one of these first.
 * The session comes from Better Auth's signed cookie cache, so most calls read nothing from D1.
 */

export type Viewer = { userId: string; email: string; emailVerified: boolean; workspaceId: string | null };
// ponytail: Task 10 declares the auth secrets on Env; drop this cast then.
const authEnv = env as unknown as AuthEnv;
type SiteAccess = { viewer: Viewer; site: SiteRecord; role: WorkspaceRole };

export async function viewer(request: Request): Promise<Viewer | null> {
  const session = await authFor(authEnv).api.getSession({ headers: request.headers });
  if (!session) return null;
  return {
    userId: session.user.id,
    email: session.user.email,
    emailVerified: session.user.emailVerified,
    workspaceId: (session.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null,
  };
}

export async function requireViewer(request: Request): Promise<Viewer | Response> {
  return (await viewer(request)) ?? fail("Sign in to continue.", 401);
}

/** A site the viewer can't see answers 404, the same as a missing one. */
export async function requireSite(request: Request, siteId: string, need: Need): Promise<SiteAccess | Response> {
  const who = await viewer(request);
  if (!who) return fail("Sign in to continue.", 401);
  const found = await siteForUser(env.DB, who.userId, siteId);
  if (!found) return fail("Site not found.", 404);
  if (!allows(found.role, need)) return fail("Your role in this workspace can't make this change.", 403);
  return { viewer: who, site: found.site, role: found.role };
}

export async function requireOwned(request: Request, kind: OwnedKind, id: string, need: Need): Promise<SiteAccess | Response> {
  const siteId = await resolveSiteId(env.DB, kind, id);
  if (!siteId) return fail("Not found.", 404);
  return requireSite(request, siteId, need);
}

/** The viewer's active workspace and their role in it. */
export async function requireWorkspace(request: Request, need: Need): Promise<{ viewer: Viewer & { workspaceId: string }; role: WorkspaceRole } | Response> {
  const who = await viewer(request);
  if (!who) return fail("Sign in to continue.", 401);
  if (!who.workspaceId) return fail("Choose a workspace first.", 409);
  const role = await memberRole(env.DB, who.workspaceId, who.userId);
  if (!role) return fail("You're no longer a member of this workspace. Sign in again.", 403);
  if (!allows(role, need)) return fail("Your role in this workspace can't make this change.", 403);
  return { viewer: { ...who, workspaceId: who.workspaceId }, role };
}

/** People listed in BOOTSTRAP_OWNER_EMAIL with a verified email: the /admin page. */
export async function requirePlatformAdmin(request: Request): Promise<Viewer | Response> {
  const who = await viewer(request);
  if (!who) return fail("Sign in to continue.", 401);
  if (!who.emailVerified || !adminEmails(authEnv).includes(who.email.toLowerCase())) return fail("Not found.", 404);
  return who;
}
