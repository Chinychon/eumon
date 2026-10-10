import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEdits, validateEdit, validateFile } from "../validate.js";
import { componentPath, editJsonLd, importPath, JSON_LD_COMPONENT } from "./jsonld.js";

const page = `import { get } from "@/lib/data";

export default async function Page({ params }) {
  const { slug } = await params;
  const procedure = await get(slug);
  return (
    <main className="wrap">
      <h1>{procedure.name}</h1>
    </main>
  );
}
`;
const plan = { schemaType: "MedicalProcedure", fields: [{ field: "name", path: "procedure.name" }], url: "/procedures/{slug}", origin: "https://x.com" };

describe("editJsonLd", () => {
  it("imports the component and renders it first inside the page root, with a breadcrumb", () => {
    const file = "app/procedures/[slug]/page.tsx";
    const result = editJsonLd(file, page, plan, ["app/page.tsx", file]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const checked = validateEdit({ filePath: file, before: page, edits: result.edits, allowedRanges: result.allowedRanges, roots: result.roots, sensitivePaths: [] });
    assert.equal(checked.ok, true, checked.ok ? "" : checked.reason);
    const after = applyEdits(page, result.edits);
    assert.match(after, /import \{ EumonJsonLd \} from "\.\.\/\.\.\/\.\.\/components\/eumon-json-ld";/);
    assert.match(after, /<main className="wrap">\n      <EumonJsonLd data=\{\[\{ "@context": "https:\/\/schema\.org", "@type": "MedicalProcedure", "name": procedure\.name, url: `https:\/\/x\.com\/procedures\/\$\{slug\}` \}, \{ "@context": "https:\/\/schema\.org", "@type": "BreadcrumbList"/);
    assert.equal(result.files["components/eumon-json-ld.tsx"], JSON_LD_COMPONENT);
    assert.equal(validateFile("components/eumon-json-ld.tsx", JSON_LD_COMPONENT, []).ok, true);
  });

  it("reuses an existing component and uses src/ layouts", () => {
    assert.equal(componentPath(["src/app/page.tsx"]), "src/components/eumon-json-ld.tsx");
    assert.equal(importPath("src/app/a/page.tsx", "src/components/eumon-json-ld.tsx"), "../../components/eumon-json-ld");
    const result = editJsonLd("app/procedures/[slug]/page.tsx", page, plan, ["components/eumon-json-ld.tsx"]);
    assert.ok(result.ok && Object.keys(result.files).length === 0);
  });

  it("skips pages it can't edit safely, or that already have it", () => {
    assert.equal(editJsonLd("app/a/page.tsx", `export default function P() { if (x) return <a/>; return <main></main>; }`, plan, []).ok, false);
    assert.equal(editJsonLd("app/a/page.tsx", page.replace("<h1>", "<EumonJsonLd data={{}} /><h1>"), plan, []).ok, false);
  });
});
