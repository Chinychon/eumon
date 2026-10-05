import { env } from "cloudflare:workers";
import {
  createInstallationToken,
  listInstallationRepositories,
  verifySignedInstallationCookie,
} from "@organic-growth/repo-analyzer";

function getCookie(request: Request): string | null {
  return request.headers.get("Cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("og_installation="))?.slice("og_installation=".length) ?? null;
}

export async function GET(request: Request) {
  const installationId = await verifySignedInstallationCookie(getCookie(request) ?? "", env.SESSION_SECRET);
  if (!installationId) return Response.json({ error: "Install the GitHub App to choose a repository." }, { status: 401 });
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
