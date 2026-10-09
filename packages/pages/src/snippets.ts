import { schema, type JsonLlm } from "@organic-growth/ai";
import type { GeneratedPage } from "@organic-growth/core";
import { languageName } from "./labels.js";

export type SnippetOption = { title: string; description: string; rationale: string };

const SNIPPET_SYSTEM = `You rewrite the search snippet (title tag and meta description) of one landing page to win more clicks from the searches it already appears for.

Rules:
- Use only facts present in the page summary. Do not invent prices, rankings, awards, guarantees, or claims.
- Lead with the words searchers actually use (see queries), then the most compelling concrete fact.
- Titles: 40–60 characters. Descriptions: 120–155 characters, ending with a reason to click.
- Offer three genuinely different angles (e.g. price-led, trust-led, specificity-led).
- "rationale" is one short sentence on which queries the option targets.`;

export async function suggestSnippets(input: {
  llm: JsonLlm;
  page: Pick<GeneratedPage, "title" | "description" | "h1" | "intro" | "items" | "faq">;
  siteName: string;
  queries: Array<{ query: string; impressions: number; position: number; clicks: number }>;
  /** Language the page is published in; options are written in it. */
  language?: string;
}): Promise<SnippetOption[]> {
  const result = await input.llm.json<{ options?: unknown[] }>({
    system: `${SNIPPET_SYSTEM}\n- Write the titles and descriptions in ${languageName(input.language)}, the page's language.`,
    user: JSON.stringify({
      site: input.siteName,
      current: { title: input.page.title, description: input.page.description },
      page: {
        h1: input.page.h1,
        intro: input.page.intro.slice(0, 1200),
        facts: input.page.items.slice(0, 5).map((item) => ({ name: item.title, fields: item.fields.slice(0, 8) })),
        faq: input.page.faq.slice(0, 4).map((entry) => entry.question),
      },
      queries: input.queries.slice(0, 15),
    }),
    schema: schema.object({
      options: schema.array(schema.object({ title: schema.string(), description: schema.string(), rationale: schema.string() })),
    }),
    maxTokens: 4000,
    effort: "medium",
  });
  return (Array.isArray(result.options) ? result.options : []).flatMap((entry) => {
    const option = entry as Record<string, unknown>;
    if (typeof option.title !== "string" || typeof option.description !== "string") return [];
    const title = option.title.trim();
    const description = option.description.trim();
    if (title.length < 15 || title.length > 75 || description.length < 50 || description.length > 200) return [];
    return [{ title, description, rationale: typeof option.rationale === "string" ? option.rationale.slice(0, 200) : "" }];
  }).slice(0, 3);
}
