import type { RepoSnapshot } from "./analyze.js";

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
 * Builds a repo snapshot from GitHub API for analysis.
 * Fetches package.json, routes, wrangler, and key SEO files.
 */
export async function buildRepoSnapshotFromGitHub(
  client: GitHubContentsClient,
  owner: string,
  repo: string,
  ref = "main",
): Promise<RepoSnapshot> {
  const treePaths = await client.getTreePaths(owner, repo, ref);
  const interesting = treePaths.filter((p) =>
    /^(package\.json|vite\.config\.|wrangler\.|next\.config\.|src\/app\/routes\.|app\/.*page\.|public\/(robots\.txt|sitemap)|scripts\/generate-sitemap|worker\/|src\/app\/seo\/)/.test(
      p,
    ),
  );

  const priority = [
    "package.json",
    "src/app/routes.tsx",
    "src/app/routes.ts",
    "wrangler.jsonc",
    "wrangler.toml",
    "vite.config.ts",
    "public/robots.txt",
    "worker/spa-fallback.js",
    "scripts/generate-sitemap.mjs",
  ];

  const toFetch = [
    ...new Set([
      ...priority.filter((p) => treePaths.includes(p)),
      ...interesting.slice(0, 40),
    ]),
  ].slice(0, 50);

  const files: RepoSnapshot["files"] = [];
  for (const path of toFetch) {
    const content = await client.getFileContent(owner, repo, path, ref);
    files.push({ path, content: content ?? undefined });
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
        return atob(data.content.replace(/\n/g, ""));
      }
      return data.content;
    },
  };
}
