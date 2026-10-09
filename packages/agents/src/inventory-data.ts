import type { Dataset } from "@organic-growth/core";
import { datasetInventoryRows, listDatasets, type D1Like } from "@organic-growth/db";
import { inventoryFromRows, type Inventory } from "@organic-growth/pages";
import type { InventorySignal } from "./connector-findings.js";

/** A dataset's inventory from four queries: fills per field, every record's name, and its records' pages in the latest finished crawl. */
export async function datasetInventory(db: D1Like, dataset: Pick<Dataset, "id" | "siteId" | "fields" | "keyField">): Promise<Inventory> {
  return inventoryFromRows(dataset.fields, await datasetInventoryRows(db, dataset));
}

/** The site's datasets with records, largest first, at most `limit` (four queries each). */
export async function loadInventories(db: D1Like, siteId: string, limit = 3): Promise<InventorySignal[]> {
  const datasets = (await listDatasets(db, siteId)).filter((dataset) => dataset.recordCount > 0).sort((a, b) => b.recordCount - a.recordCount).slice(0, limit);
  return Promise.all(datasets.map(async (dataset) => ({
    dataset: { id: dataset.id, name: dataset.name, entityType: dataset.entityType, records: dataset.recordCount },
    inventory: await datasetInventory(db, dataset),
  })));
}
