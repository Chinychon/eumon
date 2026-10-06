import { schema, type JsonLlm, type JsonSchema } from "@organic-growth/ai";
import { mergeRecordData, slugify, type Dataset, type DatasetField, type JsonObject, type JsonValue } from "@organic-growth/core";
import { extractJsonLd, extractMeta, htmlToText } from "./html.js";

function fieldSchema(field: DatasetField): JsonSchema {
  const description = field.description ? `${field.label}: ${field.description}` : field.label;
  switch (field.type) {
    case "number": return schema.nullable(schema.number(description));
    case "boolean": return schema.nullable(schema.boolean(description));
    case "list": return schema.nullable({ ...schema.array(schema.string()), description });
    default: return schema.nullable(schema.string(description));
  }
}

export function recordSchema(dataset: Pick<Dataset, "fields">): JsonSchema {
  return schema.object(Object.fromEntries(dataset.fields.map((field) => [field.key, fieldSchema(field)])));
}

/** Coerces a raw value to the field's declared type; returns null when it cannot. */
export function coerceField(field: DatasetField, value: unknown): JsonValue {
  if (value == null || value === "") return null;
  switch (field.type) {
    case "number": {
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      // "RM 12,500" → 12500; "from $1.2k" is left to the model, not guessed here.
      const match = String(value).replace(/,(?=\d{3}\b)/g, "").match(/-?\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : null;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      return /^(true|yes|y|1)$/i.test(String(value).trim()) ? true : /^(false|no|n|0)$/i.test(String(value).trim()) ? false : null;
    case "list": {
      const items = Array.isArray(value) ? value : String(value).split(/[,;|]\s*/);
      const clean = items.map((item) => String(item).trim()).filter(Boolean).slice(0, 50);
      return clean.length ? [...new Set(clean)] : null;
    }
    case "url": {
      try {
        const url = new URL(String(value).trim());
        return /^https?:$/.test(url.protocol) ? url.toString() : null;
      } catch {
        return null;
      }
    }
    default: {
      const text = String(value).replace(/\s+/g, " ").trim();
      return text ? text.slice(0, 4000) : null;
    }
  }
}

export type ExtractedRecord = { key: string; data: JsonObject };

/**
 * Normalizes raw rows against the dataset; drops only rows without a usable
 * key. Missing details make a page thinner, which the page quality gate
 * handles — they are not a reason to lose the record.
 */
export function normalizeRecords(dataset: Pick<Dataset, "fields" | "keyField">, rows: unknown[]): ExtractedRecord[] {
  const output = new Map<string, ExtractedRecord>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const raw = row as Record<string, unknown>;
    const data: JsonObject = {};
    for (const field of dataset.fields) data[field.key] = coerceField(field, raw[field.key]);
    const keyValue = data[dataset.keyField];
    const key = typeof keyValue === "string" ? slugify(keyValue) : typeof keyValue === "number" ? String(keyValue) : "";
    if (!key) continue;
    // A record never lists itself (e.g. "Sunway Carnival" among Sunway Carnival Mall's clients).
    for (const field of dataset.fields) {
      const value = data[field.key];
      if (field.type !== "list" || !Array.isArray(value)) continue;
      const kept = value.filter((item) => {
        const slug = slugify(String(item));
        return !slug || !(slug === key || key.startsWith(`${slug}-`));
      });
      data[field.key] = kept.length ? kept : null;
    }
    // One page can list the same entity several times (e.g. five projects at one mall); combine them.
    const prior = output.get(key);
    output.set(key, { key, data: prior ? mergeRecordData(dataset.fields, prior.data, [data]) : data });
  }
  return [...output.values()];
}

const EXTRACTION_SYSTEM = `You extract structured records from one web page for a dataset.
Rules:
- Use only facts stated on the page or in its JSON-LD. Never guess, infer, or use outside knowledge.
- Use null for any field the page does not state.
- Only create a record for something that is itself the dataset's entity type. Other names on the page (brands, people, products, events, captions) may fill a record's fields but must never become records themselves.
- A detail page usually describes exactly one record. A listing, table, directory, or bullet list may name many; return one record for every entity it names, even when every field except the name is unknown.
- Fill fields from context the page states for the whole list (e.g. a section heading naming the group, or a location in parentheses after a name).
- Return an empty list only when the page names no entities of this type (e.g. an error page, login wall, or unrelated article).
- Keep text fields concise and factual. Write each name in its usual official form and put locations in location fields rather than in the name (e.g. "Queensbay Mall (Penang)" → name "Queensbay Mall", city "Penang").
- For "sourceSummary", write one neutral sentence describing what the page is.`;

/**
 * Extracts dataset records from a fetched page. JSON-LD is passed alongside
 * cleaned page text because it is often the most reliable structured signal.
 */
export async function extractRecordsFromHtml(input: {
  llm: JsonLlm;
  dataset: Pick<Dataset, "name" | "entityType" | "description" | "fields" | "keyField">;
  url: string;
  html: string;
  maxRecords?: number;
}): Promise<{ records: ExtractedRecord[]; summary: string }> {
  const jsonLd = extractJsonLd(input.html).slice(0, 10);
  const meta = extractMeta(input.html);
  const text = htmlToText(input.html);
  if (text.length < 80 && !jsonLd.length) return { records: [], summary: "Page had no readable content." };

  const result = await input.llm.json<{ records?: unknown[]; sourceSummary?: string }>({
    system: EXTRACTION_SYSTEM,
    user: JSON.stringify({
      dataset: {
        name: input.dataset.name,
        entityType: input.dataset.entityType,
        description: input.dataset.description,
        fields: input.dataset.fields,
        keyField: input.dataset.keyField,
      },
      page: { url: input.url, title: meta.title, h1: meta.h1, description: meta.description, jsonLd: JSON.stringify(jsonLd).slice(0, 8000), text },
    }),
    schema: schema.object({
      sourceSummary: schema.string(),
      records: schema.array(recordSchema(input.dataset)),
    }),
    maxTokens: 16000,
    effort: "low",
  });
  const rows = Array.isArray(result.records) ? result.records.slice(0, input.maxRecords ?? 200) : [];
  return {
    records: normalizeRecords(input.dataset, rows),
    summary: typeof result.sourceSummary === "string" ? result.sourceSummary.slice(0, 300) : "",
  };
}

/** Parses CSV (RFC 4180 quoting) into header-keyed rows. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const input = text.replace(/^﻿/, "");
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quoted) {
      if (char === "\"" && input[i + 1] === "\"") { cell += "\""; i++; }
      else if (char === "\"") quoted = false;
      else cell += char;
    } else if (char === "\"") quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((value) => value.trim()));
  if (!header) return [];
  const keys = header.map((name) => name.trim());
  return body.map((values) => Object.fromEntries(keys.map((key, index) => [key, values[index]?.trim() ?? ""])));
}

/** Maps CSV headers onto dataset fields by key or label, case-insensitively. */
export function mapCsvRows(dataset: Pick<Dataset, "fields" | "keyField">, rows: Array<Record<string, string>>): ExtractedRecord[] {
  const lookup = new Map<string, string>();
  for (const field of dataset.fields) {
    lookup.set(field.key.toLowerCase(), field.key);
    lookup.set(field.label.toLowerCase(), field.key);
    lookup.set(slugify(field.label).replace(/-/g, "_"), field.key);
  }
  const mapped = rows.map((row) => {
    const output: Record<string, unknown> = {};
    for (const [header, value] of Object.entries(row)) {
      const key = lookup.get(header.toLowerCase()) ?? lookup.get(slugify(header).replace(/-/g, "_"));
      if (key) output[key] = value;
    }
    return output;
  });
  return normalizeRecords(dataset, mapped);
}
