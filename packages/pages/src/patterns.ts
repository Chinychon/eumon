import type { JsonValue } from "@organic-growth/core";

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function formatValue(value: JsonValue): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(formatValue).filter(Boolean).join(", ");
  if (typeof value === "number") return value.toLocaleString("en", { maximumFractionDigits: 2 });
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return "";
  return String(value).trim();
}

/** Resolves one placeholder token (the text between braces) to display text, or "" when unknown. */
export type Resolver = (token: string) => string;

const PLACEHOLDER = /\{([a-z0-9_:]+)\}/gi;

/**
 * Fills `{placeholders}`. Placeholders that resolve to nothing are reported
 * in `missing` so callers can drop the sentence instead of printing a gap.
 */
export function fillPattern(pattern: string, resolve: Resolver): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = pattern.replace(PLACEHOLDER, (_whole, token: string) => {
    const value = resolve(token);
    if (!value) missing.push(token);
    return value;
  });
  return { text: tidy(text), missing };
}

/** Fills a multi-sentence pattern, omitting any sentence that has an unresolved placeholder. */
export function fillProse(pattern: string, resolve: Resolver): string {
  return pattern
    .split(/\n{2,}/)
    .map((paragraph) => paragraph
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => fillPattern(sentence, resolve))
      .filter((sentence) => sentence.missing.length === 0 && sentence.text)
      .map((sentence) => sentence.text)
      .join(" "))
    .filter(Boolean)
    .join("\n\n");
}

function tidy(text: string): string {
  return text
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])\1+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;:–-]+|[\s,;:–-]+$/g, "")
    .trim();
}

/** Every `{placeholder}` token referenced by a pattern. */
export function placeholders(pattern: string): string[] {
  return [...pattern.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max * 0.6)).replace(/[\s,;:–-]+$/, "")}…`;
}
