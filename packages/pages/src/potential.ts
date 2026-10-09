import type { DataRecord, Dataset, PageIdea } from "@organic-growth/core";
import { fieldCoverage, groupRecords } from "./generate.js";
import { formatValue } from "./patterns.js";

/** How many landing pages one page idea (or a suggested grouping) supports with the data collected so far. */
export type PagePotential = {
  name: string;
  groupBy: string[];
  /** Pages that would pass the quality gate. */
  pages: number;
  /** Pages the data could produce before quality checks. */
  candidates: number;
  /** Too few facts (entity pages) or too few records (grouped pages) to publish. */
  thin: number;
  /** Grouped pages that would list exactly the same records as another page. */
  duplicates: number;
  /** The largest groups, e.g. "Cardiology · Penang (14)". */
  examples: string[];
  /** Not one of the dataset's page ideas: a grouping the data supports that nobody proposed yet. */
  suggested: boolean;
};

/** Same thresholds as page generation, so estimates match what will be published. */
const MIN_ENTITY_FILL_RATIO = 0.4;
const MIN_FIELD_COVERAGE = 0.2;
const MIN_GROUP_RECORDS = 3;

function entityPotential(dataset: Pick<Dataset, "fields" | "keyField">, records: DataRecord[], idea: Pick<PageIdea, "name">): PagePotential {
  const keys = dataset.fields.filter((field) => field.key !== dataset.keyField).map((field) => field.key);
  const coverage = fieldCoverage(records, keys);
  const expected = keys.filter((key) => (coverage.get(key) ?? 0) >= MIN_FIELD_COVERAGE);
  const filled = (record: DataRecord) => expected.filter((key) => formatValue(record.data[key] ?? null)).length;
  const pages = expected.length ? records.filter((record) => filled(record) / expected.length >= MIN_ENTITY_FILL_RATIO).length : 0;
  return {
    name: idea.name,
    groupBy: [],
    pages,
    candidates: records.length,
    thin: records.length - pages,
    duplicates: 0,
    examples: [],
    suggested: false,
  };
}

function groupedPotential(dataset: Pick<Dataset, "fields">, records: DataRecord[], idea: Pick<PageIdea, "name" | "groupBy">, suggested: boolean): PagePotential {
  const fields = new Map(dataset.fields.map((field) => [field.key, field]));
  const groups = groupRecords(records, idea.groupBy, fields);
  const seen = new Set<string>();
  let pages = 0;
  let thin = 0;
  let duplicates = 0;
  const kept: Array<{ label: string; size: number }> = [];
  for (const group of [...groups].sort((a, b) => b.records.length - a.records.length)) {
    if (group.records.length < MIN_GROUP_RECORDS) {
      thin++;
      continue;
    }
    const signature = group.records.map((record) => record.id).sort().join(",");
    if (seen.has(signature)) {
      duplicates++;
      continue;
    }
    seen.add(signature);
    pages++;
    kept.push({ label: idea.groupBy.map((key) => group.values[key]).join(" · "), size: group.records.length });
  }
  return {
    name: idea.name,
    groupBy: idea.groupBy,
    pages,
    candidates: groups.length,
    thin,
    duplicates,
    examples: kept.slice(0, 3).map((group) => `${group.label} (${group.size})`),
    suggested,
  };
}

/**
 * Text and list fields whose values repeat across records (cities,
 * specialties, categories) — the attributes people combine with an entity
 * type when they search ("cardiologists in Penang").
 */
function groupableFields(dataset: Pick<Dataset, "fields" | "keyField">, records: DataRecord[]): string[] {
  return dataset.fields
    .filter((field) => field.key !== dataset.keyField && (field.type === "text" || field.type === "list"))
    .map((field) => {
      const values = new Map<string, number>();
      for (const record of records) {
        const raw = record.data[field.key];
        for (const value of Array.isArray(raw) ? raw : [raw]) {
          const text = formatValue(value ?? null).toLowerCase();
          if (text && text.length <= 60) values.set(text, (values.get(text) ?? 0) + 1);
        }
      }
      const repeated = [...values.values()].filter((count) => count >= MIN_GROUP_RECORDS).length;
      return { key: field.key, repeated, distinct: values.size };
    })
    // Repeating values, but not so few that every page lists half the dataset.
    .filter((field) => field.repeated >= 2 && field.distinct <= Math.max(records.length * 0.6, 3))
    .sort((a, b) => b.repeated - a.repeated)
    .map((field) => field.key);
}

/**
 * Answers "how many landing pages can this data support?": each page idea's
 * publishable page count, plus groupings the data supports that no page idea
 * covers yet. Estimates use the generator's own thresholds; actual pages also
 * depend on the template's copy.
 */
export function estimatePagePotential(
  dataset: Pick<Dataset, "fields" | "keyField" | "pageIdeas" | "entityType">,
  records: DataRecord[],
): PagePotential[] {
  const ideas = dataset.pageIdeas.length ? dataset.pageIdeas : [{ name: `One page per ${dataset.entityType}`, groupBy: [] }];
  const estimates = ideas.map((idea) => (idea.groupBy.length ? groupedPotential(dataset, records, idea, false) : entityPotential(dataset, records, idea)));
  const covered = new Set(ideas.map((idea) => [...idea.groupBy].sort().join("+")));
  const groupable = groupableFields(dataset, records).slice(0, 4);
  const label = (key: string) => dataset.fields.find((field) => field.key === key)?.label ?? key;
  const combos = [...groupable.map((key) => [key]), ...(groupable.length >= 2 ? [[groupable[0]!, groupable[1]!]] : [])];
  for (const groupBy of combos) {
    if (covered.has([...groupBy].sort().join("+"))) continue;
    const estimate = groupedPotential(dataset, records, { name: `${dataset.entityType} by ${groupBy.map(label).join(" × ")}`, groupBy }, true);
    if (estimate.pages >= 2) estimates.push(estimate);
  }
  return estimates;
}
