import { env } from "cloudflare:workers";
import { verifyToken } from "@organic-growth/core";
import { saveGoogleRefreshToken } from "../../../../src/gsc-auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const siteId = (await verifyToken<{ siteId: string }>(url.searchParams.get("state") ?? "", env.SESSION_SECRET))?.siteId;
  if (!siteId || url.searchParams.has("error")) return Response.redirect(new URL("/?gsc=error", url.origin), 303);
  const code = url.searchParams.get("code");
  if (!code) return Response.json({ error: "Google did not return an authorization code." }, { status: 400 });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: new URL("/api/google/callback", url.origin).toString(), grant_type: "authorization_code",
    }),
  });
  if (!response.ok) return Response.redirect(new URL("/?gsc=error", url.origin), 303);
  const token = await response.json() as { refresh_token?: string; scope?: string };
  if (!token.refresh_token) return Response.redirect(new URL("/?gsc=reauthorize", url.origin), 303);
  try {
    await saveGoogleRefreshToken(env.DB, siteId, token.refresh_token, env.OAUTH_ENCRYPTION_KEY, token.scope ?? "webmasters.readonly");
  } catch {
    return Response.json({ error: "Could not securely store the Google connection." }, { status: 500 });
  }
  return Response.redirect(new URL(`/?gsc=connected&view=connections&site=${encodeURIComponent(siteId)}`, url.origin), 303);
}
