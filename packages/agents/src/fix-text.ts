import { schema, type JsonLlm } from "@organic-growth/ai";
import { placeholders } from "@organic-growth/fixes";

/*
 * The words of a fix: the subject and qualifier of a title, a description pattern, and which page
 * values fill which schema.org fields. Code makes the edit; the AI only writes these, under the
 * guardrails that worked in MedBay's content scripts: facts first, a closed set of variables,
 * every value grounded in a sample page, banned claims, one targeted retry, an independent check,
 * and a skip escape.
 */

export const FIX_PROMPT_VERSION = "fix-text-1";

export type FixSample = { url: string; title?: string; h1?: string; description?: string; text: string };
export type FixTextInput = { kind: "head" | "jsonld"; siteName: string; language: string; problems: string[]; paths: string[]; dynamic: boolean; schemaType?: string; samples: FixSample[]; queries: string[] };
export type FixText = {
  facts: string[];
  titleSubject: string | null;
  titleQualifier: string | null;
  description: string | null;
  schema: Array<{ field: string; path: string }>;
  examples: Array<{ url: string; values: Array<{ path: string; value: string }> }>;
};
export type FixTextResult = { ok: true; text: FixText; warnings: string[] } | { ok: false; reason: string };

const BANNED = ["leading", "renowned", "best", "world-class", "award-winning", "top", "premier", "trusted", "famous", "number one"];
const FUNCTION_WORDS: Record<string, string[]> = {
  id: ["yang", "dan", "di", "untuk", "dengan", "dari", "ini", "atau", "ke", "pada"],
  ms: ["yang", "dan", "di", "untuk", "dengan", "dari", "ini", "atau", "ke", "pada"],
  en: ["the", "and", "for", "with", "of", "in", "to", "a", "your", "at"],
};
const norm = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

export function render(pattern: string, values: Map<string, string>): string {
  return pattern.replace(/\{([\w$.]+)\}/g, (_, path: string) => values.get(path) ?? `{${path}}`);
}

export function titleOf(text: FixText, values: Map<string, string>, siteName: string, dynamic: boolean): string | null {
  if (!text.titleSubject) return null;
  const subject = dynamic ? values.get(text.titleSubject) ?? "" : text.titleSubject;
  return `${subject}${text.titleQualifier ? ` ${text.titleQualifier}` : ""} | ${siteName}`;
}

/** Every reason the text can't be used. Codes before the colon: `length` and `language` may be retried; the rest can't. */
export function checkFixText(input: FixTextInput, text: FixText): string[] {
  const errors: string[] = [];
  const allowed = new Set(input.paths);
  const used = new Set<string>([
    ...(text.description ? placeholders(text.description) : []),
    ...(input.dynamic && text.titleSubject ? [text.titleSubject] : []),
    ...text.schema.map((s) => s.path),
  ]);
  for (const path of used) if (!allowed.has(path)) errors.push(`fact: unknown variable ${path}`);
  if (!input.dynamic && text.description && placeholders(text.description).length) errors.push("fact: a static page can't use variables");
  for (const s of text.schema) if (!/^[a-zA-Z]+$/.test(s.field)) errors.push(`fact: bad schema field ${s.field}`);
  if (input.kind === "head" && input.problems.some((p) => p.startsWith("title")) && !text.titleSubject) errors.push("fact: no title");
  if (input.kind === "head" && input.problems.some((p) => p.startsWith("description")) && !text.description) errors.push("fact: no description");
  if (input.kind === "jsonld" && !text.schema.some((s) => s.field === "name")) errors.push("fact: structured data needs a name");

  const corpus = norm(input.samples.map((s) => [s.title, s.h1, s.description, s.text].join(" ")).join(" "));
  for (const sample of input.samples) {
    const example = text.examples.find((e) => e.url === sample.url);
    if (!example) { errors.push(`fact: no example values for ${sample.url}`); continue; }
    const pageText = norm([sample.title, sample.h1, sample.description, sample.text].join(" "));
    const values = new Map(example.values.map((v) => [v.path, v.value]));
    for (const path of used) {
      const value = values.get(path);
      if (!value) errors.push(`fact: no example value for ${path} on ${sample.url}`);
      else if (!pageText.includes(norm(value))) errors.push(`fact: "${value}" for ${path} isn't on ${sample.url}`);
    }
    const title = titleOf(text, values, input.siteName, input.dynamic);
    if (title && title.length > 65) errors.push(`length: the title is ${title.length} characters on ${sample.url} (65 at most)`);
    if (text.description) {
      const description = render(text.description, values);
      if (description.length < 70 || description.length > 160) errors.push(`length: the description is ${description.length} characters on ${sample.url} (70 to 160)`);
      const words = norm(description).split(/[^\p{L}]+/u);
      const lang = input.language.slice(0, 2);
      const expected = FUNCTION_WORDS[lang];
      if (expected && !words.some((w) => expected.includes(w))) errors.push(`language: the description isn't in "${lang}"`);
    }
  }
  const prose = norm([text.titleQualifier ?? "", text.description ?? "", input.dynamic ? "" : text.titleSubject ?? ""].join(" "));
  for (const word of BANNED) if (new RegExp(`(^|[^\\p{L}])${word}([^\\p{L}]|$)`, "u").test(prose) && !corpus.includes(word)) errors.push(`claim: "${word}" isn't used on the site`);
  for (const number of (text.description ?? "").replace(/\{[\w$.]+\}/g, " ").match(/\d[\d,.]*/g) ?? []) if (!corpus.includes(number.replace(/[.,]$/, ""))) errors.push(`fact: the number ${number} isn't on the site`);
  if (text.titleQualifier) {
    if (!input.queries.length) errors.push("qualifier: without Search Console queries there's nothing to base a qualifier on");
    else {
      const queries = norm(input.queries.join(" "));
      for (const word of norm(text.titleQualifier).split(" ").filter((w) => w.length > 2)) if (!queries.includes(word)) errors.push(`qualifier: "${word}" isn't in the site's search queries`);
    }
  }
  return errors;
}

