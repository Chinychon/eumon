import { env } from "cloudflare:workers";
import { createLlm, describeModelError, LlmError, type JsonLlm, type LlmEnv } from "@organic-growth/ai";
import type { PageSettings, SiteRecord } from "@organic-growth/core";
import { isSafePublicUrl } from "@organic-growth/crawler";
import { defaultPageSettings, getPageSettings } from "@organic-growth/db";
import { readText } from "./body";

export { readText } from "./body";

const NO_STORE = { "Cache-Control": "no-store" };

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: NO_STORE });
}

export function fail(message: string, status = 400): Response {
  return Response.json({ error: message }, { status, headers: NO_STORE });
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

export async function settingsFor(site: SiteRecord): Promise<PageSettings> {
  return (await getPageSettings(env.DB, site.id)) ?? defaultPageSettings(site.id, prettySiteName(site), site.baseUrl);
}

/** "example-dental.com.my" → "Example-dental"; repository names are kept as-is. */
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
  return typeof value === "string" && value.length <= 2048 && isSafePublicUrl(value);
}
