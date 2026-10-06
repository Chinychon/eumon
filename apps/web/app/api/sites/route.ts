import { env } from "cloudflare:workers";
import { createId, verifyToken, type SiteRecord } from "@organic-growth/core";
import { isSafePublicUrl } from "@organic-growth/crawler";
import { listSites, upsertSite } from "@organic-growth/db";
import { createInstallationToken, listInstallationRepositories } from "@organic-growth/repo-analyzer";
import { fail, json, readJson } from "../../../src/server";

function installationCookie(request: Request): string | null {
  return request.headers.get("Cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("og_installation="))?.slice("og_installation=".length) ?? null;
}

function publicWebsiteOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return isSafePublicUrl(candidate) ? new URL(candidate).origin : null;
}

export async function GET() {
  return json({ sites: await listSites(env.DB) });
}

/**
 * Connects a website. A GitHub repository is optional: it adds code-level
 * analysis and pull requests, but the page engine works for any stack
 * (WordPress, Drupal, Webflow, custom) because Eumon serves the pages itself.
 */
export async function POST(request: Request) {
  const body = await readJson<{ repositoryId?: unknown; websiteUrl?: unknown }>(request);
  if (!body) return fail("Send a JSON body containing a website URL.");
  const baseUrl = publicWebsiteOrigin(body.websiteUrl);
  if (!baseUrl) return fail("Enter a public website URL, such as https://example.com.");
  const sites = await listSites(env.DB);
  const now = new Date().toISOString();

  if (body.repositoryId === undefined || body.repositoryId === null || body.repositoryId === "") {
    const existing = sites.find((site) => new URL(site.baseUrl).origin === baseUrl);
    const site: SiteRecord = existing ?? {
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
  const installationId = (await verifyToken<{ id: string }>(installationCookie(request) ?? "", env.SESSION_SECRET))?.id;
  if (!installationId) return fail("Install the GitHub App before connecting a repository.", 401);

  try {
    const token = await createInstallationToken(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, installationId);
    const repository = (await listInstallationRepositories(token)).find((item) => item.id === body.repositoryId);
    if (!repository) return fail("That repository is not available to this GitHub App installation.", 403);

    const existing = sites.find((site) => site.githubOwner === repository.owner.login && site.githubRepo === repository.name)
      ?? sites.find((site) => !site.githubRepo && new URL(site.baseUrl).origin === baseUrl);
    const site: SiteRecord = {
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
