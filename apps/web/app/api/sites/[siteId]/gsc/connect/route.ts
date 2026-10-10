import { env } from "cloudflare:workers";
import { createId, signToken } from "@organic-growth/core";
import { GOOGLE_NONCE_COOKIE } from "../../../../../../src/google-state";
import { ANALYTICS_SCOPE, DRIVE_FILE_SCOPE, SEARCH_CONSOLE_SCOPE } from "../../../../../../src/gsc-auth";
import { requireSite } from "../../../../../../src/guard";

export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const callback = new URL("/api/google/callback", request.url).toString();
  const nonce = createId("oauth");
  const state = await signToken({ siteId, nonce, userId: access.viewer.userId }, 10 * 60_000, env.SESSION_SECRET);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: callback, response_type: "code",
    scope: `${SEARCH_CONSOLE_SCOPE} ${ANALYTICS_SCOPE} ${DRIVE_FILE_SCOPE}`, access_type: "offline", prompt: "consent", state,
  }).toString();
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return new Response(null, { status: 302, headers: {
    Location: url.toString(), "Cache-Control": "no-store",
    "Set-Cookie": `${GOOGLE_NONCE_COOKIE}=${nonce}; HttpOnly${secure}; SameSite=Lax; Path=/api/google/callback; Max-Age=600`,
  } });
}
