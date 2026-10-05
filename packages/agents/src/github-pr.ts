/** GitHub PR adapter contract. Implementations should create reviewable pull requests only. */
export interface PullRequestInput {
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  files: Record<string, string>;
}

export interface PullRequestResult {
  number: number;
  url: string;
}

/**
 * Creates a GitHub pull request from file contents using the Git Data API.
 * The caller supplies a least-privilege token with contents and pull request write access.
 */
export async function createGitHubPullRequest(
  token: string,
  input: PullRequestInput,
): Promise<PullRequestResult> {
  if (!token) throw new Error("A GitHub token is required.");
  if (!Object.keys(input.files).length) throw new Error("At least one changed file is required.");
  const api = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const request = async <T>(path: string, method: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${api}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${path} failed: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  const ref = await request<{ object: { sha: string } }>(`/git/ref/heads/${encodeURIComponent(input.baseBranch)}`, "GET");
  const base = await request<{ tree: { sha: string } }>(`/git/commits/${ref.object.sha}`, "GET");
  const blobs = await Promise.all(Object.entries(input.files).map(async ([path, content]) => {
    const blob = await request<{ sha: string }>("/git/blobs", "POST", { content, encoding: "utf-8" });
    return { path, mode: "100644", type: "blob", sha: blob.sha };
  }));
  const tree = await request<{ sha: string }>("/git/trees", "POST", { base_tree: base.tree.sha, tree: blobs });
  const commit = await request<{ sha: string }>("/git/commits", "POST", {
    message: input.title,
    tree: tree.sha,
    parents: [ref.object.sha],
  });
  await request(`/git/refs`, "POST", { ref: `refs/heads/${input.branch}`, sha: commit.sha });
  const pr = await request<{ number: number; html_url: string }>("/pulls", "POST", {
    title: input.title,
    head: input.branch,
    base: input.baseBranch,
    body: input.body,
    draft: true,
  });
  return { number: pr.number, url: pr.html_url };
}
