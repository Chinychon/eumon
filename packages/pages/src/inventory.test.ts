import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { duplicateGroups, inventoryFromRows, languageOf } from "./inventory.js";

const fields = [
  { key: "name", label: "Name" }, { key: "bio_en", label: "Bio (EN)" }, { key: "bio_id", label: "Bio (ID)" }, { key: "bio_zh", label: "Bio (ZH)" },
  { key: "hospital", label: "Hospital" }, { key: "url", label: "Page" }, { key: "id", label: "Record id" },
];

describe("languageOf", () => {
  it("reads a language from a label or a key suffix, and never from a bare key like id", () => {
    assert.deepEqual(languageOf({ key: "bio_en", label: "Bio (EN)" }), { base: "Bio", language: "EN" });
    assert.deepEqual(languageOf({ key: "bio-zh", label: "Biography Chinese" }), { base: "Biography Chinese", language: "ZH" });
    assert.deepEqual(languageOf({ key: "overview", label: "Overview (ID)" }), { base: "Overview", language: "ID" });
    assert.equal(languageOf({ key: "id", label: "Record id" }), null);
    assert.equal(languageOf({ key: "hospital", label: "Hospital" }), null);
    assert.deepEqual(languageOf({ key: "bio_ms", label: "Biography (Malay)" }), { base: "Biography", language: "MS" }, "a label without a code keeps its base; the key gives the language");
  });
});

describe("language groups", () => {
  it("groups variants by their key stem, and treats a lone _id or _it key as a plain field, not Indonesian or Italian", () => {
    const result = inventoryFromRows(
      [{ key: "name", label: "Name" }, { key: "bio_en", label: "Biography (English)" }, { key: "bio_ms", label: "Biography (Malay)" }, { key: "price_id", label: "Price id" }, { key: "role_it", label: "Role" }],
      { records: 10, fills: { name: 10, bio_en: 9, bio_ms: 5, price_id: 2, role_it: 1 }, names: [], pages: null },
    );
    assert.deepEqual(result.languages, [{ base: "Biography", variants: [{ language: "EN", filled: 9, share: 0.9 }, { language: "MS", filled: 5, share: 0.5 }] }]);
    assert.equal(result.fields.find((field) => field.key === "bio_ms")?.language, "MS");
    assert.equal("language" in result.fields.find((field) => field.key === "price_id")!, false, "a foreign key is a plain field");
    assert.equal("language" in result.fields.find((field) => field.key === "role_it")!, false);
  });
});

describe("duplicateGroups", () => {
  it("groups the same person under different honorifics, case and punctuation, and keeps different people apart", () => {
    const groups = duplicateGroups([
      { key: "a", name: "Dr Lim Ai Wei" }, { key: "b", name: "DR. LIM AI WEI" }, { key: "c", name: "Dato' Dr Lim Ai Wei" },
      { key: "d", name: "Prof Tan Mei" }, { key: "e", name: "Tan Mei" },
      { key: "f", name: "Dr Lim Ai" }, { key: "g", name: "Dr Lim" }, { key: "h", name: "" },
    ]);
    assert.deepEqual(groups, [{ name: "Dr Lim Ai Wei", keys: ["a", "b", "c"] }, { name: "Prof Tan Mei", keys: ["d", "e"] }]);
  });
});

describe("inventoryFromRows", () => {
  const rows = {
    records: 4,
    fills: { name: 4, bio_en: 3, bio_id: 3, bio_zh: 2, hospital: 3, url: 2, id: 0 },
    names: [{ key: "a", name: "Dr A" }, { key: "b", name: "Dr B" }, { key: "c", name: "Dr C" }, { key: "d", name: "dr. a" }],
    pages: { linked: 3, thin: 1, gone: 1, unreached: 0, examples: { thin: ["https://x.com/doctors/b"], gone: ["https://x.com/doctors/c"] } },
  };
  it("gives every field its share, groups language variants by their base, counts the duplicates and carries the pages through", () => {
    const result = inventoryFromRows(fields, rows);
    assert.equal(result.records, 4);
    assert.deepEqual(result.fields.find((field) => field.key === "bio_zh"), { key: "bio_zh", label: "Bio (ZH)", filled: 2, share: 0.5, language: "ZH" });
    assert.deepEqual(result.fields.find((field) => field.key === "hospital"), { key: "hospital", label: "Hospital", filled: 3, share: 0.75 });
    assert.deepEqual(result.languages, [{ base: "Bio", variants: [{ language: "EN", filled: 3, share: 0.75 }, { language: "ID", filled: 3, share: 0.75 }, { language: "ZH", filled: 2, share: 0.5 }] }]);
    assert.deepEqual(result.duplicates, { groups: 1, records: 2, examples: [{ name: "Dr A", keys: ["a", "d"] }] });
    assert.deepEqual(result.pages, rows.pages);
  });
  it("has no language group for a lone variant, no pages when there are none, and no division by zero", () => {
    const result = inventoryFromRows([{ key: "name", label: "Name" }, { key: "bio_en", label: "Bio (EN)" }], { ...rows, pages: null, fills: { name: 4, bio_en: 1 } });
    assert.deepEqual(result.languages, [], "one variant is not a group");
    assert.equal(result.pages, null);
    assert.equal(inventoryFromRows(fields, { ...rows, records: 0, fills: {}, names: [] }).fields[0]!.share, 0);
  });
});