const SYSTEM = [
  "You write search-result text for one route of a website. Code puts it into the page; you supply only words.",
  "RULES",
  "1. Facts first: list in `facts` the facts you will use, each taken from the sample pages. Use nothing else.",
  "2. Invent nothing. Every name, number, place and claim must appear in the samples.",
  "3. Dynamic routes: write patterns with {placeholders}; each placeholder must be one of `paths`, exactly. Static routes: plain text, no placeholders.",
  "4. titleSubject: for a dynamic route, the path whose value names the page (e.g. procedure.name); for a static route, the words that name it. Code adds \" | <site name>\".",
  "5. titleQualifier: 1 to 4 words that the site's search queries add (e.g. \"Cost in Malaysia\"), or null. Null when there are no queries.",
  "6. description: 120 to 155 characters once rendered, in the site's language; what the page offers and why to click. Never leading, best, renowned, top, trusted, world-class, award-winning, premier, famous unless the samples say so.",
  "7. schema (structured data only): map schema.org fields of the given type to paths, e.g. {field: \"name\", path: \"procedure.name\"}. Always include name. Otherwise return [].",
  "8. examples: for EVERY sample url, the value of each path you used on that page, copied exactly from the page.",
  "9. If the samples don't support good text, return skip: true and say why. Skipping beats guessing.",
].join("\n");

const CHECK_SYSTEM = "You check search-result text against the pages it describes. supported = false if any title or description states something the page facts don't support (a number, a name, a claim), or makes an advertising claim the page doesn't make. List each problem briefly.";

const FIX_SCHEMA = schema.object({
  skip: schema.boolean("true when the samples don't support good text"),
  reason: schema.string(),
  facts: schema.array(schema.string()),
  titleSubject: schema.nullable(schema.string()),
  titleQualifier: schema.nullable(schema.string()),
  description: schema.nullable(schema.string()),
  schema: schema.array(schema.object({ field: schema.string(), path: schema.string() })),
  examples: schema.array(schema.object({ url: schema.string(), values: schema.array(schema.object({ path: schema.string(), value: schema.string() })) })),
});
const CHECK_SCHEMA = schema.object({ supported: schema.boolean(), problems: schema.array(schema.string()) });

type Answer = FixText & { skip: boolean; reason: string };

export async function writeFixText(llm: JsonLlm, input: FixTextInput, budget: { calls: number }): Promise<FixTextResult> {
  const task = input.kind === "head" ? "title and description" : `structured data of type ${input.schemaType}`;
  const ask = async (extra: string): Promise<Answer | null> => {
    if (budget.calls <= 0) return null;
    budget.calls -= 1;
    return llm.json<Answer>({ system: SYSTEM, user: JSON.stringify({ task, ...input }) + extra, schema: FIX_SCHEMA, maxTokens: 1500, effort: "low" });
  };
  let answer = await ask("");
  if (!answer) return { ok: false, reason: "The AI budget for this analysis is used up; the fix is offered as a snippet instead." };
  if (answer.skip) return { ok: false, reason: answer.reason || "The pages had too little to write from." };
  let errors = checkFixText(input, answer);
  if (errors.length && errors.every((e) => e.startsWith("length:") || e.startsWith("language:"))) {
    const retry = await ask(`\n\nYour last answer was rejected: ${errors.join("; ")}. Fix only that and answer again.`);
    if (retry && !retry.skip) { answer = retry; errors = checkFixText(input, answer); }
  }
  if (errors.length) return { ok: false, reason: `The written text didn't pass the checks: ${errors.slice(0, 3).join("; ")}.` };
  if (input.kind === "jsonld") return { ok: true, text: answer, warnings: [] };
  if (budget.calls <= 0) return { ok: true, text: answer, warnings: ["Not independently checked: the AI budget ran out."] };
  budget.calls -= 1;
  const final = answer;
  const outputs = input.samples.map((sample) => {
    const values = new Map((final.examples.find((e) => e.url === sample.url)?.values ?? []).map((v) => [v.path, v.value]));
    return { url: sample.url, title: titleOf(final, values, input.siteName, input.dynamic), description: final.description ? render(final.description, values) : null };
  });
  const check = await llm.json<{ supported: boolean; problems: string[] }>({
    system: CHECK_SYSTEM,
    user: JSON.stringify({ facts: input.samples.map((s) => ({ url: s.url, title: s.title, h1: s.h1, text: s.text })), outputs }),
    schema: CHECK_SCHEMA, maxTokens: 600, effort: "low",
  });
  if (!check.supported) return { ok: false, reason: `The independent check found unsupported claims: ${check.problems.slice(0, 2).join("; ")}.` };
  return { ok: true, text: final, warnings: [] };
}
