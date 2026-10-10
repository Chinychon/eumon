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
});
