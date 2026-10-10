import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEdits, validateEdit } from "../validate.js";
import { editMetadata, editMetadataBase } from "./metadata.js";
import { toCode } from "../code.js";

const applied = (source: string, result: ReturnType<typeof editMetadata>, file = "app/procedures/[slug]/page.tsx") => {
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return "";
  const checked = validateEdit({ filePath: file, before: source, edits: result.edits, allowedRanges: result.allowedRanges, roots: result.roots, sensitivePaths: [] });
  assert.equal(checked.ok, true, checked.ok ? "" : checked.reason);
  return applyEdits(source, result.edits);
};

describe("toCode", () => {
  it("makes template literals only when there are placeholders, escaping backticks", () => {
    assert.equal(toCode("About us"), `"About us"`);
    assert.equal(toCode("{procedure.name} `cost`"), "`${procedure.name} \\`cost\\``");
  });
});

describe("editMetadata", () => {
  const dynamic = `export async function generateMetadata({ params }) {\n  const { slug } = await params;\n  const procedure = await get(slug);\n  return {\n    title: procedure.name\n  };\n}\n`;

  it("sets title, description and alternates inside generateMetadata's returned object", () => {
    const after = applied(dynamic, editMetadata(dynamic, { title: "{procedure.name} | MedBay", description: "{procedure.name} in Malaysia: costs and specialists.", canonical: "/procedures/{slug}" }, true));
    assert.match(after, /title: `\$\{procedure\.name\} \| MedBay`/);
    assert.match(after, /description: `\$\{procedure\.name\} in Malaysia: costs and specialists\.`/);
    assert.match(after, /alternates: \{ canonical: `\/procedures\/\$\{slug\}` \}/);
  });

  it("adds into an existing alternates object instead of replacing it", () => {
    const source = `export const metadata = {\n  title: "About",\n  alternates: { languages: { en: "/about" } },\n};\n`;
    const after = applied(source, editMetadata(source, { canonical: "/about" }, false), "app/about/page.tsx");
    assert.match(after, /alternates: \{ languages: \{ en: "\/about" \},\n  canonical: "\/about",? \}/);
  });

  it("adds a static metadata export to a static page without one", () => {
    const source = `import x from "x";\nexport default function P() { return <main/>; }\n`;
    const after = applied(source, editMetadata(source, { title: "About | MedBay" }, false), "app/about/page.tsx");
    assert.match(after, /import x from "x";\n\nexport const metadata = \{\n  title: "About \| MedBay",\n\};/);
  });

  it("skips with a snippet where it can't edit safely", () => {
    const none = editMetadata(`export default function P() { return <main/>; }`, { title: "{x.name}" }, true);
    assert.equal(none.ok, false);
    if (!none.ok) assert.match(none.snippet, /generateMetadata/);
    const client = editMetadata(`"use client";\nexport default function P() { return <main/>; }`, { title: "A" }, false);
    assert.equal(client.ok, false);
    const alias = editMetadata(`export const metadata = { alternates: shared };`, { canonical: "/a" }, false);
    assert.equal(alias.ok, false);
  });
});

describe("editMetadataBase", () => {
  it("adds metadataBase to the root layout's metadata", () => {
    const source = `export const metadata = { title: "MedBay" };\nexport default function L({ children }) { return <html><body>{children}</body></html>; }\n`;
    const after = applied(source, editMetadataBase(source, "https://medbaycare.com"), "app/layout.tsx");
    assert.match(after, /metadataBase: new URL\("https:\/\/medbaycare\.com"\)/);
  });
});
