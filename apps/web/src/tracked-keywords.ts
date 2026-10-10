import { normalizeKeyword, TRACKED_KEYWORDS_MAX } from "@organic-growth/core";

/** The request body of PUT /api/sites/:id/keywords: up to 30 keywords, 2–80 characters each once normalised, de-duplicated. */
export function parseTrackedKeywords(body: unknown): { keywords: string[] } | { error: string } {
  const list = (body as { keywords?: unknown } | null)?.keywords;
  if (!Array.isArray(list)) return { error: "Send a list of keywords." };
  if (list.length > TRACKED_KEYWORDS_MAX) return { error: `Track up to ${TRACKED_KEYWORDS_MAX} keywords.` };
  const keywords: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") return { error: "Each keyword must be text." };
    const keyword = normalizeKeyword(entry);
    if (keyword.length < 2 || keyword.length > 80) return { error: "Each keyword must be 2 to 80 characters." };
    if (!keywords.includes(keyword)) keywords.push(keyword);
  }
  return { keywords };
}
