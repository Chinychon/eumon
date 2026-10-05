import type { DatasetField, JsonObject, JsonValue } from "./types.js";

/**
 * Combines facts about one entity from several pages or records. `primary`
 * wins for single values; gaps are filled from `others`; list fields are
 * unioned (so brands seen on different pages accumulate); empty values
 * never erase existing ones.
 */
export function mergeRecordData(fields: DatasetField[], primary: JsonObject, others: JsonObject[]): JsonObject {
  const merged: JsonObject = { ...Object.assign({}, ...[...others].reverse()), ...primary };
  for (const field of fields) {
    const values = [primary[field.key], ...others.map((data) => data[field.key])];
    if (field.type === "list") {
      const items = values.flatMap((value) => (Array.isArray(value) ? value : value == null || value === "" ? [] : [value]));
      const unique: JsonValue[] = [];
      const seen = new Set<string>();
      for (const item of items) {
        const label = String(item).trim().toLowerCase();
        if (label && !seen.has(label)) { seen.add(label); unique.push(item); }
      }
      merged[field.key] = unique.length ? unique : null;
    } else {
      merged[field.key] = values.find((value) => value != null && value !== "") ?? null;
    }
  }
  return merged;
}
