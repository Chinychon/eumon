import { schema, type JsonLlm } from "@organic-growth/ai";
import { slugify, type DataRecord, type Dataset, type FaqPattern, type PageIdea, type PageTemplate } from "@organic-growth/core";
import { fieldCoverage, normalizeMountPath } from "./generate.js";
import { languageName } from "./labels.js";
import { placeholders } from "./patterns.js";

type TemplateDraft = Omit<PageTemplate, "id" | "siteId" | "datasetId" | "status" | "createdAt" | "updatedAt">;

const OPERATORS = new Set(["count", "year", "site", "entity", "entities", "names", "min", "max", "avg", "top"]);

/** Placeholders that do not refer to a known field or operator. */
export function unknownPlaceholders(pattern: string, dataset: Pick<Dataset, "fields">): string[] {
  const keys = new Set(dataset.fields.map((field) => field.key));
  return placeholders(pattern).filter((token) => {
    const [op, key] = token.split(":");
    if (OPERATORS.has(op!)) return ["min", "max", "avg", "top"].includes(op!) ? !keys.has(key ?? "") : false;
    return !keys.has(op!);
  });
}

/** Data-only fallback copy (used when no language model is configured): factual, never invented. */
const FALLBACK_COPY: Record<string, {
  entityDescription: string;
  entityIntro: (facts: string) => string;
  and: string;
  keyFacts: string;
  groupTitle: (count: string, name: string, group: string) => string;
  groupDescription: (name: string, group: string) => string;
  groupIntro: (name: string, group: string) => string;
  range: (label: string, min: string, max: string) => string;
  groupIn: string;
}> = {
  en: {
    entityDescription: "Everything you need to know about {KEY}. Compare details and get in touch with {site}.",
    entityIntro: (facts) => `Here is what you need to know about {KEY}: ${facts}. {site} can help with next steps — get in touch for current details and availability.`,
    and: "and", keyFacts: "the key facts",
    groupTitle: (count, name, group) => `${count} ${name}: ${group} ({year})`,
    groupDescription: (name, group) => `Compare {count} ${name.toLowerCase()} for ${group}, including {names}.`,
    groupIntro: (name, group) => `There are {count} ${name.toLowerCase()} listed for ${group}, including {names}.`,
    range: (label, min, max) => `${label} ranges from ${min} to ${max}.`,
    groupIn: " in ",
  },
  id: {
    entityDescription: "Semua yang perlu Anda ketahui tentang {KEY}. Bandingkan detailnya dan hubungi {site}.",
    entityIntro: (facts) => `Berikut informasi penting tentang {KEY}: ${facts}. {site} siap membantu langkah selanjutnya — hubungi kami untuk detail dan ketersediaan terbaru.`,
    and: "dan", keyFacts: "fakta utamanya",
    groupTitle: (count, name, group) => `${count} ${name}: ${group} ({year})`,
    groupDescription: (name, group) => `Bandingkan {count} ${name.toLowerCase()} untuk ${group}, termasuk {names}.`,
    groupIntro: (name, group) => `Ada {count} ${name.toLowerCase()} untuk ${group}, termasuk {names}.`,
    range: (label, min, max) => `${label} berkisar antara ${min} hingga ${max}.`,
    groupIn: " di ",
  },
  ms: {
    entityDescription: "Semua yang anda perlu tahu tentang {KEY}. Bandingkan butiran dan hubungi {site}.",
    entityIntro: (facts) => `Berikut perkara penting tentang {KEY}: ${facts}. {site} boleh membantu langkah seterusnya — hubungi kami untuk butiran dan ketersediaan terkini.`,
    and: "dan", keyFacts: "fakta utamanya",
    groupTitle: (count, name, group) => `${count} ${name}: ${group} ({year})`,
    groupDescription: (name, group) => `Bandingkan {count} ${name.toLowerCase()} untuk ${group}, termasuk {names}.`,
    groupIntro: (name, group) => `Terdapat {count} ${name.toLowerCase()} untuk ${group}, termasuk {names}.`,
    range: (label, min, max) => `${label} antara ${min} hingga ${max}.`,
    groupIn: " di ",
  },
};

