import { env } from "cloudflare:workers";
import { json } from "../../../src/server";
import { adminEmails } from "../../../src/auth";
import { requireViewer } from "../../../src/guard";

/** Who is signed in, their workspaces, and their role in the active one. */
export async function GET(request: Request) {
  const who = await requireViewer(request);
  if (who instanceof Response) return who;
  const { results } = await env.DB.prepare(
    `SELECT o.id, o.name, m.role FROM member m JOIN organization o ON o.id = m.organizationId WHERE m.userId = ? ORDER BY m.createdAt`,
  ).bind(who.userId).all<{ id: string; name: string; role: string }>();
  return json({
    user: { id: who.userId, email: who.email },
    workspace: results.find((row) => row.id === who.workspaceId) ?? null,
    workspaces: results,
    platformAdmin: who.emailVerified && adminEmails(env).includes(who.email.toLowerCase()),
  });
}
