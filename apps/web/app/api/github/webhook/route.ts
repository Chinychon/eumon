import { env } from "cloudflare:workers";
import type { D1Like } from "@organic-growth/db";
import { githubOpsFor } from "../../../../src/fix-github";
import { fetchHtml } from "../../../../src/fix-steps";
import { handleGitHubEvent, verifySignature } from "../../../../src/github-webhook";

// Public: GitHub App events, authenticated by the HMAC signature rather than a session.
export async function POST(request: Request) {
  if (!env.GITHUB_WEBHOOK_SECRET) return Response.json({ error: "Webhooks aren't configured." }, { status: 503 });
  if (Number(request.headers.get("content-length")) > 26_214_400) return Response.json({ error: "Payload too large." }, { status: 413 });
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
  try {
    const outcome = await handleGitHubEvent(
      { db: env.DB as unknown as D1Like, opsFor: (site) => githubOpsFor(env, site), fetchHtml, now: () => new Date() },
      request.headers.get("x-github-event") ?? "", payload,
    );
    return Response.json({ outcome });
  } catch (error) {
    console.error("GitHub webhook failed", error);
    return Response.json({ outcome: "error" }, { status: 500 });
  }
}
