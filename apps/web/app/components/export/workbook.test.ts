import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { fileName, sheetNames, toCsv, toCsvZip, toTsv, toXlsx, type Sheet } from "./workbook.ts";

const queries: Sheet = { name: "Top queries", columns: ["Query", "Clicks", "CTR"], rows: [["braces, price \"kl\"", 52, 0.022], ["line\nbreak", null, 0.1]] };

describe("export workbook", () => {
  it("writes CSV that quotes commas, quotes and line breaks, and leaves empty cells empty", () => {
    assert.equal(toCsv(queries), 'Query,Clicks,CTR\r\n"braces, price ""kl""",52,0.022\r\n"line\nbreak",,0.1\r\n');
  });

  it("copies as tab-separated cells, naming each table when there are several", () => {
    assert.equal(toTsv([queries]).split("\n")[1], "braces, price \"kl\"\t52\t0.022");
    assert.ok(toTsv([queries, { ...queries, name: "Again" }]).startsWith("Top queries\nQuery\tClicks\tCTR"));
  });

  it("makes Excel-safe, unique sheet names", () => {
    assert.deepEqual(sheetNames(["Pages: to fix?", "Pages: to fix?", "A very long sheet name that goes past the limit"]), ["Pages to fix", "Pages to fix 2", "A very long sheet name that goe"]);
  });

  it("builds a workbook Excel can open: one sheet per table, numbers as numbers, text escaped", () => {
    const files = unzipSync(toXlsx([queries, { name: "Countries", columns: ["Country", "Share"], rows: [["Malaysia & Singapore", 0.84]] }]));
    assert.ok(files["[Content_Types].xml"] && files["xl/workbook.xml"] && files["xl/styles.xml"]);
    assert.match(strFromU8(files["xl/workbook.xml"]!), /<sheet name="Top queries" sheetId="1" r:id="rId1"\/><sheet name="Countries" sheetId="2"/);
    const first = strFromU8(files["xl/worksheets/sheet1.xml"]!);
    assert.match(first, /<c r="B2"><v>52<\/v><\/c>/, "a number cell");
    assert.match(first, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">braces, price &quot;kl&quot;<\/t><\/is><\/c>/);
    assert.doesNotMatch(first, /r="B3"/, "an empty cell is left out");
    assert.match(strFromU8(files["xl/worksheets/sheet2.xml"]!), /Malaysia &amp; Singapore/);
  });

  it("zips one CSV per table and names files after the title and day", () => {
    const files = unzipSync(toCsvZip([queries]));
    assert.deepEqual([...files["Top queries.csv"]!.slice(0, 3)], [0xef, 0xbb, 0xbf], "a UTF-8 byte-order mark, so Excel reads Malay and accented text right");
    assert.ok(strFromU8(files["Top queries.csv"]!.slice(3)).startsWith("Query,Clicks"));
    assert.equal(fileName("Search · Demo Dental Clinic", "2026-10-09", "xlsx"), "search-demo-dental-clinic-2026-10-09.xlsx");
  });
});

describe("spreadsheet formulas", () => {
  it("neutralises text that a spreadsheet would run as a formula, and leaves numbers alone", () => {
    const sheet = { name: "Queries", columns: ["Query", "Change"], rows: [["=HYPERLINK(\"http://evil\",\"x\")", -5], ["-2+3", 7], ["@sum", null], ["price", 1]] };
    const csv = toCsv(sheet).split("\r\n");
    assert.equal(csv[1], "\"'=HYPERLINK(\"\"http://evil\"\",\"\"x\"\")\",-5");
    assert.equal(csv[2], "'-2+3,7");
    assert.equal(csv[3], "'@sum,");
    assert.equal(csv[4], "price,1");
    assert.equal(toTsv([sheet]).split("\n")[2], "'-2+3\t7");
  });
});

describe("formula guard", () => {
  it("defuses cells that start with a tab or carriage return too", () => {
    const rows = toCsv({ name: "x", columns: ["a"], rows: [["\t=1+1"], ["\r=1+1"], ["=1+1"]] }).split("\r\n").slice(1, 4);
    for (const row of rows) assert.match(row, /^"?'/, JSON.stringify(row));
  });
});
