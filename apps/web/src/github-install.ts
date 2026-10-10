import { createInstallationToken, listInstallationRepositories, type GitHubRepository } from "@organic-growth/repo-analyzer";

/**
 * An installation id in the install callback's query string proves nothing: anyone can type one.
 * With "Request user authorization (OAuth) during installation" on, GitHub also sends a `code`;
 * the user token it buys lists installations the user merely has repo access to, so we also require
 * the installer to be the installation's own account, or an active admin of its organization.
 */
export type InstallationCheck = "ok" | "not_yours" | "org_check_unavailable";

export async function checkInstallation(fetchFn: typeof fetch, input: { clientId: string; clientSecret: string; code: string; installationId: string }): Promise<InstallationCheck> {
  const exchange = await fetchFn("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code }),
  });
  const token = exchange.ok ? ((await exchange.json()) as { access_token?: string }).access_token : undefined;
  if (!token) return "not_yours";
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Eumon" };
  // ponytail: first page only; >100 reachable installations is a false refusal; follow the Link header if that ever matters.
  const response = await fetchFn("https://api.github.com/user/installations?per_page=100", { headers });
  if (!response.ok) return "not_yours";
  const { installations } = (await response.json()) as { installations?: Array<{ id: number; account?: { login?: string; type?: string } }> };
  const account = installations?.find((installation) => String(installation.id) === input.installationId)?.account;
  if (!account?.login) return "not_yours";
  if (account.type === "User") {
    const me = await fetchFn("https://api.github.com/user", { headers });
    if (!me.ok) return "not_yours";
    const { login } = (await me.json()) as { login?: string };
    return login && login.toLowerCase() === account.login.toLowerCase() ? "ok" : "not_yours";
  }
  if (account.type !== "Organization") return "not_yours";
  const membership = await fetchFn(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(account.login)}`, { headers });
  if (membership.status === 403 || membership.status === 404) return "org_check_unavailable";
  if (!membership.ok) return "not_yours";
  const { state, role } = (await membership.json()) as { state?: string; role?: string };
  return state === "active" && role === "admin" ? "ok" : "not_yours";
}

/** Every repository across a workspace's installations, each tagged with the installation that reaches it. */
export async function workspaceRepositories(appId: string, privateKey: string, installationIds: string[]): Promise<Array<GitHubRepository & { installationId: string }>> {
  const lists = await Promise.all(installationIds.map(async (installationId) => {
    const token = await createInstallationToken(appId, privateKey, installationId);
    return (await listInstallationRepositories(token)).map((repository) => ({ ...repository, installationId }));
  }));
  return lists.flat();
}
