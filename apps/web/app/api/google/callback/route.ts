import { env } from "cloudflare:workers";
import { verifyToken } from "@organic-growth/core";
import { GOOGLE_NONCE_COOKIE, googleStateProblem, type GoogleState } from "../../../../src/google-state";
import { saveGoogleRefreshToken } from "../../../../src/gsc-auth";
import { requireSite, viewer } from "../../../../src/guard";

export async function GET(request: Request) {
  const url = new URL(request.url);
  // The nonce cookie is single use: every answer below expires it.
  const spent = `${GOOGLE_NONCE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/google/callback; Max-Age=0`;
  const redirect = (path: string) => new Response(null, { status: 303, headers: { Location: new URL(path, url.origin).toString(), "Set-Cookie": spent } });
  const state = await verifyToken<GoogleState>(url.searchParams.get("state") ?? "", env.SESSION_SECRET);
  const cookieNonce = request.headers.get("Cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${GOOGLE_NONCE_COOKIE}=`))?.slice(GOOGLE_NONCE_COOKIE.length + 1) ?? null;
  const who = await viewer(request);
  const problem = googleStateProblem(state, cookieNonce, who?.userId ?? null);
  if (problem || url.searchParams.has("error")) return redirect("/?gsc=error");
  const access = await requireSite(request, state!.siteId, "write");
  if (access instanceof Response) return redirect("/?gsc=error");
  const siteId = access.site.id;
  const code = url.searchParams.get("code");
  if (!code) return Response.json({ error: "Google did not return an authorization code." }, { status: 400, headers: { "Set-Cookie": spent } });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: new URL("/api/google/callback", url.origin).toString(), grant_type: "authorization_code",
    }),
  });
  if (!response.ok) return redirect("/?gsc=error");
  const token = await response.json() as { refresh_token?: string; scope?: string };
  if (!token.refresh_token) return redirect("/?gsc=reauthorize");
  try {
    await saveGoogleRefreshToken(env.DB, siteId, token.refresh_token, env.OAUTH_ENCRYPTION_KEY, token.scope ?? "webmasters.readonly");
  } catch {
    return Response.json({ error: "Could not securely store the Google connection." }, { status: 500, headers: { "Set-Cookie": spent } });
  }
  return redirect(`/?gsc=connected&view=connections&site=${encodeURIComponent(siteId)}`);
}
