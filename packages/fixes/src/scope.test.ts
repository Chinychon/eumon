import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseModule } from "./ast.js";
import { findMetadata, findPage, memberPaths, urlTemplate } from "./scope.js";

const dynamicPage = `import { getProcedure } from "@/lib/data";
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const procedure = await getProcedure(slug);
  return { title: procedure.name };
}
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const procedure = await getProcedure(slug);
  return (
    <main>
      <h1>{procedure.name}</h1>
      <p>{procedure.summary.en}</p>
    </main>
  );
}`;

describe("scope", () => {
  it("finds generateMetadata's returned object and the names in scope before it", () => {
    const site = findMetadata(parseModule(dynamicPage));
    assert.equal(site.kind, "function");
    if (site.kind !== "function") return;
    assert.deepEqual(site.names.sort(), ["params", "procedure", "slug"]);
  });

  it("lists member paths used in the file for in-scope roots", () => {
    const program = parseModule(dynamicPage);
    const paths = memberPaths(program, ["procedure", "slug"]);
    assert.ok(paths.includes("procedure.name"));
    assert.ok(paths.includes("procedure.summary.en"));
    assert.ok(paths.includes("slug"));
    assert.ok(!paths.some((p) => p.startsWith("getProcedure")));
  });

  it("finds the page's single returned JSX and its scope", () => {
    const site = findPage(parseModule(dynamicPage));
    assert.equal(site.kind, "page");
    if (site.kind === "page") assert.ok(site.names.includes("procedure"));
  });

  it("reports static metadata objects, absent metadata, and unsupported shapes", () => {
    assert.equal(findMetadata(parseModule(`export const metadata = { title: "About" } satisfies Metadata;`)).kind, "object");
    assert.equal(findMetadata(parseModule(`import a from "a";\nexport default function P() { return <div/>; }`)).kind, "none");
    assert.equal(findMetadata(parseModule(`"use client";\nexport default function P() { return <div/>; }`)).kind, "unsupported");
    assert.equal(findMetadata(parseModule(`export const metadata = base;`)).kind, "unsupported");
    assert.equal(findMetadata(parseModule(`export async function generateMetadata() { if (x) return { title: "a" }; return { title: "b" }; }`)).kind, "unsupported");
    assert.equal(findPage(parseModule(`export default function P() { if (x) return <a/>; return <main></main>; }`)).kind, "unsupported");
  });

  it("builds a URL pattern from route params in scope, or gives up", () => {
    assert.equal(urlTemplate("/procedures/:slug", ["slug", "params"], dynamicPage), "/procedures/{slug}");
    assert.equal(urlTemplate("/procedures/:slug", ["params"], "export async function generateMetadata({ params }) {}"), "/procedures/{params.slug}");
    assert.equal(urlTemplate("/procedures/:slug", ["params"], "const { slug } = await params;"), null, "awaited params without a slug binding");
    assert.equal(urlTemplate("/about", [], ""), "/about");
  });

  it("treats indirect metadata exports as unsupported", () => {
    for (const src of [
      `const metadata = {}; export { metadata };`,
      `function generateMetadata() {} export { generateMetadata };`,
      `export { metadata } from "./m";`,
      `const x = {}; export { x as metadata };`,
      `export const { metadata } = m;`,
      `export * from "./m";`,
    ]) assert.equal(findMetadata(parseModule(src)).kind, "unsupported", src);
    assert.equal(findMetadata(parseModule(`const a = 1; export { a };`)).kind, "none");
  });

  it("limits scope to params and top-level declarations before the return", () => {
    const meta = (body: string) => {
      const site = findMetadata(parseModule(`export function generateMetadata(p, { q }) { ${body} }`));
      assert.equal(site.kind, "function");
      return site.kind === "function" ? site.names.sort() : [];
    };
    assert.deepEqual(meta(`const a = 1; return { t: a }; const b = 2;`), ["a", "p", "q"]);
    assert.deepEqual(meta(`if (x) { const inner = 1; } { const blk = 2; } const a = 1; return { t: a };`), ["a", "p", "q"]);
    assert.deepEqual(meta(`const f = () => { const local = 1; }; function g() { const l2 = 2; } return { t: f };`), ["f", "p", "q"]);
    const page = findPage(parseModule(`export default function P({ r }) { const a = 1; if (x) { const z = 1; } return <div></div>; const late = 1; }`));
    if (page.kind === "page") assert.deepEqual(page.names.sort(), ["a", "r"]);
    else assert.fail(page.reason);
  });
});
