import { env } from "cloudflare:workers";
import { listGithubInstallations } from "@organic-growth/db";
import { requireWorkspace } from "../../../../src/guard";
import { workspaceRepositories } from "../../../../src/github-install";

export async function GET(request: Request) {
  const access = await requireWorkspace(request, "write");
  if (access instanceof Response) return access;
  const installations = await listGithubInstallations(env.DB, access.viewer.workspaceId);
  if (!installations.length) return Response.json({ error: "Install the GitHub App for this workspace first." }, { status: 409, headers: { "Cache-Control": "no-store" } });
  try {
    const repositories = await workspaceRepositories(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, installations);
    return Response.json({ repositories: repositories.map(({ id, name, full_name, default_branch, owner, private: isPrivate }) => ({
      id, name, fullName: full_name, defaultBranch: default_branch, owner: owner.login, isPrivate,
    })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not read installed repositories." }, { status: 502 });
  }
}
