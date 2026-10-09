import type { DatasetField } from "@organic-growth/core";

/*
 * What a dataset's records say about the site's content: how filled each
 * field is (by language where fields come in language variants), which
 * records are listed more than once, and how the records' own pages fare in
 * the latest crawl. The counting is SQL (`datasetInventoryRows` in db); this
 * turns the rows into what the card and the findings read.
 */

export type FieldFill = { key: string; label: string; filled: number; share: number; language?: string };
export type LanguageGroup = { base: string; variants: Array<{ language: string; filled: number; share: number }> };
export type DuplicateGroup = { name: string; keys: string[] };
export type DuplicateSummary = { groups: number; records: number; examples: DuplicateGroup[] };
export type PageSummary = { linked: number; thin: number; missing: number; examples: { thin: string[]; missing: string[] } };

export type InventoryRows = {
  records: number;
  /** Records with a value, per field key. */
  fills: Record<string, number>;
  /** Every record's key and display name, for the duplicate groups. */
  names: Array<{ key: string; name: string }>;
  /** Null when no record carries a URL on the site, or there is no finished crawl to check against. */
  pages: PageSummary | null;
};

export type Inventory = {
  records: number;
  fields: FieldFill[];
  languages: LanguageGroup[];
  duplicates: DuplicateSummary;
  pages: PageSummary | null;
};

const LANGUAGE = /^(en|id|ms|zh|ja|ko|th|vi|tl|de|fr|es|it|pt|nl|ar|hi|ta|ru|tr|pl|sv)$/i;
const LABEL_SUFFIX = /\s*\((\w{2,3})\)\s*$/;

/** The language a field is a variant for ("Bio (EN)", `bio_id`, `bio-zh`) with the field's base name; null for a field with none (a bare `id` key is not Indonesian). */
export function languageOf(field: Pick<DatasetField, "key" | "label">): { base: string; language: string } | null {
  const label = field.label.match(LABEL_SUFFIX);
  if (label && LANGUAGE.test(label[1]!)) return { base: field.label.replace(LABEL_SUFFIX, "").trim(), language: label[1]!.toUpperCase() };
  const key = field.key.match(/^.+[_-]([a-z]{2})$/i);
  if (key && LANGUAGE.test(key[1]!)) return { base: field.label.replace(LABEL_SUFFIX, "").trim(), language: key[1]!.toUpperCase() };
  return null;
}

const HONORIFICS = /\b(dr|dato'?|datuk|datin|prof|professor|mr|mrs|ms|tan sri|puan|encik|hj|haji)\b\.?/g;

/** The name as a person would say two listings are the same: lower-cased, without honorifics or punctuation. */
export const sameName = (name: string) => name.toLowerCase().replace(HONORIFICS, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** Records that share a name, largest groups first; a group names itself after its first record. */
export function duplicateGroups(names: Array<{ key: string; name: string }>): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();
  for (const { key, name } of names) {
    const same = sameName(name);
    if (!same) continue;
    const group = groups.get(same) ?? { name: name.trim(), keys: [] };
    group.keys.push(key);
    groups.set(same, group);
  }
  return [...groups.values()].filter((group) => group.keys.length > 1).sort((a, b) => b.keys.length - a.keys.length || a.name.localeCompare(b.name));
}

/** The card's and the findings' view of a dataset from its counted rows. */
export function inventoryFromRows(fields: Array<Pick<DatasetField, "key" | "label">>, rows: InventoryRows): Inventory {
  const fills: FieldFill[] = fields.map((field) => {
    const filled = rows.fills[field.key] ?? 0;
    const language = languageOf(field);
    return { key: field.key, label: field.label, filled, share: rows.records ? filled / rows.records : 0, ...(language ? { language: language.language } : {}) };
  });
  const languages = new Map<string, LanguageGroup>();
  for (const [index, field] of fields.entries()) {
    const language = languageOf(field);
    if (!language) continue;
    const group = languages.get(language.base) ?? { base: language.base, variants: [] };
    group.variants.push({ language: language.language, filled: fills[index]!.filled, share: fills[index]!.share });
    languages.set(language.base, group);
  }
  const groups = duplicateGroups(rows.names);
  return {
    records: rows.records,
    fields: fills,
    languages: [...languages.values()].filter((group) => group.variants.length > 1),
    duplicates: { groups: groups.length, records: groups.reduce((total, group) => total + group.keys.length, 0), examples: groups.slice(0, 8) },
    pages: rows.pages,
  };
}
