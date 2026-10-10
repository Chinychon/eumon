import { env } from "cloudflare:workers";
import { addGithubInstallation } from "@organic-growth/db";
import { requireWorkspace } from "../../../../src/guard";
import { ownsInstallation } from "../../../../src/github-install";

function cookie(request: Request, name: string): string | undefined {
  return request.headers.get("Cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

export async function GET(request: Request) {
  const access = await requireWorkspace(request, "write");
  if (access instanceof Response) return access;
  const current = new URL(request.url);
  const state = current.searchParams.get("state");
  const installationId = current.searchParams.get("installation_id");
  const code = current.searchParams.get("code");
  const secure = current.protocol === "https:" ? "; Secure" : "";
  const expected = cookie(request, "og_github_state");
  const destination = new URL("/", current.origin);
  const headers = new Headers({ Location: destination.toString(), "Cache-Control": "no-store" });
  const clearState = `og_github_state=; HttpOnly${secure}; SameSite=Lax; Path=/api/github/callback; Max-Age=0`;
  // The old signed-installation cookie is no longer read; expire it.
  const clearInstallation = `og_installation=; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=0`;
  const refuse = (reason: string) => {
    destination.searchParams.set("github_error", reason);
    headers.set("Location", destination.toString());
    headers.append("Set-Cookie", clearState);
    return new Response(null, { status: 303, headers });
  };

  if (!state || !expected || state !== expected || !installationId || !/^\d+$/.test(installationId)) return refuse("installation_invalid");
  if (!code) return refuse("authorization_missing");
  try {
    if (!(await ownsInstallation(fetch, { clientId: env.GITHUB_APP_CLIENT_ID, clientSecret: env.GITHUB_APP_CLIENT_SECRET, code, installationId }))) return refuse("installation_not_yours");
    await addGithubInstallation(env.DB, access.viewer.workspaceId, installationId);
  } catch {
    return refuse("installation_failed");
  }
  destination.searchParams.set("github", "connected");
  destination.searchParams.set("view", "connections");
  headers.set("Location", destination.toString());
  headers.append("Set-Cookie", clearState);
  headers.append("Set-Cookie", clearInstallation);
  return new Response(null, { status: 303, headers });
}
