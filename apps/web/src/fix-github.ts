import type { SiteRecord } from "@organic-growth/core";
import { closePullRequest, combinedCheckState, commentOnPullRequest, createGitHubPullRequest, getFileWithSha, getPullRequest, latestPreviewUrl, markReadyForReview } from "@organic-growth/agents";
import { createGitHubApiClient, createInstallationToken } from "@organic-growth/repo-analyzer";
import type { AppEnv } from "../cloudflare.config";
import type { FixRepo, PrOps } from "./fix-run.ts";

export type GitHubOps = {
  getPullRequest(n: number): ReturnType<typeof getPullRequest>;
  checkState(sha: string): Promise<"success" | "failure" | "pending">;
  previewUrl(sha: string): Promise<string | null>;
  markReady(nodeId: string): Promise<void>;
  comment(n: number, body: string): Promise<void>;
  close(n: number): Promise<void>;
};

export async function fixRepoFor(env: AppEnv, site: SiteRecord): Promise<{ repo: FixRepo; pr: PrOps; ops: GitHubOps }> {
  if (!site.githubInstallationId || !site.githubOwner || !site.githubRepo) throw new Error("The site has no connected repository.");
  const token = await createInstallationToken(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, site.githubInstallationId);
  const owner = site.githubOwner;
  const name = site.githubRepo;
  const branch = site.defaultBranch ?? "main";
  const treePaths = await createGitHubApiClient(token).getTreePaths(owner, name, branch);
  return {
    repo: { owner, name, branch, treePaths, getFile: (path) => getFileWithSha(token, owner, name, path, branch) },
    pr: { createPr: (input) => createGitHubPullRequest(token, { owner, repo: name, baseBranch: branch, ...input }) },
    ops: {
      getPullRequest: (n) => getPullRequest(token, owner, name, n),
      checkState: (sha) => combinedCheckState(token, owner, name, sha),
      previewUrl: (sha) => latestPreviewUrl(token, owner, name, sha),
      markReady: (nodeId) => markReadyForReview(token, nodeId),
      comment: (n, body) => commentOnPullRequest(token, owner, name, n, body),
      close: (n) => closePullRequest(token, owner, name, n),
    },
  };
}
