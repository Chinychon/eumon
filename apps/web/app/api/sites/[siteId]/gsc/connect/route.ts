import { env } from "cloudflare:workers";
import { createId, signToken } from "@organic-growth/core";
import { getSite } from "@organic-growth/db";
import { ANALYTICS_SCOPE, DRIVE_FILE_SCOPE, SEARCH_CONSOLE_SCOPE } from "../../../../../../src/gsc-auth";

export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return Response.json({ error: "Site not found." }, { status: 404 });
  const callback = new URL("/api/google/callback", request.url).toString();
  const state = await signToken({ siteId, nonce: createId("oauth") }, 10 * 60_000, env.SESSION_SECRET);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callback,
    response_type: "code",
    scope: `${SEARCH_CONSOLE_SCOPE} ${ANALYTICS_SCOPE} ${DRIVE_FILE_SCOPE}`,
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  return Response.redirect(url.toString(), 302);
}
