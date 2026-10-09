import { slugify, type DataSourceKind, type DatasetField, type DatasetFieldType } from "@organic-growth/core";

const FIELD_TYPES: DatasetFieldType[] = ["text", "number", "list", "url", "boolean"];
export const SOURCE_KINDS: DataSourceKind[] = ["own_site", "listing", "sitemap", "page"];

/** Validates owner-edited fields; returns an error message or the cleaned fields. */
export function validateFields(value: unknown): DatasetField[] | string {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) return "A dataset needs between 1 and 30 fields.";
  const seen = new Set<string>();
  const fields: DatasetField[] = [];
  for (const entry of value) {
    const field = entry as Record<string, unknown>;
    const label = typeof field.label === "string" ? field.label.trim().slice(0, 60) : "";
    const key = slugify(typeof field.key === "string" && field.key ? field.key : label).replace(/-/g, "_");
    if (!key || !label) return "Every field needs a label.";
    if (seen.has(key)) return `The field “${label}” appears twice.`;
    seen.add(key);
    fields.push({
      key,
      label,
      type: FIELD_TYPES.includes(field.type as DatasetFieldType) ? field.type as DatasetFieldType : "text",
      description: typeof field.description === "string" ? field.description.slice(0, 200) : undefined,
      required: field.required === true,
    });
  }
  return fields;
}

/** Converts a pasted glob into the stored form, or reports why it cannot be used. */
export function validateUrlPattern(value: unknown): string | undefined | { error: string } {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 200) {
    return { error: "URL patterns are paths starting with /, e.g. /doctors/* (use ** to match several segments)." };
  }
  return value.trim();
}
