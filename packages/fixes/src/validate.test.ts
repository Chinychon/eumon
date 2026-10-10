import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSON_LD_COMPONENT } from "./edit/jsonld.js";
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

describe("adversarial", () => {
  const ins = (text: string, over: object = {}) => validateEdit({ ...base, edits: [{ start: insertAt, end: insertAt, text }], ...over });
  const top = source.indexOf("\n");
  const topIns = (text: string) => validateEdit({ ...base, allowedRanges: [{ start: top, end: top }], edits: [{ start: top, end: top, text }] });
  const reason = (r: { ok: boolean }) => String((r as { reason?: string }).reason);
  it("refuses start > end", () => {
    assert.equal(validateEdit({ ...base, edits: [{ start: objectEnd, end: objectStart, text: "" }] }).ok, false);
  });
  it("refuses calls inside a template", () => {
    assert.match(reason(ins("\n  d: `${String.constructor(\"x\")()}`,")), /Call|constructor/);
    assert.equal(ins("\n  d: `${String.constructor(\"x\")()}`,").ok, false);
  });
  it("refuses import()", () => {
    assert.match(reason(ins("\n  d: import(\"fs\"),")), /Import|Call/);
  });
  it("refuses export * from", () => {
    assert.equal(topIns(`\nexport * from "evil";`).ok, false);
  });
  it("refuses a side-effect import of a lookalike", () => {
    assert.equal(topIns(`\nimport "https://evil.example/eumon-json-ld";`).ok, false);
  });
  it("refuses export const dynamic", () => {
    assert.equal(topIns(`\nexport const dynamic = "force-dynamic";`).ok, false);
  });
  it("refuses ev + al merging into eval", () => {
    const s = "const a = al(1);\n";
    const at = s.indexOf("al");
    const r = validateEdit({ ...base, filePath: "app/page.tsx", before: s, roots: [], allowedRanges: [{ start: at, end: at }], edits: [{ start: at, end: at, text: "ev" }] });
    assert.equal(r.ok, false);
  });
  it("caps inserted characters", () => {
    assert.match(reason(ins(`\n  d: "${"x".repeat(9000)}",`)), /characters/);
  });
  it("refuses path traversal", () => {
    assert.equal(validateEdit({ ...base, filePath: "app/../x/page.tsx", edits: [] }).ok, false);
  });
  it("still allows new URL", () => {
    assert.equal(ins("\n  metadataBase: new URL(\"https://x.com\"),").ok, true);
  });
});

describe("appended text", () => {
  const src = `export const metadata = {\n  title: procedure.name,\n};\n`;
  const at = src.indexOf("name,") + 4;
  const run = (text: string) => validateEdit({ ...base, before: src, roots: ["procedure"], allowedRanges: [{ start: 0, end: src.length }], edits: [{ start: at, end: at, text }] });
  it("refuses text that turns an existing expression into a call, assignment or computed member", () => {
    assert.equal(run('("x")').ok, false);
    assert.equal(run(' = "x"').ok, false);
    assert.equal(run('["constructor"]').ok, false);
    assert.equal(run('.constructor.constructor("return process.env")()').ok, false);
  });
  it("allows a component import at offset 0 of a file with no imports", () => {
    const plain = `export default function P() { return <main/>; }\n`;
    const r = validateEdit({ ...base, before: plain, roots: [], allowedRanges: [{ start: 0, end: 0 }], edits: [{ start: 0, end: 0, text: `import { EumonJsonLd } from "../components/eumon-json-ld";\n` }] });
    assert.equal(r.ok, true);
  });
  it("counts \\r-separated lines", () => {
    const r = run(Array.from({ length: 70 }, () => "").join("\r"));
    assert.equal(r.ok, false);
    assert.match(String((r as { reason?: string }).reason), /lines/);
  });
});

describe("validateFile", () => {
  it("allows only the whole-file targets", () => {
    assert.equal(validateFile("public/llms.txt", "# x", []).ok, true);
    assert.equal(validateFile("components/eumon-json-ld.tsx", JSON_LD_COMPONENT, []).ok, true);
    assert.equal(validateFile("src/components/eumon-json-ld.tsx", JSON_LD_COMPONENT, []).ok, true);
    assert.equal(validateFile("next.config.js", "x", []).ok, false);
  });
  it("refuses any component that isn't exactly Eumon's", () => {
    assert.equal(validateFile("components/eumon-json-ld.tsx", `import fs from "fs";\n${JSON_LD_COMPONENT}`, []).ok, false);
    assert.equal(validateFile("src/components/eumon-json-ld.tsx", JSON_LD_COMPONENT + "// x\n", []).ok, false);
    assert.equal(validateFile("components/eumon-json-ld.tsx", "export function EumonJsonLd() { return null; }", []).ok, false);
  });
});
