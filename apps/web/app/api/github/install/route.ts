import { env } from "cloudflare:workers";
import { requireWorkspace } from "../../../../src/guard";

export async function GET(request: Request) {
  const access = await requireWorkspace(request, "write");
  if (access instanceof Response) return access;
  const state = crypto.randomUUID();
  const redirect = new URL(
    `https://github.com/apps/${encodeURIComponent(env.GITHUB_APP_SLUG)}/installations/new`,
  );
  redirect.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect.toString(),
      "Set-Cookie": `og_github_state=${state}; HttpOnly${new URL(request.url).protocol === "https:" ? "; Secure" : ""}; SameSite=Lax; Path=/api/github/callback; Max-Age=600`,
      "Cache-Control": "no-store",
    },
  });
}
