import { env } from "cloudflare:workers";
import { addSiteInvites, listSitesForUser } from "@organic-growth/db";
import { authFor } from "../../../../src/auth";
import { requireWorkspace } from "../../../../src/guard";
import { fail, json, readJson } from "../../../../src/server";

/**
 * Invites someone to the active workspace (owners only). A Client invitation names
 * the sites it grants. The link is returned so it can be shared by hand while email is off.
 */
export async function POST(request: Request) {
  const access = await requireWorkspace(request, "admin");
  if (access instanceof Response) return access;
  const body = await readJson<{ email?: unknown; role?: unknown; siteIds?: unknown }>(request);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter the email address to invite.");
  const role = body?.role === "client" ? "client" : body?.role === "member" ? "member" : null;
  if (!role) return fail("Choose Member or Client.");
  const own = new Set((await listSitesForUser(env.DB, access.viewer.userId, access.viewer.workspaceId)).map((site) => site.id));
  const siteIds = Array.isArray(body?.siteIds) ? body.siteIds.filter((id): id is string => typeof id === "string" && own.has(id)) : [];
  if (role === "client" && !siteIds.length) return fail("Choose at least one site the client can see.");
  try {
    const invitation = await authFor(env).api.createInvitation({ body: { email, role, organizationId: access.viewer.workspaceId }, headers: request.headers });
    if (role === "client") await addSiteInvites(env.DB, invitation.id, siteIds);
    return json({ invitationId: invitation.id, link: `${new URL(request.url).origin}/invite/${invitation.id}` }, 201);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not create the invitation.", 400);
  }
}
