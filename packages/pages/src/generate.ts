import type {
  DataRecord,
  Dataset,
  DatasetField,
  FaqPattern,
  GeneratedPage,
  JsonObject,
  JsonValue,
  PageItem,
  PageLink,
  PageTemplate,
} from "@organic-growth/core";
import { slugify } from "@organic-growth/core";
import { fillPattern, fillProse, formatValue, truncateAtWord, type Resolver } from "./patterns.js";

export type GenerationInput = {
  siteId: string;
  siteName: string;
  template: PageTemplate;
  dataset: Pick<Dataset, "name" | "entityType" | "fields" | "keyField">;
  records: DataRecord[];
  mountPath: string;
  /**
   * Live pages from other templates keyed by the slug of their entity name,
   * so a doctor's "hospital" value can link to that hospital's page.
   */
  entityLinks?: Map<string, PageLink>;
  /**
   * URLs already in use (group key → path) for pages that are or were live.
   * They are kept as-is so published URLs never change, and so related links
   * computed here point at the real URLs.
   */
  stablePaths?: Map<string, string>;
  now?: Date;
  createId?: () => string;
};

type Group = { key: string; values: Record<string, string>; records: DataRecord[] };

const MAX_ITEMS_PER_PAGE = 100;
const MIN_ENTITY_FILL_RATIO = 0.4;
/** A field counts toward page quality only if this share of records has it. */
const MIN_FIELD_COVERAGE = 0.2;
const MIN_ENTITY_TEXT = 250;

