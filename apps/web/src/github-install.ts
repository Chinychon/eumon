import { createInstallationToken, listInstallationRepositories, type GitHubRepository } from "@organic-growth/repo-analyzer";

/**
 * An installation id in the install callback's query string proves nothing: anyone can type one.
 * With "Request user authorization (OAuth) during installation" on, GitHub also sends a `code`;
 * the user token it buys lists the installations that user can reach.
 */
export async function ownsInstallation(fetchFn: typeof fetch, input: { clientId: string; clientSecret: string; code: string; installationId: string }): Promise<boolean> {
  const exchange = await fetchFn("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code }),
  });
  const token = exchange.ok ? ((await exchange.json()) as { access_token?: string }).access_token : undefined;
  if (!token) return false;
  const response = await fetchFn("https://api.github.com/user/installations?per_page=100", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Eumon" },
  });
  if (!response.ok) return false;
  const { installations } = (await response.json()) as { installations?: Array<{ id: number }> };
  return Boolean(installations?.some((installation) => String(installation.id) === input.installationId));
}

/** Every repository across a workspace's installations, each tagged with the installation that reaches it. */
export async function workspaceRepositories(appId: string, privateKey: string, installationIds: string[]): Promise<Array<GitHubRepository & { installationId: string }>> {
  const lists = await Promise.all(installationIds.map(async (installationId) => {
    const token = await createInstallationToken(appId, privateKey, installationId);
    return (await listInstallationRepositories(token)).map((repository) => ({ ...repository, installationId }));
  }));
  return lists.flat();
}
