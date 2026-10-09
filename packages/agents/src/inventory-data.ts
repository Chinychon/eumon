import type { Dataset } from "@organic-growth/core";
import { datasetInventoryRows, listDatasets, type D1Like } from "@organic-growth/db";
import { inventoryFromRows, type Inventory } from "@organic-growth/pages";
import type { InventorySignal } from "./connector-findings.js";

/** A dataset's inventory from four queries: fills per field, every record's name, and its records' pages in a crawl (the latest finished one unless an analysis is named). */
export async function datasetInventory(db: D1Like, dataset: Pick<Dataset, "id" | "siteId" | "fields" | "keyField">, analysisId?: string): Promise<Inventory> {
  return inventoryFromRows(dataset.fields, await datasetInventoryRows(db, dataset, analysisId));
}

/** The site's datasets with records, largest first, at most `limit` (four queries each); `analysisId` reads the crawl of the run in progress. */
export async function loadInventories(db: D1Like, siteId: string, options: { analysisId?: string; limit?: number } = {}): Promise<InventorySignal[]> {
  const datasets = (await listDatasets(db, siteId)).filter((dataset) => dataset.recordCount > 0).sort((a, b) => b.recordCount - a.recordCount).slice(0, options.limit ?? 3);
  return Promise.all(datasets.map(async (dataset) => ({
    dataset: { id: dataset.id, name: dataset.name, entityType: dataset.entityType, records: dataset.recordCount },
    inventory: await datasetInventory(db, dataset, options.analysisId),
  })));
}
