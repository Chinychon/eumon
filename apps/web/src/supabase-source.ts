import { createId, slugify, type DataSource, type Dataset, type JsonObject } from "@organic-growth/core";
import { deleteStaleRecords, getOAuthCredential, refreshSourceRecordCount, replaceRecords, updateJob, upsertOAuthCredential, type D1Like } from "@organic-growth/db";
import { normalizeRecords } from "@organic-growth/scraper";
import { readText } from "./body.ts";
import { decryptSecret, encryptSecret } from "./gsc-auth.ts";

/*
 * A Supabase table as a dataset source: read through PostgREST with a
 * read-only key the operator pastes once. The key is sealed the way the
 * Google refresh token is and never leaves the server. A pull runs as
 * collection-workflow steps, a page of rows each, so every step fits the
 * Free plan's budgets; the table is the authority for what it said before.
 */

/** One page of rows at most this large; a table that sends more is refused rather than read into memory. */
export const MAX_PULL_BYTES = 5_000_000;
export const PULL_TIMEOUT_MS = 15_000;

/** `https://<project>.supabase.co` and nothing else: the key is only ever sent to Supabase. */
export function isSupabaseProjectUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && /^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname);
  } catch {
    return false;
  }
}

/** Rows asked for per page (the project may answer fewer), and pages per pull: 40,000 rows at most. */
export const PULL_PAGE = 1000;
export const MAX_PULL_PAGES = 40;

/** `step.do` as the pull needs it; the collection workflow adapts `WorkflowStep`, tests pass a plain function. */
export type PullStep = { do<T>(name: string, fn: () => Promise<T>): Promise<T> };
export type PullDeps = { db: D1Like; encryptionKey: string; fetchFn?: typeof fetch };
export type PullResult = { rows: number; records: number; pages: number; total: number | null; truncated: boolean; removed: number };

const provider = (sourceId: string) => `supabase:${sourceId}`;
const n = (value: number) => value.toLocaleString("en");

/** Why a pasted key cannot be used, or null. The service-role key bypasses every policy, so it is never the right one. */
export function validateSupabaseKey(key: string): string | null {
  if (key.length < 20 || key.length > 4096 || !/^[A-Za-z0-9._~+/=-]+$/.test(key)) return "Paste the read-only API key for this table (letters, digits and . _ - only).";
  if (/^sb_secret_/.test(key)) return "That is a secret (service) key, which bypasses every policy. Use a publishable key under row-level security, or a dedicated read-only role.";
  const payload = key.split(".")[1];
  if (key.startsWith("eyJ") && payload) {
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { role?: string };
      if (claims.role === "service_role") return "That is the service-role key, which bypasses every policy. Use the anon key under row-level security, or a dedicated read-only role.";
    } catch {
      // Not a JWT after all: the charset check above is what stands.
    }
  }
  return null;
}

export async function saveSupabaseKey(db: D1Like, siteId: string, sourceId: string, key: string, encryptionKey: string): Promise<void> {
  await upsertOAuthCredential(db, { id: createId("oauth"), siteId, provider: provider(sourceId), encryptedBlob: await encryptSecret(key, encryptionKey) });
}

export async function supabaseKey(db: D1Like, siteId: string, sourceId: string, encryptionKey: string): Promise<string | null> {
  const credential = await getOAuthCredential(db, siteId, provider(sourceId));
  return credential ? decryptSecret(credential.encryptedBlob, encryptionKey) : null;
}

/** Columns matched to fields by key, label, or the label as a key (`Bio (EN)` → `bio_en`), as a CSV's headers are. */
function columnMap(dataset: Pick<Dataset, "fields">): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const field of dataset.fields) {
    lookup.set(field.key.toLowerCase(), field.key);
    lookup.set(field.label.toLowerCase(), field.key);
    lookup.set(slugify(field.label).replace(/-/g, "_"), field.key);
  }
  return lookup;
}

/**
 * Rows to records. Two rows with the same name are two records: the second
 * takes the row's id on its key (`dr-tan-mei-2`), so the inventory can see the
 * duplicate instead of the import merging it away.
 */
export function mapSupabaseRows(dataset: Pick<Dataset, "fields" | "keyField">, rows: Array<Record<string, unknown>>): Array<{ key: string; data: JsonObject }> {
  const lookup = columnMap(dataset);
  const taken = new Set<string>();
  const records: Array<{ key: string; data: JsonObject }> = [];
  for (const [index, row] of rows.entries()) {
    const mapped: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) {
      const key = lookup.get(column.toLowerCase()) ?? lookup.get(slugify(column).replace(/-/g, "_"));
      if (key && value != null && value !== "") mapped[key] = typeof value === "object" && !Array.isArray(value) ? JSON.stringify(value) : value;
    }
    const [record] = normalizeRecords(dataset, [mapped]);
    if (!record) continue;
    const key = taken.has(record.key) ? `${record.key}-${row.id != null && /^[\w-]+$/.test(String(row.id)) ? String(row.id) : index + 1}` : record.key;
    taken.add(key);
    records.push({ key, data: record.data });
  }
  return records;
}

