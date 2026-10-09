import { env } from "cloudflare:workers";
import { verifyToken } from "@organic-growth/core";
import { createInstallationToken, listInstallationRepositories } from "@organic-growth/repo-analyzer";

function getCookie(request: Request): string | null {
  return request.headers.get("Cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("og_installation="))?.slice("og_installation=".length) ?? null;
}

export async function GET(request: Request) {
  const installationCookie = getCookie(request);
  if (!installationCookie) {
    return Response.json({ error: "No GitHub installation cookie reached Eumon. The GitHub Setup URL must point to this app's callback, then the install flow must finish in this same browser." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const installationId = (await verifyToken<{ id: string }>(installationCookie, env.SESSION_SECRET))?.id;
  if (!installationId) {
    return Response.json({ error: "Eumon received the installation cookie but could not verify it. Restart the dev server after changing SESSION_SECRET, and use one consistent SESSION_SECRET for the callback and app." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const token = await createInstallationToken(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, installationId);
    const repositories = await listInstallationRepositories(token);
    return Response.json({ repositories: repositories.map(({ id, name, full_name, default_branch, owner, private: isPrivate }) => ({
      id, name, fullName: full_name, defaultBranch: default_branch, owner: owner.login, isPrivate,
    })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not read installed repositories." }, { status: 502 });
  }
}
