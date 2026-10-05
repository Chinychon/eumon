import { env } from "cloudflare:workers";
import { createId } from "@organic-growth/core";
import { listSites, upsertSite } from "@organic-growth/db";
import {
  createInstallationToken,
  listInstallationRepositories,
  verifySignedInstallationCookie,
} from "@organic-growth/repo-analyzer";

function installationCookie(request: Request): string | null {
  return request.headers.get("Cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("og_installation="))?.slice("og_installation=".length) ?? null;
}

function publicWebsiteOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value.match(/^https?:\/\//i) ? value : `https://${value}`);
    const host = url.hostname.toLowerCase();
    if (!/^https?:$/.test(url.protocol) || !host.includes(".") || host.endsWith(".local") || host.endsWith(".localhost") || host === "localhost") return null;
    if (url.username || url.password || (url.port && !["80", "443"].includes(url.port))) return null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":")) return null;
    const octets = host.split(".").map(Number);
    if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function GET() {
  return Response.json({ sites: await listSites(env.DB) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  let body: { repositoryId?: unknown; websiteUrl?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send a JSON body containing a repository and website URL." }, { status: 400 });
  }
  const baseUrl = publicWebsiteOrigin(body.websiteUrl);
  if (!baseUrl || typeof body.repositoryId !== "number" || !Number.isSafeInteger(body.repositoryId)) {
    return Response.json({ error: "Choose an installed repository and enter a public website URL." }, { status: 400 });
  }

  const installationId = await verifySignedInstallationCookie(installationCookie(request) ?? "", env.SESSION_SECRET);
  if (!installationId) return Response.json({ error: "Install the GitHub App before connecting a repository." }, { status: 401 });

  try {
    const token = await createInstallationToken(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, installationId);
    const repository = (await listInstallationRepositories(token)).find((item) => item.id === body.repositoryId);
    if (!repository) return Response.json({ error: "That repository is not available to this GitHub App installation." }, { status: 403 });

    const sites = await listSites(env.DB);
    const existing = sites.find((site) => site.githubOwner === repository.owner.login && site.githubRepo === repository.name);
    const now = new Date().toISOString();
    const site = {
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
    return Response.json({ site }, { status: existing ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not connect this repository." }, { status: 502 });
  }
}
