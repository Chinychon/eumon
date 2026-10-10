import { env } from "cloudflare:workers";
import { setLimitOverrides } from "@organic-growth/db";
import { requirePlatformAdmin } from "../../../../../../src/guard";
import { FREE_LIMITS, type Limits } from "../../../../../../src/limits";
import { fail, json, readJson } from "../../../../../../src/server";

/** Replaces a workspace's overrides. Numbers: a non-negative integer or null (unlimited); features: true or false. Unknown keys are dropped. */
export async function PUT(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const admin = await requirePlatformAdmin(request);
  if (admin instanceof Response) return admin;
  const { workspaceId } = await context.params;
  if (!(await env.DB.prepare("SELECT 1 FROM organization WHERE id = ?").bind(workspaceId).first())) return fail("Workspace not found.", 404);
  const body = await readJson<Record<string, unknown>>(request);
  if (!body) return fail("Send the limits as JSON.");
  const overrides: Partial<Limits> = {};
  for (const [key, standard] of Object.entries(FREE_LIMITS) as Array<[keyof Limits, Limits[keyof Limits]]>) {
    if (!(key in body)) continue;
    const value = body[key];
    if (typeof standard === "boolean" ? typeof value !== "boolean" : !(value === null || (Number.isInteger(value) && (value as number) >= 0))) {
      return fail(`${key} must be ${typeof standard === "boolean" ? "true or false" : "a whole number or null"}.`);
    }
    (overrides as Record<string, unknown>)[key] = value;
  }
  await setLimitOverrides(env.DB, workspaceId, overrides);
  return json({ workspaceId, overrides });
}
