/*
 * Google Sheets: a new spreadsheet holding exported tables, one sheet per
 * table with a bold, frozen header row. Needs the `drive.file` scope, which
 * only reaches files Eumon creates.
 */

import { googleError } from "./google-search-console.js";

export type SheetTable = { name: string; columns: string[]; rows: Array<Array<string | number | null>> };

/** Unique sheet titles, as Google requires; brackets and a few other characters confuse A1 ranges, so they go. */
function titles(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base = name.replace(/[[\]:*?/\\']/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || "Sheet";
    let title = base;
    for (let n = 2; used.has(title.toLowerCase()); n++) title = `${base} ${n}`;
    used.add(title.toLowerCase());
    return title;
  });
}

const cell = (value: string | number | null, header: boolean) => ({
  ...(value === null ? {} : { userEnteredValue: typeof value === "number" && Number.isFinite(value) ? { numberValue: value } : { stringValue: String(value) } }),
  ...(header ? { userEnteredFormat: { textFormat: { bold: true } } } : {}),
});

/** Creates the spreadsheet with its data in one request and returns its URL. */
export async function createSpreadsheet(accessToken: string, title: string, tables: SheetTable[], fetchFn: typeof fetch = fetch): Promise<string> {
  const names = titles(tables.map((table) => table.name));
  const response = await fetchFn("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: { title },
      sheets: tables.map((table, index) => ({
        properties: { sheetId: index, title: names[index], gridProperties: { frozenRowCount: 1 } },
        data: [{ startRow: 0, startColumn: 0, rowData: [table.columns, ...table.rows].map((row, rowIndex) => ({ values: row.map((value) => cell(value, rowIndex === 0)) })) }],
      })),
    }),
  });
  if (!response.ok) throw await googleError(response, "Google Sheets request");
  const json = await response.json() as { spreadsheetUrl?: string; spreadsheetId?: string };
  return json.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${json.spreadsheetId}/edit`;
}
