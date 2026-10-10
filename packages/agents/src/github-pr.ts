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
  nodeId: string;
  headSha: string;
}

/**
 * Creates a GitHub pull request from file contents using the Git Data API.
 * The caller supplies a least-privilege token with contents and pull request write access.
 */
export async function createGitHubPullRequest(
  token: string,
  input: PullRequestInput,
  fetchFn: typeof fetch = fetch,
): Promise<PullRequestResult> {
  if (!token) throw new Error("A GitHub token is required.");
  if (!Object.keys(input.files).length) throw new Error("At least one changed file is required.");
  const api = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  const request = async <T>(path: string, method: string, body?: unknown): Promise<T> => {
    const response = await fetchFn(`${api}${path}`, {
      method,
      headers: { ...headers(token), "Content-Type": "application/json" },
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
  const pr = await request<{ number: number; html_url: string; node_id: string }>("/pulls", "POST", {
    title: input.title,
    head: input.branch,
    base: input.baseBranch,
    body: input.body,
    draft: true,
  });
  return { number: pr.number, url: pr.html_url, nodeId: pr.node_id, headSha: commit.sha };
}

const GITHUB = "https://api.github.com";
const headers = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Eumon", "X-GitHub-Api-Version": "2022-11-28" });

async function github<T>(token: string, path: string, init: RequestInit = {}, fetchFn: typeof fetch = fetch): Promise<T | null> {
  const response = await fetchFn(`${GITHUB}${path}`, { ...init, headers: { ...headers(token), ...(init.body ? { "Content-Type": "application/json" } : {}) } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}.`);
  return response.status === 204 ? (null as T) : (await response.json()) as T;
}

export async function getFileWithSha(token: string, owner: string, repo: string, path: string, ref: string, fetchFn: typeof fetch = fetch): Promise<{ content: string; sha: string } | null> {
  const file = await github<{ content?: string; sha: string; encoding?: string; size?: number } | unknown[]>(token, `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`, {}, fetchFn);
  if (!file) return null;
  if (Array.isArray(file)) throw new Error(`${path} is a directory.`);
  if (file.encoding === "none") throw new Error(`${path} is too large to edit safely.`);
  if (!file.content) return { content: "", sha: file.sha };
  const bytes = Uint8Array.from(atob(file.content.replace(/\n/g, "")), (c) => c.charCodeAt(0));
  return { content: new TextDecoder().decode(bytes), sha: file.sha };
}

export async function getPullRequest(token: string, owner: string, repo: string, number: number, fetchFn: typeof fetch = fetch) {
  const pr = await github<{ state: "open" | "closed"; merged: boolean; draft: boolean; head: { sha: string }; node_id: string; created_at: string }>(token, `/repos/${owner}/${repo}/pulls/${number}`, {}, fetchFn);
  if (!pr) throw new Error(`Pull request #${number} wasn't found.`);
  return { state: pr.state, merged: pr.merged, draft: pr.draft, headSha: pr.head.sha, nodeId: pr.node_id, createdAt: pr.created_at };
}

export function checkStateOf(checkRuns: Array<{ status: string; conclusion: string | null }>, combinedStatus: { state: string; total_count: number }): "success" | "failure" | "pending" {
  if (checkRuns.some((r) => r.status === "completed" && ["failure", "timed_out", "cancelled", "action_required"].includes(r.conclusion ?? ""))) return "failure";
  if (combinedStatus.total_count > 0 && (combinedStatus.state === "failure" || combinedStatus.state === "error")) return "failure";
  if (checkRuns.some((r) => r.status !== "completed")) return "pending";
  if (combinedStatus.total_count > 0 && combinedStatus.state === "pending") return "pending";
  return "success";
}

export async function combinedCheckState(token: string, owner: string, repo: string, sha: string, fetchFn: typeof fetch = fetch): Promise<"success" | "failure" | "pending"> {
  const runs = await github<{ total_count: number; check_runs: Array<{ status: string; conclusion: string | null }> }>(token, `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`, {}, fetchFn);
  if (!runs) throw new Error("GitHub didn't return check runs for this commit.");
  if (runs.total_count > runs.check_runs.length) return "pending";
  const status = await github<{ state: string; total_count: number }>(token, `/repos/${owner}/${repo}/commits/${sha}/status`, {}, fetchFn);
  return checkStateOf(runs.check_runs, status ?? { state: "pending", total_count: 0 });
}

export async function latestPreviewUrl(token: string, owner: string, repo: string, sha: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const deployments = await github<Array<{ id: number; environment?: string }>>(token, `/repos/${owner}/${repo}/deployments?sha=${sha}&per_page=5`, {}, fetchFn);
  for (const deployment of deployments ?? []) {
    if (/prod/i.test(deployment.environment ?? "")) continue;
    const statuses = await github<Array<{ state: string; environment_url?: string }>>(token, `/repos/${owner}/${repo}/deployments/${deployment.id}/statuses?per_page=5`, {}, fetchFn);
    const settled = statuses?.find((s) => !["queued", "in_progress", "pending"].includes(s.state));
    if (settled?.state !== "success" || !settled.environment_url) continue;
    try {
      if (new URL(settled.environment_url).protocol === "https:") return settled.environment_url;
    } catch { /* not a URL */ }
  }
  return null;
}

export async function markReadyForReview(token: string, nodeId: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const response = await fetchFn(`${GITHUB}/graphql`, {
    method: "POST", headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ query: "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }", variables: { id: nodeId } }),
  });
  const body = (await response.json()) as { errors?: Array<{ message: string }> };
  if (!response.ok || body.errors?.length) throw new Error(`GitHub couldn't mark the PR ready: ${body.errors?.[0]?.message ?? response.status}.`);
}

export async function commentOnPullRequest(token: string, owner: string, repo: string, number: number, body: string, fetchFn: typeof fetch = fetch): Promise<void> {
  if ((await github(token, `/repos/${owner}/${repo}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) }, fetchFn)) === null) throw new Error(`Pull request #${number} wasn't found.`);
}

export async function closePullRequest(token: string, owner: string, repo: string, number: number, fetchFn: typeof fetch = fetch): Promise<void> {
  if ((await github(token, `/repos/${owner}/${repo}/pulls/${number}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) }, fetchFn)) === null) throw new Error(`Pull request #${number} wasn't found.`);
}
