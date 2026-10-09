import { routeSourceCandidates, type RepoSnapshot } from "./analyze.js";

export interface GitHubContentsClient {
  getTreePaths(owner: string, repo: string, ref?: string): Promise<string[]>;
  getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<string | null>;
}

/**
 * Builds a repo snapshot from the GitHub API for analysis: configuration
 * files plus the source of the routes, layouts, and sitemap code that decide
 * what crawlers receive.
 */
export async function buildRepoSnapshotFromGitHub(
  client: GitHubContentsClient,
  owner: string,
  repo: string,
  ref = "main",
  maxFiles = 70,
): Promise<RepoSnapshot> {
  const treePaths = await client.getTreePaths(owner, repo, ref);
  const config = treePaths.filter((p) =>
    /^(package\.json|(vite|astro|nuxt|next|svelte|remix|gatsby)\.config\.[cm]?[jt]s|wrangler\.(toml|jsonc?)|vercel\.json|netlify\.toml|public\/robots\.txt|middleware\.(t|j)s|src\/middleware\.(t|j)s)$/.test(p),
  );
  const toFetch = [...new Set([...config, ...routeSourceCandidates(treePaths)])].slice(0, maxFiles);

  const files: RepoSnapshot["files"] = [];
  // A few requests at a time keeps well inside GitHub's secondary rate limits.
  for (let index = 0; index < toFetch.length; index += 6) {
    const batch = toFetch.slice(index, index + 6);
    const contents = await Promise.all(batch.map((path) => client.getFileContent(owner, repo, path, ref).catch(() => null)));
    batch.forEach((path, offset) => files.push({ path, content: contents[offset] ?? undefined }));
  }

  let packageJson: Record<string, unknown> | undefined;
  const pkgFile = files.find((f) => f.path === "package.json");
  if (pkgFile?.content) {
    try {
      packageJson = JSON.parse(pkgFile.content) as Record<string, unknown>;
    } catch {
      packageJson = undefined;
    }
  }

  return { files, packageJson, treePaths };
}

export function createGitHubApiClient(token: string): GitHubContentsClient {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "organic-growth-engine",
  };

  return {
    async getTreePaths(owner, repo, ref = "main") {
      const res = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        { headers },
      );
      if (!res.ok) {
        throw new Error(`GitHub tree fetch failed: ${res.status}`);
      }
      const data = (await res.json()) as {
        tree: Array<{ path: string; type: string }>;
      };
      return data.tree.filter((t) => t.type === "blob").map((t) => t.path);
    },
    async getFileContent(owner, repo, path, ref = "main") {
      const res = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
        { headers },
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`GitHub file fetch failed: ${res.status} ${path}`);
      }
      const data = (await res.json()) as {
        content?: string;
        encoding?: string;
      };
      if (!data.content) return null;
      if (data.encoding === "base64") {
        // atob yields one character per byte; decode the bytes as UTF-8.
        const binary = atob(data.content.replace(/\n/g, ""));
        return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
      }
      return data.content;
    },
  };
}