/** A message that may carry the table's answer never carries the key. */
const withoutKey = (message: string, key: string) => message.split(key).join("…");

type Page = { rows: number; records: number; total: number | null; columns: string[] };

/** One page of the table: fetched, mapped and written. Throws, without the key, when the table refuses or no column matches the key field. */
async function pullPage(deps: PullDeps, source: DataSource, dataset: Dataset, key: string, offset: number): Promise<Page> {
  if (!isSupabaseProjectUrl(source.url)) throw new Error("A Supabase source must be a https://<project>.supabase.co address. Remove it and add it again.");
  const url = `${new URL(source.url).origin}/rest/v1/${encodeURIComponent(source.urlPattern!)}?select=*&offset=${offset}&limit=${PULL_PAGE}`;
  let response: Response;
  try {
    response = await (deps.fetchFn ?? fetch)(url, { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json", Prefer: "count=exact" }, redirect: "error", signal: AbortSignal.timeout(PULL_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Could not reach the project URL: ${withoutKey(error instanceof Error ? error.message : String(error), key)}`);
  }
  if (!response.ok) throw new Error(`The table answered ${response.status}: ${withoutKey((await response.text()).slice(0, 200), key)}`);
  const text = await readText(response, MAX_PULL_BYTES);
  if (text === null) throw new Error(`The table sent more than ${MAX_PULL_BYTES / 1_000_000} MB in one page. Pull a narrower view of it.`);
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    throw new Error("The table answered with something other than rows.");
  }
  if (!Array.isArray(rows)) throw new Error("The table answered with something other than rows.");
  const range = response.headers.get("content-range")?.match(/\/(\d+)$/);
  const total = range ? Number(range[1]) : null;
  const columns = rows[0] && typeof rows[0] === "object" ? Object.keys(rows[0] as object) : [];
  const records = mapSupabaseRows(dataset, rows as Array<Record<string, unknown>>);
  if (rows.length && !records.length) {
    const keyField = dataset.fields.find((field) => field.key === dataset.keyField);
    throw new Error(`No column matches the key field "${keyField?.label ?? dataset.keyField}". The table's columns are: ${columns.join(", ")}.`);
  }
  await replaceRecords(deps.db, { siteId: source.siteId, datasetId: dataset.id, sourceId: source.id, sourceUrl: source.url }, records);
  return { rows: rows.length, records: records.length, total, columns };
}

/**
 * The whole table, a page a step, then a finishing step that removes records
 * this source gave before and the table no longer has (only after a complete
 * pull) and refreshes the source's count. A pull that hits the page cap keeps
 * what it read and says the table is larger.
 */
export async function runSupabasePull(deps: PullDeps, step: PullStep, source: DataSource, dataset: Dataset, jobId: string, options: { maxPages?: number } = {}): Promise<PullResult> {
  const maxPages = options.maxPages ?? MAX_PULL_PAGES;
  const startedAt = new Date().toISOString();
  const key = await supabaseKey(deps.db, source.siteId, source.id, deps.encryptionKey);
  if (!key) throw new Error("This source has no API key saved. Remove it and add it again with the key.");
  if (!source.urlPattern) throw new Error("This source names no table.");
  let offset = 0;
  let rows = 0;
  let records = 0;
  let pages = 0;
  let total: number | null = null;
  let done = false;
  try {
    while (!done && pages < maxPages) {
      const page = await step.do(`pull-${source.id}-${pages + 1}`, async () => {
        const result = await pullPage(deps, source, dataset, key, offset);
        await updateJob(deps.db, jobId, { progress: { message: `Reading ${source.urlPattern}: ${n(offset + result.rows)}${result.total !== null ? ` of ${n(result.total)}` : ""} rows`, done: offset + result.rows, total: result.total ?? offset + result.rows } });
        return result;
      });
      pages++;
      rows += page.rows;
      records += page.records;
      offset += page.rows;
      total = page.total;
      done = page.rows === 0 || (total !== null ? offset >= total : page.rows < PULL_PAGE);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await refreshSourceRecordCount(deps.db, source.id, withoutKey(message, key).slice(0, 300));
    throw error;
  }
  const truncated = !done;
  return step.do(`pull-${source.id}-finish`, async () => {
    const removed = truncated ? 0 : await deleteStaleRecords(deps.db, source.id, startedAt);
    await refreshSourceRecordCount(deps.db, source.id, truncated ? `Pulled the first ${n(rows)} rows; the table has ${total === null ? "more" : n(total)}. Narrow the table with a view, or pull again later for the rest.` : undefined);
    return { rows, records, pages, total, truncated, removed };
  });
}
