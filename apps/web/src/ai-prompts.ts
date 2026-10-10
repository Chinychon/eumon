import { isQuestionQuery } from "@organic-growth/agents";
import { AI_BRAND_NAMES_MAX, AI_PROMPTS_MAX, normalizePrompt } from "@organic-growth/core";

/** PUT /api/sites/:id/ai-prompts: up to 25 questions (5–200 characters) and 5 brand names (2–60), trimmed, de-duplicated case-insensitively. */
export function parseAiPrompts(body: unknown): { prompts: string[]; brandNames: string[] } | { error: string } {
  const input = body as { prompts?: unknown; brandNames?: unknown } | null;
  if (!Array.isArray(input?.prompts) || !Array.isArray(input?.brandNames)) return { error: "Send a list of questions and a list of brand names." };
  if (input.prompts.length > AI_PROMPTS_MAX) return { error: `Track up to ${AI_PROMPTS_MAX} questions.` };
  if (input.brandNames.length > AI_BRAND_NAMES_MAX) return { error: `Give up to ${AI_BRAND_NAMES_MAX} brand names.` };
  const unique = (list: unknown[], min: number, max: number, what: string): string[] | { error: string } => {
    const out: string[] = [];
    for (const entry of list) {
      if (typeof entry !== "string") return { error: `Each ${what} must be text.` };
      const value = normalizePrompt(entry);
      if (value.length < min || value.length > max) return { error: `Each ${what} must be ${min} to ${max} characters.` };
      if (!out.some((seen) => seen.toLowerCase() === value.toLowerCase())) out.push(value);
    }
    return out;
  };
  const prompts = unique(input.prompts, 5, 200, "question");
  if ("error" in prompts) return prompts;
  const brandNames = unique(input.brandNames, 2, 60, "brand name");
  if ("error" in brandNames) return brandNames;
  return { prompts, brandNames };
}

/** The site's own question searches (Search Console), most impressions first, that aren't tracked yet: at most 10, never invented. */
export function promptSuggestions(queries: Array<{ query: string; impressions: number }>, current: string[]): string[] {
  const listed = new Set(current.map((prompt) => prompt.toLowerCase()));
  return queries.filter((row) => isQuestionQuery(row.query) && !listed.has(row.query.toLowerCase()))
    .sort((a, b) => b.impressions - a.impressions).slice(0, 10).map((row) => row.query);
}
