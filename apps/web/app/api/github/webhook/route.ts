import { env } from "cloudflare:workers";
import type { D1Like } from "@organic-growth/db";
import { fixRepoFor } from "../../../../src/fix-github";
import { fetchHtml } from "../../../../src/fix-steps";
import { handleGitHubEvent, verifySignature } from "../../../../src/github-webhook";

// Public: GitHub App events, authenticated by the HMAC signature rather than a session.
export async function POST(request: Request) {
  if (!env.GITHUB_WEBHOOK_SECRET) return Response.json({ error: "Webhooks aren't configured." }, { status: 503 });
  const body = await request.text();
  if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get("x-hub-signature-256")))) {
    return Response.json({ error: "Invalid signature." }, { status: 401 });
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const outcome = await handleGitHubEvent(
    { db: env.DB as unknown as D1Like, opsFor: async (site) => (await fixRepoFor(env, site)).ops, fetchHtml, now: () => new Date() },
    request.headers.get("x-github-event") ?? "", payload,
  ).catch((error: unknown) => `error: ${error instanceof Error ? error.message : "unknown"}`);
  return Response.json({ outcome });
}