/** A sound, data-only template used when no model is available or as a starting point. */
export function defaultTemplate(dataset: Pick<Dataset, "name" | "entityType" | "fields" | "keyField">, idea: Pick<PageIdea, "name" | "groupBy">, mountPath: string, language = "en"): TemplateDraft {
  const copy = FALLBACK_COPY[language.toLowerCase().split("-")[0]!] ?? FALLBACK_COPY.en!;
  const mount = normalizeMountPath(mountPath);
  const entitySlug = slugify(dataset.name) || "items";
  const key = dataset.keyField;
  const itemFields = dataset.fields.filter((field) => field.key !== key).slice(0, 8).map((field) => field.key);
  const firstNumber = dataset.fields.find((field) => field.type === "number");
  if (idea.groupBy.length === 0) {
    const labels = dataset.fields.filter((field) => itemFields.includes(field.key)).slice(0, 5).map((field) => field.label.toLowerCase());
    const labelList = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} ${copy.and} ${labels.at(-1)}` : labels[0] ?? copy.keyFacts;
    return {
      name: idea.name || `${dataset.name} pages`,
      groupBy: [],
      pathPattern: `${mount}/${entitySlug}/{${key}}`,
      titlePattern: `{${key}} | {site}`,
      descriptionPattern: copy.entityDescription.replace("{KEY}", `{${key}}`),
      h1Pattern: `{${key}}`,
      introPattern: copy.entityIntro(labelList).replace("{KEY}", `{${key}}`),
      itemTitleField: key,
      itemFields,
      sortDir: "asc",
      minRecords: 1,
      faq: [],
    };
  }
  const groupLabel = idea.groupBy.map((field) => `{${field}}`).join(copy.groupIn);
  return {
    name: idea.name || `${dataset.name} by ${idea.groupBy.join(" & ")}`,
    groupBy: idea.groupBy,
    pathPattern: `${mount}/${entitySlug}/${idea.groupBy.map((field) => `{${field}}`).join("-in-")}`,
    titlePattern: copy.groupTitle("{count}", dataset.name, groupLabel),
    descriptionPattern: copy.groupDescription(dataset.name, groupLabel),
    h1Pattern: `${dataset.name}: ${groupLabel}`,
    introPattern: `${copy.groupIntro(dataset.name, groupLabel)}${firstNumber ? ` ${copy.range(firstNumber.label, `{min:${firstNumber.key}}`, `{max:${firstNumber.key}}`)}` : ""}`,
    itemTitleField: key,
    itemFields,
    sortBy: firstNumber?.key,
    sortDir: "asc",
    minRecords: 3,
    faq: [],
  };
}

const TEMPLATE_SYSTEM = `You design a programmatic landing-page template. One template renders many pages from structured data.

Each page is a landing page: it should describe exactly what the searcher is looking for and move them toward the business's conversion.

Write patterns using {placeholders}. Available placeholders:
- {field_key} — a dataset field (only these keys exist: see fields). On grouped pages only the group-by fields are reliable.
- {count} — number of records on the page; {names} — first three record names
- {min:field}, {max:field}, {avg:field} — numeric aggregates; {top:field} — most common values
- {site} — business name; {year} — current year; {entity} / {entities} — entity type singular / dataset name

Rules:
- titlePattern: under 60 characters when filled, primary search phrase first, matching how people search (see example queries).
- descriptionPattern: one or two sentences, under 155 characters, with a reason to click.
- h1Pattern: the page's main heading.
- introPattern: 2–4 sentences, factual, built from placeholders. A sentence whose placeholder is empty is dropped automatically, so make each sentence independent. Never state facts that are not in the data.
- pathPattern must start with the mount path and contain placeholders that make every page unique (for grouped pages: every group-by field; for entity pages: the key field).
- itemFields: the fields to display for each record, most persuasive first (6–10). Prefer fields with high coverage (see fieldCoverage); a field almost no record has will rarely show.
- faq: 3–5 questions searchers actually ask, answered only from placeholders (no outside facts, no medical/legal/financial advice). Build answers on fields with good coverage; an answer whose placeholder is empty is dropped from that page.
- Do not invent fields. Do not add marketing claims the data cannot support.`;

const templateSchema = schema.object({
  name: schema.string(),
  pathPattern: schema.string(),
  titlePattern: schema.string(),
  descriptionPattern: schema.string(),
  h1Pattern: schema.string(),
  introPattern: schema.string(),
  itemFields: schema.array(schema.string()),
  sortBy: schema.nullable(schema.string()),
  sortDir: schema.enum(["asc", "desc"]),
  minRecords: schema.number(),
  faq: schema.array(schema.object({ question: schema.string(), answer: schema.string() })),
});

/**
 * Asks the model for copy patterns, then keeps only what validates against
 * the dataset: unknown placeholders and fields fall back to the default.
 */
export async function proposeTemplate(input: {
  llm: JsonLlm;
  dataset: Pick<Dataset, "name" | "entityType" | "description" | "fields" | "keyField">;
  idea: PageIdea;
  sampleRecords: DataRecord[];
  /** All records (or a large sample), to tell the model which fields are actually filled. */
  coverageRecords?: DataRecord[];
  siteName: string;
  businessContext?: string;
  mountPath: string;
  /** Language the copy is written in (BCP 47); defaults to English. */
  language?: string;
}): Promise<TemplateDraft> {
  const fallback = defaultTemplate(input.dataset, input.idea, input.mountPath, input.language);
  const raw = await input.llm.json<Record<string, unknown>>({
    system: `${TEMPLATE_SYSTEM}\n- Write every pattern (title, description, h1, intro, FAQ) in ${languageName(input.language)}, the language the page is published in, as a native copywriter would. Keep {placeholders} exactly as given.`,
    user: JSON.stringify({
      business: { name: input.siteName, context: input.businessContext ?? "" },
      mountPath: normalizeMountPath(input.mountPath) || "/",
      dataset: { name: input.dataset.name, entityType: input.dataset.entityType, description: input.dataset.description, keyField: input.dataset.keyField, fields: input.dataset.fields },
      pageIdea: input.idea,
      sampleRecords: input.sampleRecords.slice(0, 5).map((record) => record.data),
      fieldCoverage: Object.fromEntries([...fieldCoverage(input.coverageRecords ?? input.sampleRecords, input.dataset.fields.map((field) => field.key))]
        .map(([key, share]) => [key, `${Math.round(share * 100)}% of records`])),
    }),
    schema: templateSchema,
    maxTokens: 8000,
    effort: "medium",
  });
  const valid = (value: unknown, max: number): value is string =>
    typeof value === "string" && value.trim().length > 0 && value.length <= max && unknownPlaceholders(value, input.dataset).length === 0;
  const keys = new Set(input.dataset.fields.map((field) => field.key));
  const mount = normalizeMountPath(input.mountPath);
  const pathOk = valid(raw.pathPattern, 200)
    && (raw.pathPattern as string).startsWith(`${mount}/`)
    && (input.idea.groupBy.length
      ? input.idea.groupBy.every((field) => (raw.pathPattern as string).includes(`{${field}}`))
      : (raw.pathPattern as string).includes(`{${input.dataset.keyField}}`));
  const itemFields = Array.isArray(raw.itemFields) ? raw.itemFields.map(String).filter((key) => keys.has(key)).slice(0, 12) : [];
  const faq: FaqPattern[] = Array.isArray(raw.faq)
    ? raw.faq.flatMap((entry) => {
      const item = entry as Record<string, unknown>;
      return valid(item.question, 200) && valid(item.answer, 800) ? [{ question: item.question, answer: item.answer }] : [];
    }).slice(0, 6)
    : [];
  const minRecords = typeof raw.minRecords === "number" && raw.minRecords >= 1 ? Math.min(Math.round(raw.minRecords), 50) : fallback.minRecords;
  return {
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.slice(0, 80) : fallback.name,
    groupBy: input.idea.groupBy,
    pathPattern: pathOk ? raw.pathPattern as string : fallback.pathPattern,
    titlePattern: valid(raw.titlePattern, 120) ? raw.titlePattern : fallback.titlePattern,
    descriptionPattern: valid(raw.descriptionPattern, 300) ? raw.descriptionPattern : fallback.descriptionPattern,
    h1Pattern: valid(raw.h1Pattern, 120) ? raw.h1Pattern : fallback.h1Pattern,
    introPattern: valid(raw.introPattern, 1500) ? raw.introPattern : fallback.introPattern,
    itemTitleField: input.dataset.keyField,
    itemFields: itemFields.length >= 2 ? itemFields : fallback.itemFields,
    sortBy: typeof raw.sortBy === "string" && keys.has(raw.sortBy) ? raw.sortBy : fallback.sortBy,
    sortDir: raw.sortDir === "desc" ? "desc" : "asc",
    minRecords: input.idea.groupBy.length ? Math.max(2, minRecords) : 1,
    faq,
  };
}
