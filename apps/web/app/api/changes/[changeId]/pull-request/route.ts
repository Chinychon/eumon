import { env } from "cloudflare:workers";
import { getChange, getSite, updateChangeStatus, type D1Like } from "@organic-growth/db";
import { createGitHubPullRequest } from "@organic-growth/agents";
import { createInstallationToken } from "@organic-growth/repo-analyzer";

const allowedPaths = new Set(["public/robots.txt", "app/robots.ts", "src/app/robots.ts", "app/sitemap.ts", "src/app/sitemap.ts"]);

export async function POST(_request: Request, context: { params: Promise<{ changeId: string }> }) {
  const { changeId } = await context.params;
  const change = await getChange(env.DB as D1Like, changeId);
  if (!change) return Response.json({ error: "Change not found." }, { status: 404 });
  if (change.status !== "proposed") return Response.json({ error: "Only a proposed change can be opened as a draft pull request." }, { status: 409 });
  const evidence = change.evidence as { files?: Record<string, string> };
  const files = evidence.files ?? {};
  if (!Object.keys(files).length || Object.keys(files).some((path) => !allowedPaths.has(path)) || Object.values(files).some((content) => typeof content !== "string" || content.length > 40_000)) {
    return Response.json({ error: "The stored change is outside the safe SEO configuration allowlist." }, { status: 422 });
  }
  const site = await getSite(env.DB as D1Like, change.siteId);
  if (!site?.githubInstallationId || !site.githubOwner || !site.githubRepo) return Response.json({ error: "The repository connection is missing." }, { status: 400 });
  try {
    const token = await createInstallationToken(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, site.githubInstallationId);
    const result = await createGitHubPullRequest(token, {
      owner: site.githubOwner, repo: site.githubRepo, branch: `organic-growth-${change.id.replace(/[^a-zA-Z0-9-]/g, "-")}`,
      baseBranch: site.defaultBranch ?? "main", title: change.title,
      body: `## Organic Growth Engine proposal\n\n${change.reason}\n\nFinding: ${change.findingId ?? "not specified"}\n\nThis is a draft for human review. The app did not merge or deploy this change.`,
      files,
    });
    await updateChangeStatus(env.DB as D1Like, change.id, "pr_opened", { prUrl: result.url, prNumber: result.number });
    return Response.json({ pullRequest: result }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not create the draft pull request. Confirm the GitHub App has Contents and Pull requests write access." }, { status: 502 });
  }
}
