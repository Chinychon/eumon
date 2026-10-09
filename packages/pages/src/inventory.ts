import type { DatasetField } from "@organic-growth/core";

/*
 * What a dataset's records say about the site's content: how filled each
 * field is (by language where fields come in language variants), which
 * records are listed more than once, and how the records' own pages fare in
 * a crawl. The counting is SQL (`datasetInventoryRows` in db); this turns the
 * rows into what the card and the findings read.
 */

export type FieldFill = { key: string; label: string; filled: number; share: number; language?: string };
export type LanguageGroup = { base: string; variants: Array<{ language: string; filled: number; share: number }> };
export type DuplicateGroup = { name: string; keys: string[] };
export type DuplicateSummary = { groups: number; records: number; examples: DuplicateGroup[] };
/** The records' pages on the site in the crawl: thin (empty shell or under 250 characters), gone (404/410), or not reached (not crawled, or another error). */
export type PageSummary = { linked: number; thin: number; gone: number; unreached: number; examples: { thin: string[]; gone: string[] } };

export type InventoryRows = {
  records: number;
  /** Records with a value, per field key. */
  fills: Record<string, number>;
  /** Every record's key and display name, for the duplicate groups. */
  names: Array<{ key: string; name: string }>;
  /** Null when no record points at the site, or the analysis has no crawl rows to check against. */
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
const TRAILING_PARENTHETICAL = /\s*\([^)]*\)\s*$/;
const KEY_SUFFIX = /^(.+)[_-]([a-z]{2})$/i;

/**
 * The language a field is a variant for ("Bio (EN)", `bio_id`, `bio-zh`) and the
 * field's base name (the label without its parenthetical); null for a field
 * with none. A key suffix alone is a guess: `price_id` is a foreign key, not
 * Indonesian, so `inventoryFromRows` keeps a key-derived language only when
 * another field shares the stem.
 */
export function languageOf(field: Pick<DatasetField, "key" | "label">): { base: string; language: string } | null {
  const label = field.label.match(LABEL_SUFFIX);
  if (label && LANGUAGE.test(label[1]!)) return { base: field.label.replace(LABEL_SUFFIX, "").trim(), language: label[1]!.toUpperCase() };
  const key = field.key.match(KEY_SUFFIX);
  if (key && LANGUAGE.test(key[2]!)) return { base: field.label.replace(TRAILING_PARENTHETICAL, "").trim(), language: key[2]!.toUpperCase() };
  return null;
}

/** Variants group by the key's stem (`bio_en`, `bio_ms` → `bio`); a label that carries the code and a bare key group by the label's base. */
function groupKey(field: Pick<DatasetField, "key" | "label">): string {
  const key = field.key.match(KEY_SUFFIX);
  return key && LANGUAGE.test(key[2]!) ? `key:${key[1]!.toLowerCase()}` : `label:${field.label.replace(LABEL_SUFFIX, "").trim().toLowerCase()}`;
}

const HONORIFICS = /\b(dr|dato'?|datuk|datin|prof|professor|mr|mrs|ms|tan sri|puan|encik|hj|haji)\b\.?/g;

/** The name as a person would say two listings are the same: lower-cased, without honorifics or punctuation (marks on letters stay). */
export const sameName = (name: string) => name.normalize("NFC").toLowerCase().replace(HONORIFICS, " ").replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

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
  const share = (filled: number) => (rows.records ? filled / rows.records : 0);
  const candidates = fields.map((field) => ({ field, language: languageOf(field), group: groupKey(field) }));
  const members = new Map<string, number>();
  for (const candidate of candidates) if (candidate.language) members.set(candidate.group, (members.get(candidate.group) ?? 0) + 1);
  // A language read from a key suffix with no sibling is a plain field (`price_id`); one read from the label stands on its own.
  const grouped = candidates.map((candidate) => ({
    ...candidate,
    language: candidate.language && (candidate.group.startsWith("label:") || (members.get(candidate.group) ?? 0) > 1) ? candidate.language : null,
  }));
  const fills: FieldFill[] = grouped.map(({ field, language }) => {
    const filled = rows.fills[field.key] ?? 0;
    return { key: field.key, label: field.label, filled, share: share(filled), ...(language ? { language: language.language } : {}) };
  });
  const languages = new Map<string, LanguageGroup>();
  for (const [index, { language, group }] of grouped.entries()) {
    if (!language) continue;
    const entry = languages.get(group) ?? { base: language.base, variants: [] };
    entry.variants.push({ language: language.language, filled: fills[index]!.filled, share: fills[index]!.share });
    languages.set(group, entry);
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
