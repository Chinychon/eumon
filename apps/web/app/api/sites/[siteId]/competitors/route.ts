import { env } from "cloudflare:workers";
import { getSite, listSiteCompetitorDomains, setSiteCompetitorDomains } from "@organic-growth/db";

function normalizeDomain(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 253) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || !host.includes(".") || host === "localhost" || host.endsWith(".local") || url.username || url.password || url.port) return null;
    if (/^\d+(\.\d+){3}$/.test(host) || host.includes(":")) return null;
    return host;
  } catch { return null; }
}

export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return Response.json({ error: "Site not found." }, { status: 404 });
  return Response.json({ domains: await listSiteCompetitorDomains(env.DB, siteId) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return Response.json({ error: "Site not found." }, { status: 404 });
  let domains: unknown;
  try { domains = (await request.json() as { domains?: unknown }).domains; } catch { return Response.json({ error: "Send a list of competitor domains." }, { status: 400 }); }
  if (!Array.isArray(domains) || domains.length > 10) return Response.json({ error: "Enter up to 10 competitor domains." }, { status: 400 });
  const normalized = domains.map(normalizeDomain);
  if (normalized.some((domain) => !domain)) return Response.json({ error: "Enter public domain names without paths, ports, or IP addresses." }, { status: 400 });
  const unique = [...new Set(normalized as string[])];
  await setSiteCompetitorDomains(env.DB, siteId, unique);
  return Response.json({ domains: unique });
}
