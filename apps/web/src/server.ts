import { env } from "cloudflare:workers";
import { createLlm, describeModelError, LlmError, type JsonLlm, type LlmEnv } from "@organic-growth/ai";
import type { PageSettings, SiteRecord } from "@organic-growth/core";
import { defaultPageSettings, getPageSettings, getSite } from "@organic-growth/db";

const NO_STORE = { "Cache-Control": "no-store" };

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: NO_STORE });
}

export function fail(message: string, status = 400): Response {
  return Response.json({ error: message }, { status, headers: NO_STORE });
}

/** Reads a request body without trusting Content-Length, so oversized bodies are rejected early. */
export async function readText(request: Request, maxBytes: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function readJson<T = Record<string, unknown>>(request: Request, maxBytes = 64 * 1024): Promise<T | null> {
  const text = await readText(request, maxBytes);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? value as T : null;
  } catch {
    return null;
  }
}

export async function findSite(siteId: string): Promise<SiteRecord | null> {
  return getSite(env.DB, siteId);
}

export async function settingsFor(site: SiteRecord): Promise<PageSettings> {
  return (await getPageSettings(env.DB, site.id)) ?? defaultPageSettings(site.id, prettySiteName(site), site.baseUrl);
}

/** "edeadesign.com.my" → "Edeadesign"; repository names are kept as-is. */
export function prettySiteName(site: Pick<SiteRecord, "name" | "baseUrl" | "githubRepo">): string {
  if (site.githubRepo && site.name !== new URL(site.baseUrl).hostname) return site.name;
  const label = new URL(site.baseUrl).hostname.replace(/^www\./, "").split(".")[0] ?? site.name;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** The configured model, or a 503 response explaining how to configure one. */
export function appLlm(): JsonLlm | Response {
  try {
    return createLlm(env as unknown as LlmEnv);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "No language model is configured.", 503);
  }
}

/** Converts model failures into an actionable message instead of a generic 500. */
export function llmFailure(error: unknown): Response {
  if (error instanceof LlmError) return fail(error.message, 502);
  const message = describeModelError(error);
  return fail(message, /unavailable|busy/.test(message) ? 503 : 502);
}

export function isPublicHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
    if (!host.includes(".") || host === "localhost" || /\.(local|localhost|internal)$/.test(host)) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false;
    return !url.port || ["80", "443"].includes(url.port);
  } catch {
    return false;
  }
}
