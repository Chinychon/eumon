import type { Finding } from "@organic-growth/core";

const allowedFiles = new Set(["public/robots.txt", "app/robots.ts", "src/app/robots.ts", "app/sitemap.ts", "src/app/sitemap.ts"]);

interface WorkersAI { run(model: string, input: Record<string, unknown>): Promise<unknown> }

/** Generates a tightly scoped SEO configuration proposal from observed evidence and existing file contents. */
export async function generateSafeTechnicalChange(
  ai: WorkersAI,
  finding: Pick<Finding, "category" | "title" | "summary" | "evidence">,
  candidates: Array<{ path: string; content: string }>,
): Promise<{ title: string; reason: string; path: string; content: string } | null> {
  const safeCandidates = candidates.filter((file) => allowedFiles.has(file.path) && file.content.length <= 40_000);
  if (!safeCandidates.length || !["sitemap", "indexing"].includes(finding.category)) return null;
  const response = await ai.run("@cf/google/gemma-4-26b-a4b-it", {
    messages: [
      { role: "system", content: "Propose a minimal, reviewable SEO configuration fix using only the supplied finding and existing files. You may return one existing file path from the supplied files and complete replacement content. Do not invent site URLs, routes, business facts, credentials, or change application logic. If evidence does not support a safe correction, return {\"skip\":true}. Return JSON: {title,reason,path,content} or {skip:true}." },
      { role: "user", content: JSON.stringify({ finding: { category: finding.category, title: finding.title, summary: finding.summary, evidence: finding.evidence }, files: safeCandidates }) },
    ], response_format: { type: "json_object" }, max_tokens: 1800,
  });
  const root = response as { response?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
  const output = typeof root.response === "string" ? root.response : root.choices?.[0]?.message?.content;
  if (typeof output !== "string") return null;
  const parsed = JSON.parse(output) as Record<string, unknown>;
  if (parsed.skip === true || typeof parsed.path !== "string" || !allowedFiles.has(parsed.path)) return null;
  if (!safeCandidates.some((file) => file.path === parsed.path) || typeof parsed.content !== "string" || parsed.content.length > 40_000) return null;
  if (typeof parsed.title !== "string" || parsed.title.length < 8 || parsed.title.length > 100 || typeof parsed.reason !== "string" || parsed.reason.length < 10 || parsed.reason.length > 500) return null;
  return { title: parsed.title, reason: parsed.reason, path: parsed.path, content: parsed.content };
}
