import { env } from "cloudflare:workers";
import { getDataset, upsertDataset, upsertRecords } from "@organic-growth/db";
import { mapCsvRows, parseCsv } from "@organic-growth/scraper";
import { fail, json, readText } from "../../../../../../src/server";

/** Imports records from CSV; headers are matched to fields by key or label. */
export async function POST(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
  const dataset = await getDataset(env.DB, datasetId);
  if (!dataset) return fail("Dataset not found.", 404);
  const text = await readText(request, 5 * 1024 * 1024);
  if (text === null) return fail("Upload a CSV file of up to 5 MB.", 413);
  const rows = parseCsv(text);
  if (!rows.length) return fail("The CSV has no data rows.");
  const records = mapCsvRows(dataset, rows);
  if (!records.length) {
    const headers = Object.keys(rows[0] ?? {}).join(", ");
    return fail(`No rows could be matched. CSV headers (${headers}) must include the key field “${dataset.fields.find((field) => field.key === dataset.keyField)?.label ?? dataset.keyField}”.`);
  }
  await upsertRecords(env.DB, records.map((record) => ({ siteId: dataset.siteId, datasetId, key: record.key, data: record.data, sourceUrl: "csv-import" })));
  if (dataset.status === "proposed") await upsertDataset(env.DB, { ...dataset, status: "active", updatedAt: new Date().toISOString() });
  return json({ imported: records.length, skipped: rows.length - records.length });
}
