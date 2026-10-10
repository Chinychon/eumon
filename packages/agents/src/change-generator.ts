import type { JsonLlm } from "@organic-growth/ai";
import { schema } from "@organic-growth/ai";
import type { Finding } from "@organic-growth/core";

/**
 * Repository files Eumon may propose changes to: the static robots.txt only. `app/robots.ts`
 * and `app/sitemap.ts` were allowed once, but they are code that runs at build time,
 * including preview builds of a draft PR, so model-written content must never reach them.
 */
export const SAFE_SEO_CONFIG_PATHS: ReadonlySet<string> = new Set(["public/robots.txt"]);

/** Every line a comment, blank, or a robots.txt directive: nothing that could run anywhere. */
export function isPlainRobotsTxt(content: string): boolean {
  return content.split(/\r?\n/).every((line) => /^\s*(#.*)?$/.test(line) || /^\s*(user-agent|allow|disallow|sitemap|crawl-delay|host)\s*:[^<>`]*$/i.test(line));
}

export const MAX_SAFE_FILE_LENGTH = 40_000;

const changeSchema = schema.object({
  skip: schema.boolean("true when the evidence does not support a safe correction"),
  title: schema.string(),
  reason: schema.string(),
  path: schema.string(),
  content: schema.string("complete replacement file content"),
});

/** Generates a tightly scoped SEO configuration proposal from observed evidence and existing file contents. */
export async function generateSafeTechnicalChange(
  llm: JsonLlm,
  finding: Pick<Finding, "category" | "title" | "summary" | "evidence">,
  candidates: Array<{ path: string; content: string }>,
): Promise<{ title: string; reason: string; path: string; content: string } | null> {
  const safeCandidates = candidates.filter((file) => SAFE_SEO_CONFIG_PATHS.has(file.path) && file.content.length <= MAX_SAFE_FILE_LENGTH);
  if (!safeCandidates.length || !["sitemap", "indexing"].includes(finding.category)) return null;
  const parsed = await llm.json<Record<string, unknown>>({
    system: "Propose a minimal, reviewable SEO configuration fix using only the supplied finding and existing files. You may return one existing file path from the supplied files and complete replacement content. Do not invent site URLs, routes, business facts, credentials, or change application logic. If evidence does not support a safe correction, set skip to true and leave the other fields empty.",
    user: JSON.stringify({ finding: { category: finding.category, title: finding.title, summary: finding.summary, evidence: finding.evidence }, files: safeCandidates }),
    schema: changeSchema,
    maxTokens: 16000,
    effort: "medium",
  });
  if (parsed.skip === true || typeof parsed.path !== "string" || !SAFE_SEO_CONFIG_PATHS.has(parsed.path)) return null;
  if (!safeCandidates.some((file) => file.path === parsed.path) || typeof parsed.content !== "string" || parsed.content.length > MAX_SAFE_FILE_LENGTH || !isPlainRobotsTxt(parsed.content)) return null;
  if (typeof parsed.title !== "string" || parsed.title.length < 8 || parsed.title.length > 100 || typeof parsed.reason !== "string" || parsed.reason.length < 10 || parsed.reason.length > 500) return null;
  return { title: parsed.title, reason: parsed.reason, path: parsed.path, content: parsed.content };
}
