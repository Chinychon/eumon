import { env } from "cloudflare:workers";
import { listWorkspacesForAdmin } from "@organic-growth/db";
import { requirePlatformAdmin } from "../../../../src/guard";
import { FREE_LIMITS } from "../../../../src/limits";
import { json } from "../../../../src/server";

export async function GET(request: Request) {
  const admin = await requirePlatformAdmin(request);
  if (admin instanceof Response) return admin;
  return json({ defaults: FREE_LIMITS, workspaces: await listWorkspacesForAdmin(env.DB, new Date().toISOString().slice(0, 10)) });
}
