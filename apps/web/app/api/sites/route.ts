import { env } from "cloudflare:workers";
import { createId, type SiteRecord } from "@organic-growth/core";
import { isSafePublicUrl } from "@organic-growth/crawler";
import { countWorkspaceSites, listGithubInstallations, listSitesForUser, upsertSite } from "@organic-growth/db";
import { fail, json, readJson } from "../../../src/server";
import { requireWorkspace } from "../../../src/guard";
import { limitsFor } from "../../../src/limits";
import { workspaceRepositories } from "../../../src/github-install";

/** The refusal message when the workspace is full, else null. */
async function overLimit(workspaceId: string): Promise<string | null> {
  const limit = (await limitsFor(env.DB, workspaceId)).sites;
  if (limit === null || (await countWorkspaceSites(env.DB, workspaceId)) < limit) return null;
  return `This workspace can hold ${limit} site${limit === 1 ? "" : "s"}. Remove one first, or ask for more.`;
}

function publicWebsiteOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return isSafePublicUrl(candidate) ? new URL(candidate).origin : null;
}

export async function GET(request: Request) {
  const access = await requireWorkspace(request, "read");
  if (access instanceof Response) return access;
  return json({ sites: await listSitesForUser(env.DB, access.viewer.userId, access.viewer.workspaceId) });
}

/**
 * Connects a website. A GitHub repository is optional: it adds code-level
 * analysis and pull requests, but the page engine works for any stack
 * (WordPress, Drupal, Webflow, custom) because Eumon serves the pages itself.
 */
export async function POST(request: Request) {
  const access = await requireWorkspace(request, "write");
  if (access instanceof Response) return access;
  const { userId, workspaceId } = access.viewer;
  const body = await readJson<{ repositoryId?: unknown; websiteUrl?: unknown }>(request);
  if (!body) return fail("Send a JSON body containing a website URL.");
  const baseUrl = publicWebsiteOrigin(body.websiteUrl);
  if (!baseUrl) return fail("Enter a public website URL, such as https://example.com.");
  const sites = await listSitesForUser(env.DB, userId, workspaceId);
  const now = new Date().toISOString();

  if (body.repositoryId === undefined || body.repositoryId === null || body.repositoryId === "") {
    const existing = sites.find((site) => new URL(site.baseUrl).origin === baseUrl);
    const full = existing ? null : await overLimit(workspaceId);
    if (full) return fail(full, 429);
    const site: SiteRecord = existing ?? {
      workspaceId,
      id: createId("site"),
      name: new URL(baseUrl).hostname.replace(/^www\./, ""),
      baseUrl,
      createdAt: now,
      updatedAt: now,
    };
    if (!existing) await upsertSite(env.DB, site);
    return json({ site }, existing ? 200 : 201);
  }

  if (typeof body.repositoryId !== "number" || !Number.isSafeInteger(body.repositoryId)) {
    return fail("Choose an installed repository.");
  }
  const installations = await listGithubInstallations(env.DB, workspaceId);
  if (!installations.length) return fail("Install the GitHub App for this workspace before connecting a repository.", 401);

  try {
    const repository = (await workspaceRepositories(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, installations)).find((item) => item.id === body.repositoryId);
    if (!repository) return fail("That repository is not available to this workspace's GitHub installations.", 403);
    const installationId = repository.installationId;

    const existing = sites.find((site) => site.githubOwner === repository.owner.login && site.githubRepo === repository.name)
      ?? sites.find((site) => !site.githubRepo && new URL(site.baseUrl).origin === baseUrl);
    const full = existing ? null : await overLimit(workspaceId);
    if (full) return fail(full, 429);
    const site: SiteRecord = {
      workspaceId,
      id: existing?.id ?? createId("site"),
      name: repository.name,
      baseUrl,
      githubOwner: repository.owner.login,
      githubRepo: repository.name,
      githubInstallationId: installationId,
      defaultBranch: repository.default_branch,
      fingerprint: existing?.fingerprint,
      gscProperty: existing?.gscProperty,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await upsertSite(env.DB, site);
    return json({ site }, existing ? 200 : 201);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not connect this repository.", 502);
  }
}
