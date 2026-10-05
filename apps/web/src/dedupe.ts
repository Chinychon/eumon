import type { JsonLlm } from "@organic-growth/ai";
import type { Dataset } from "@organic-growth/core";
import { listAllRecords, mergeRecords, type D1Like } from "@organic-growth/db";
import { findDuplicateRecords, mergeRecordData } from "@organic-growth/scraper";

/**
 * Merges records that name the same entity (e.g. "Gurney Paragon" and
 * "Gurney Paragon Mall"), so one entity never becomes two competing pages.
 */
export async function mergeDuplicateRecords(db: D1Like, llm: JsonLlm, dataset: Dataset): Promise<Array<{ canonical: string; merged: string[] }>> {
  const records = await listAllRecords(db, dataset.id, 20_000);
  const byId = new Map(records.map((record) => [record.id, record]));
  const clusters = await findDuplicateRecords({ llm, dataset, records });
  const summary: Array<{ canonical: string; merged: string[] }> = [];
  for (const cluster of clusters) {
    const canonical = byId.get(cluster.canonicalId);
    if (!canonical) continue;
    const duplicates = cluster.duplicateIds.map((id) => byId.get(id)).filter((record) => record !== undefined);
    await mergeRecords(db, {
      canonicalId: canonical.id,
      duplicateIds: duplicates.map((record) => record.id),
      data: mergeRecordData(dataset.fields, canonical.data, duplicates.map((record) => record.data)),
    });
    const name = String(canonical.data[dataset.keyField] ?? canonical.key);
    summary.push({ canonical: name, merged: cluster.names.filter((entry) => entry !== name) });
  }
  return summary;
}