/** Normalizes a mount path to `/segment` form, or `` for the site root. */
export function normalizeMountPath(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+/, "").split("/").map(slugify).filter(Boolean).join("/")}`;
}

/**
 * Builds the full page set for one template. Generation is deterministic:
 * the same data and template always produce the same paths and copy, which
 * keeps URLs stable across regenerations.
 */
export function generatePages(input: GenerationInput): GeneratedPage[] {
  const { template, dataset } = input;
  const fields = new Map(dataset.fields.map((field) => [field.key, field]));
  const now = (input.now ?? new Date()).toISOString();
  const createId = input.createId ?? (() => `page_${crypto.randomUUID()}`);
  const mount = normalizeMountPath(input.mountPath);
  const groups = groupRecords(input.records, template.groupBy, fields);
  // Judge each page against fields the dataset actually has: a field no source
  // provides says nothing about whether one record is thin.
  const coverage = fieldCoverage(input.records, template.itemFields);
  const coveredFields = template.itemFields.filter((key) => (coverage.get(key) ?? 0) >= MIN_FIELD_COVERAGE);
  const expectedFields = coveredFields.length ? coveredFields : template.itemFields.filter((key) => (coverage.get(key) ?? 0) > 0);
  const stablePaths = input.stablePaths ?? new Map<string, string>();
  const usedPaths = new Set<string>(stablePaths.values());

  const pages = groups.map((group): GeneratedPage => {
    const records = sortRecords(group.records, template, fields).slice(0, MAX_ITEMS_PER_PAGE);
    const isEntity = template.groupBy.length === 0;
    const resolve = buildResolver({ group, records, isEntity, fields, input });
    const issues: string[] = [];

    const titleResult = fillPattern(template.titlePattern, resolve);
    if (titleResult.missing.length) issues.push(`Title is missing ${titleResult.missing.join(", ")}.`);
    const h1 = fillPattern(template.h1Pattern || template.titlePattern, resolve).text || titleResult.text;
    const description = truncateAtWord(fillProse(template.descriptionPattern, resolve).replace(/\n+/g, " "), 158);
    const intro = fillProse(template.introPattern, resolve);
    const faq = fillFaq(template.faq, resolve);
    const items = records.map((record) => toItem(record, template, fields, input.entityLinks));

    let path = stablePaths.get(group.key) ?? `${mount}${buildPath(template.pathPattern, resolve, mount)}`;
    if (!stablePaths.has(group.key)) {
      if (usedPaths.has(path)) {
        let suffix = 2;
        while (usedPaths.has(`${path}-${suffix}`)) suffix++;
        path = `${path}-${suffix}`;
      }
      usedPaths.add(path);
    }

    const quality = assessQuality({ isEntity, template, records, items, intro, faq, title: titleResult.text, issues, fields, expectedFields });
    return {
      id: createId(),
      siteId: input.siteId,
      templateId: template.id,
      path,
      groupKey: group.key,
      groupValues: group.values,
      title: titleResult.text || h1,
      description,
      h1,
      intro,
      faq,
      recordIds: records.map((record) => record.id),
      items,
      facts: buildFacts(records, fields),
      related: [],
      qualityScore: quality.score,
      qualityIssues: quality.issues,
      status: quality.passes ? "draft" : "thin",
      createdAt: now,
      updatedAt: now,
    };
  });

  markDuplicates(pages);
  attachRelatedLinks(pages, template, fields);
  return pages;
}

/** Share of records with a value, per field. */
export function fieldCoverage(records: DataRecord[], keys: string[]): Map<string, number> {
  const coverage = new Map<string, number>();
  for (const key of keys) {
    const filled = records.filter((record) => valuesOf(record.data[key]).length > 0).length;
    coverage.set(key, records.length ? filled / records.length : 0);
  }
  return coverage;
}

function valuesOf(value: JsonValue | undefined): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(formatValue).filter(Boolean);
  const text = formatValue(value);
  return text ? [text] : [];
}

/** One group per record (entity templates) or per unique combination of group-by values. */
export function groupRecords(records: DataRecord[], groupBy: string[], _fields?: Map<string, DatasetField>): Group[] {
  if (groupBy.length === 0) {
    return records.map((record) => ({ key: record.key, values: {}, records: [record] }));
  }
  const groups = new Map<string, Group>();
  for (const record of records) {
    // List fields fan out: a doctor with two specialties belongs to both groups.
    let combos: Array<Record<string, string>> = [{}];
    for (const key of groupBy) {
      const options = valuesOf(record.data[key]);
      combos = combos.flatMap((combo) => options.map((option) => ({ ...combo, [key]: option })));
    }
    for (const combo of combos) {
      const key = groupBy.map((field) => slugify(combo[field]!)).join("|");
      if (!key.replace(/\|/g, "")) continue;
      const group = groups.get(key) ?? { key, values: combo, records: [] };
      group.records.push(record);
      groups.set(key, group);
    }
  }
  return [...groups.values()];
}

function sortRecords(records: DataRecord[], template: PageTemplate, fields: Map<string, DatasetField>): DataRecord[] {
  const sortBy = template.sortBy && fields.has(template.sortBy) ? template.sortBy : null;
  if (!sortBy) return records;
  const direction = template.sortDir === "asc" ? 1 : -1;
  return [...records].sort((a, b) => {
    const left = a.data[sortBy];
    const right = b.data[sortBy];
    if (left == null) return 1;
    if (right == null) return -1;
    if (typeof left === "number" && typeof right === "number") return (left - right) * direction;
    return formatValue(left).localeCompare(formatValue(right)) * direction;
  });
}

function numbers(records: DataRecord[], key: string): number[] {
  return records.map((record) => record.data[key]).filter((value): value is number => typeof value === "number");
}

function topValues(records: DataRecord[], key: string, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const value of valuesOf(record.data[key])) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([value]) => value);
}

function buildResolver(context: {
  group: Group;
  records: DataRecord[];
  isEntity: boolean;
  fields: Map<string, DatasetField>;
  input: GenerationInput;
}): Resolver {
  const { group, records, isEntity, fields, input } = context;
  const titleField = input.template.itemTitleField || input.dataset.keyField;
  return (token) => {
    const [op, key, arg] = token.split(":");
    switch (op) {
      case "count": return records.length.toLocaleString("en");
      case "year": return String((input.now ?? new Date()).getUTCFullYear());
      case "site": return input.siteName;
      case "entity": return input.dataset.entityType;
      case "entities": return input.dataset.name.toLowerCase();
      case "names": return records.slice(0, Number(key) || 3).map((record) => formatValue(record.data[titleField])).filter(Boolean).join(", ");
      case "min": case "max": case "avg": {
        if (!key) return "";
        const values = numbers(records, key);
        if (!values.length) return "";
        const result = op === "min" ? Math.min(...values) : op === "max" ? Math.max(...values) : values.reduce((a, b) => a + b, 0) / values.length;
        return Math.round(result).toLocaleString("en");
      }
      case "top": return key ? topValues(records, key, Number(arg) || 3).join(", ") : "";
      default: {
        if (!fields.has(op!)) return "";
        if (group.values[op!]) return group.values[op!]!;
        // Entity pages read straight from the record; grouped pages only
        // resolve fields that are constant across the group.
        if (isEntity) return formatValue(records[0]?.data[op!] ?? null);
        const distinct = topValues(records, op!, 2);
        return distinct.length === 1 ? distinct[0]! : "";
      }
    }
  };
}

function buildPath(pattern: string, resolve: Resolver, mount: string): string {
  const relative = mount && pattern.startsWith(`${mount}/`) ? pattern.slice(mount.length) : pattern;
  const path = relative.replace(/\{([a-z0-9_:]+)\}/gi, (_whole, token: string) => slugify(resolve(token)) || "item");
  const clean = `/${path.split("/").map((segment) => segment.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "")).filter(Boolean).join("/")}`;
  return clean === "/" ? "/item" : clean;
}

function fillFaq(faq: FaqPattern[], resolve: Resolver): FaqPattern[] {
  return faq.flatMap((entry) => {
    const question = fillPattern(entry.question, resolve);
    const answer = fillProse(entry.answer, resolve);
    return question.missing.length || !answer ? [] : [{ question: question.text, answer }];
  });
}

function toItem(record: DataRecord, template: PageTemplate, fields: Map<string, DatasetField>, links?: Map<string, PageLink>): PageItem {
  const titleField = template.itemTitleField || [...fields.keys()][0]!;
  return {
    title: formatValue(record.data[titleField] ?? null) || record.key,
    fields: template.itemFields.flatMap((key) => {
      const field = fields.get(key);
      if (!field || key === titleField) return [];
      const value = formatValue(record.data[key] ?? null);
      if (!value) return [];
      const linked = field.type === "url" ? value : links?.get(slugify(value))?.path;
      return [{ label: field.label, value: truncateAtWord(value, 600), ...(linked ? { href: linked } : {}) }];
    }),
  };
}

function buildFacts(records: DataRecord[], fields: Map<string, DatasetField>): JsonObject {
  const facts: JsonObject = { count: records.length };
  for (const field of fields.values()) {
    if (field.type !== "number") continue;
    const values = numbers(records, field.key);
    if (values.length) facts[field.key] = { min: Math.min(...values), max: Math.max(...values) };
  }
  return facts;
}

function assessQuality(input: {
  isEntity: boolean;
  template: PageTemplate;
  records: DataRecord[];
  items: PageItem[];
  intro: string;
  faq: FaqPattern[];
  title: string;
  issues: string[];
  fields: Map<string, DatasetField>;
  expectedFields: string[];
}): { passes: boolean; score: number; issues: string[] } {
  const issues = [...input.issues];
  let passes = Boolean(input.title);
  let score: number;
  if (input.isEntity) {
    const record = input.records[0]!;
    const expected = input.expectedFields.filter((key) => input.fields.has(key));
    const filled = expected.filter((key) => valuesOf(record.data[key]).length > 0).length;
    const ratio = expected.length ? filled / expected.length : 0;
    const textLength = input.intro.length + input.items.flatMap((item) => item.fields).reduce((sum, field) => sum + field.value.length, 0)
      + input.faq.reduce((sum, entry) => sum + entry.answer.length, 0);
    if (ratio < MIN_ENTITY_FILL_RATIO) {
      passes = false;
      issues.push(`Only ${filled} of ${expected.length} page fields have data.`);
    }
    if (textLength < MIN_ENTITY_TEXT) {
      passes = false;
      issues.push("Too little unique content to be useful on its own.");
    }
    score = Math.min(1, ratio * 0.7 + Math.min(textLength / 1500, 1) * 0.3);
  } else {
    const minimum = Math.max(1, input.template.minRecords);
    if (input.records.length < minimum) {
      passes = false;
      issues.push(`Only ${input.records.length} ${input.records.length === 1 ? "record" : "records"}; this template needs ${minimum}.`);
    }
    score = Math.min(1, input.records.length / (minimum * 4)) * 0.8 + (input.faq.length ? 0.2 : 0);
  }
  if (input.title.length > 65) issues.push("Title is longer than ~65 characters and may be truncated in search results.");
  return { passes, score: passes ? Math.max(0.05, Number(score.toFixed(3))) : 0, issues };
}

/**
 * Grouped pages that list exactly the same records as another page add no
 * value; keep the first and mark the rest duplicate.
 */
function markDuplicates(pages: GeneratedPage[]): void {
  const seen = new Map<string, GeneratedPage>();
  for (const page of pages) {
    if (page.status !== "draft" || page.recordIds.length < 2) continue;
    const signature = [...page.recordIds].sort().join(",");
    const original = seen.get(signature);
    if (original) {
      page.status = "duplicate";
      page.qualityScore = 0;
      page.qualityIssues = [...page.qualityIssues, `Lists the same records as ${original.path}.`];
    } else {
      seen.set(signature, page);
    }
  }
}

/** Links each page to siblings that share the most attribute values. */
function attachRelatedLinks(pages: GeneratedPage[], template: PageTemplate, fields: Map<string, DatasetField>): void {
  const live = pages.filter((page) => page.status === "draft");
  const index = new Map<string, GeneratedPage[]>();
  const keysFor = (page: GeneratedPage): string[] => {
    if (template.groupBy.length) return Object.entries(page.groupValues).map(([key, value]) => `${key}=${slugify(value)}`);
    const item = page.items[0];
    if (!item) return [];
    return item.fields
      .filter((field) => {
        const definition = [...fields.values()].find((entry) => entry.label === field.label);
        return definition && (definition.type === "text" || definition.type === "list") && field.value.length <= 80;
      })
      .flatMap((field) => field.value.split(", ").map((value) => `${field.label}=${slugify(value)}`));
  };
  const pageKeys = new Map(live.map((page) => [page, keysFor(page)]));
  for (const [page, keys] of pageKeys) {
    for (const key of keys) {
      const peers = index.get(key);
      if (peers) peers.push(page);
      else index.set(key, [page]);
    }
  }
  for (const [page, keys] of pageKeys) {
    const scores = new Map<GeneratedPage, number>();
    for (const key of keys) {
      const peers = index.get(key) ?? [];
      // Values shared by almost every page (e.g. country) carry no signal.
      if (peers.length > Math.max(20, live.length * 0.5)) continue;
      for (const peer of peers) if (peer !== page) scores.set(peer, (scores.get(peer) ?? 0) + 1);
    }
    page.related = [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].path.localeCompare(b[0].path))
      .slice(0, 6)
      .map(([peer]) => ({ path: peer.path, title: peer.h1 || peer.title }));
  }
}
