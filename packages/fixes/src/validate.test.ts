import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateEdit, validateFile } from "./validate.js";

const source = `import x from "x";\nexport const metadata = {\n  title: "Old",\n};\nexport default function P() { return <main/>; }\n`;
const objectStart = source.indexOf("{");
const objectEnd = source.indexOf("};") + 1;
const base = { filePath: "app/about/page.tsx", before: source, allowedRanges: [{ start: objectStart, end: objectEnd }], roots: ["procedure"], sensitivePaths: [] };
const insertAt = source.indexOf(`"Old",`) + `"Old",`.length;

describe("validateEdit", () => {
  it("accepts an edit inside the allowed object that uses in-scope names", () => {
    const result = validateEdit({ ...base, edits: [{ start: insertAt, end: insertAt, text: "\n  description: `${procedure.name} in Malaysia`," }] });
    assert.equal(result.ok, true);
  });

  it("refuses edits outside the allowed range", () => {
    const at = source.indexOf("<main/>");
    assert.match(String((validateEdit({ ...base, edits: [{ start: at, end: at, text: "x" }] }) as { reason?: string }).reason), /outside/);
  });

  it("refuses unknown variables, but not property keys or member names", () => {
    const bad = validateEdit({ ...base, edits: [{ start: insertAt, end: insertAt, text: "\n  description: `${doctor.name}`," }] });
    assert.match(String((bad as { reason?: string }).reason), /doctor/);
  });

  it("refuses an edit that breaks parsing", () => {
    assert.equal(validateEdit({ ...base, edits: [{ start: insertAt, end: insertAt, text: "\n  description: `${procedure.name" }] }).ok, false);
  });

  it("refuses files off the allowlist, sensitive paths and oversized diffs", () => {
    assert.equal(validateEdit({ ...base, filePath: "app/api/route.ts", edits: [] }).ok, false);
    assert.equal(validateEdit({ ...base, filePath: "app/auth/page.tsx", sensitivePaths: ["app/auth/page.tsx"], edits: [] }).ok, false);
    const big = Array.from({ length: 70 }, (_, i) => `\n  k${i}: "v",`).join("");
    assert.equal(validateEdit({ ...base, edits: [{ start: insertAt, end: insertAt, text: big }] }).ok, false);
  });

  it("refuses new imports other than the Eumon component", () => {
    const top = source.indexOf("\n") ;
    const sneaky = validateEdit({ ...base, allowedRanges: [{ start: top, end: top }], edits: [{ start: top, end: top, text: `\nimport fs from "fs";` }] });
    assert.equal(sneaky.ok, false);
    const fine = validateEdit({ ...base, allowedRanges: [{ start: top, end: top }], edits: [{ start: top, end: top, text: `\nimport { EumonJsonLd } from "../components/eumon-json-ld";` }] });
    assert.equal(fine.ok, true);
  });
});

describe("declarations", () => {
  it("lets an edit declare a new top-level name such as metadata", () => {
    const src = `import x from "x";\nexport default function P() { return <main/>; }\n`;
    const at = src.indexOf("\n");
    const result = validateEdit({ ...base, before: src, roots: [], allowedRanges: [{ start: at, end: at }], edits: [{ start: at, end: at, text: "\nexport const metadata = { title: \"A\" };" }] });
    assert.equal(result.ok, true);
  });
});

describe("validateFile", () => {
  it("allows only the whole-file targets", () => {
    assert.equal(validateFile("public/llms.txt", "# x", []).ok, true);
    assert.equal(validateFile("components/eumon-json-ld.tsx", "export function EumonJsonLd() { return null; }", []).ok, true);
    assert.equal(validateFile("next.config.js", "x", []).ok, false);
  });
});
