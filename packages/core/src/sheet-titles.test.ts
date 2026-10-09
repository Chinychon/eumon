import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sheetTitles } from "./sheet-titles.js";

describe("sheetTitles", () => {
  it("strips the characters spreadsheets refuse, trims to the limit, and keeps names unique within it", () => {
    assert.deepEqual(sheetTitles(["Pages: to fix?", "Pages to fix", "[Top] queries/2026"], 31), ["Pages to fix", "Pages to fix 2", "Top queries 2026"]);
    const long = "A very long table name that runs past the Excel limit";
    assert.deepEqual(sheetTitles([long, long], 31), ["A very long table name that run", "A very long table name that r 2"]);
    assert.equal(sheetTitles([""], 31)[0], "Sheet");
  });

  it("takes a longer limit and extra forbidden characters, so Excel and Google Sheets share one rule", () => {
    assert.deepEqual(sheetTitles(["Jo's list", "Jo's list"], 90, /[[\]:*?/\\']/g), ["Jo s list", "Jo s list 2"]);
  });
});
