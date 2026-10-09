import { sheetTitles } from "@organic-growth/core";
import { strToU8, zipSync } from "fflate";

/*
 * Tables as files: CSV, tab-separated text for the clipboard (it pastes as
 * cells into Sheets and Excel), and a minimal .xlsx workbook with one sheet
 * per table. No React here, so it runs under `node --test`.
 */

export type Cell = string | number | null;
export type Sheet = { name: string; columns: string[]; rows: Cell[][] };

const text = (cell: Cell) => (cell === null ? "" : String(cell));

/** Text a spreadsheet would run as a formula (starting =, +, - or @) gets a leading apostrophe, which Excel and Sheets show as text. Numbers stay numbers. */
const safeText = (cell: Cell) => (typeof cell === "string" && /^[=+\-@]/.test(cell) ? `'${cell}` : text(cell));

/** RFC 4180 CSV: fields with a comma, quote or line break are quoted, quotes doubled; CRLF line ends. */
export function toCsv(sheet: Sheet): string {
  const field = (cell: Cell) => {
    const value = safeText(cell);
    return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  };
  return [sheet.columns, ...sheet.rows].map((row) => row.map(field).join(",")).join("\r\n") + "\r\n";
}

/** Tab-separated rows; several sheets are separated by a blank line under each one's name. */
export function toTsv(sheets: Sheet[]): string {
  const clean = (cell: Cell) => safeText(cell).replace(/[\t\r\n]+/g, " ");
  const one = (sheet: Sheet) => [sheet.columns, ...sheet.rows].map((row) => row.map(clean).join("\t")).join("\n");
  return sheets.length === 1 ? one(sheets[0]!) : sheets.map((sheet) => `${sheet.name}\n${one(sheet)}`).join("\n\n");
}

/** Excel sheet names: at most 31 characters, none of []:*?/\, unique in the workbook. */
export const sheetNames = (names: string[]) => sheetTitles(names, 31);

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  // Characters XML 1.0 forbids would make Excel refuse the file.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

function column(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function worksheet(sheet: Sheet): string {
  const rows = [sheet.columns, ...sheet.rows].map((row, r) => {
    const cells = row.map((cell, c) => {
      const ref = `${column(c)}${r + 1}`;
      if (cell === null || cell === "") return "";
      // The header row uses the bold style; numbers stay numbers so they sum and sort.
      const style = r === 0 ? ' s="1"' : "";
      if (typeof cell === "number" && Number.isFinite(cell)) return `<c r="${ref}"${style}><v>${cell}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(String(cell))}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");
  const freeze = '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}<sheetData>${rows}</sheetData></worksheet>`;
}

/** A workbook with one sheet per table: bold, frozen header rows; numbers as numbers. */
export function toXlsx(sheets: Sheet[]): Uint8Array {
  const names = sheetNames(sheets.map((sheet) => sheet.name));
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((name, index) => `<sheet name="${xml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`),
  };
  sheets.forEach((sheet, index) => { files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(worksheet(sheet)); });
  return zipSync(files, { level: 6 });
}

/** Several CSVs in one .zip, one file per table. */
export function toCsvZip(sheets: Sheet[]): Uint8Array {
  const names = sheetNames(sheets.map((sheet) => sheet.name));
  return zipSync(Object.fromEntries(sheets.map((sheet, index) => [`${names[index]}.csv`, strToU8(`﻿${toCsv(sheet)}`)])), { level: 6 });
}

/** A file name from a title: lower-case words joined by hyphens, with the date. */
export const fileName = (title: string, day: string, extension: string) =>
  `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "export"}-${day}.${extension}`;
