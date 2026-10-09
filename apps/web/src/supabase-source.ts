import { createId, type DataSource, type Dataset } from "@organic-growth/core";
import { getOAuthCredential, upsertOAuthCredential, upsertRecords, upsertSource, type D1Like } from "@organic-growth/db";
import { mapCsvRows } from "@organic-growth/scraper";
import { decryptSecret, encryptSecret } from "./gsc-auth.ts";

/*
 * A Supabase table as a dataset source: read through PostgREST with a
 * read-only key the operator pastes once. The key is sealed the way the
 * Google refresh token is and never leaves the server.
 */

/** Rows per PostgREST page, and pages per pull: 40,000 rows at most, within one request's subrequest budget. */
export const PULL_PAGE = 1000;
export const MAX_PULL_PAGES = 40;

const provider = (sourceId: string) => `supabase:${sourceId}`;

export async function saveSupabaseKey(db: D1Like, siteId: string, sourceId: string, key: string, encryptionKey: string): Promise<void> {
  await upsertOAuthCredential(db, { id: createId("oauth"), siteId, provider: provider(sourceId), encryptedBlob: await encryptSecret(key, encryptionKey) });
}

export async function supabaseKey(db: D1Like, siteId: string, sourceId: string, encryptionKey: string): Promise<string | null> {
  const credential = await getOAuthCredential(db, siteId, provider(sourceId));
  return credential ? decryptSecret(credential.encryptedBlob, encryptionKey) : null;
}

/** A source as the console may see it: nothing secret lives on the row, but this is the one place that promises it. */
export const supabaseSourceView = (source: DataSource): DataSource => ({ ...source });

const cell = (value: unknown): string => (value == null ? "" : Array.isArray(value) ? value.map(cell).filter(Boolean).join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value));

/**
 * Reads the table in pages and upserts the rows as records, columns matched
 * to fields by key or label like a CSV. Stops at the first error and says
 * what the table answered (never the key).
 */
export async function pullSupabaseSource(db: D1Like, source: DataSource, dataset: Dataset, encryptionKey: string, fetchFn: typeof fetch = fetch): Promise<{ rows: number; records: number; pages: number }> {
  const key = await supabaseKey(db, source.siteId, source.id, encryptionKey);
  if (!key) throw new Error("This source has no API key saved. Remove it and add it again with the key.");
  const table = source.urlPattern;
  if (!table) throw new Error("This source names no table.");
  const origin = new URL(source.url).origin;
  let rows = 0;
  let records = 0;
  let pages = 0;
  for (let offset = 0; pages < MAX_PULL_PAGES; offset += PULL_PAGE) {
    const response = await fetchFn(`${origin}/rest/v1/${encodeURIComponent(table)}?select=*&offset=${offset}&limit=${PULL_PAGE}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`The table answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const batch = (await response.json()) as unknown;
    if (!Array.isArray(batch)) throw new Error("The table answered with something other than rows.");
    pages++;
    if (!batch.length) break;
    const mapped = mapCsvRows(dataset, batch.map((row) => Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([column, value]) => [column, cell(value)]))));
    await upsertRecords(db, mapped.map((record) => ({ siteId: source.siteId, datasetId: dataset.id, key: record.key, data: record.data, sourceId: source.id, sourceUrl: source.url })), dataset.fields);
    rows += batch.length;
    records += mapped.length;
    if (batch.length < PULL_PAGE) break;
  }
  await upsertSource(db, { ...source, recordCount: records, error: undefined });
  return { rows, records, pages };
}
