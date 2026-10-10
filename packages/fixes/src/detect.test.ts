import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detect, ROOT_LAYOUTS, schemaTypeFor } from "./detect.js";
import { routeForPath, stripLocale } from "./match.js";
import type { DetectInput, PageHead, RouteRef } from "./types.js";

const route = (pathPattern: string, source: string, dynamic = pathPattern.includes(":")): RouteRef =>
  ({ pathPattern, source, dynamic, rendering: "ssr", metadata: "server" });
const page = (url: string, head: Partial<PageHead> = {}): PageHead =>
  ({ url, status: 200, title: `${url} title that is fine`, description: `${url} ${"d".repeat(100)}`, canonical: url, hreflang: [], jsonLdTypes: ["WebPage"], ...head });

const routes = [route("/", "app/page.tsx"), route("/procedures/:slug", "app/procedures/[slug]/page.tsx"), route("/procedures/featured", "app/procedures/featured/page.tsx")];
const base: DetectInput = {
  origin: "https://x.com", siteName: "MedBay", pages: [], routes,
  rootLayout: { path: "app/layout.tsx", hasMetadataBase: true },
  llmsTxt: { exists: true, managedByEumon: false }, robots: { blocksAiSearch: [] }, allowAiSearch: false,
};

describe("matching", () => {
  it("prefers the route with more static segments and strips locale prefixes", () => {
    assert.equal(routeForPath("/procedures/featured", routes)?.source, "app/procedures/featured/page.tsx");
    assert.equal(routeForPath("/procedures/acl", routes)?.source, "app/procedures/[slug]/page.tsx");
    const mixed = [route("/:a/b/c", "x"), route("/p/:b/:c", "y")];
    assert.equal(routeForPath("/p/q/c", mixed)?.source, "y");
    assert.equal(routeForPath("/z/featured", [route("/:a/featured", "a"), route("/:b/featured", "b")]), undefined);
    assert.deepEqual(stripLocale("/id/procedures/acl"), { locale: "id", path: "/procedures/acl" });
    assert.deepEqual(stripLocale("/identity"), { locale: null, path: "/identity" });
  });

  it("picks a schema type from the route's words", () => {
    assert.equal(schemaTypeFor("/"), "Organization");
    assert.equal(schemaTypeFor("/procedures/:slug"), "MedicalProcedure");
    assert.equal(schemaTypeFor("/doctors/:slug"), "Physician");
    assert.equal(schemaTypeFor("/things/:slug"), "WebPage");
  });
});

describe("detect", () => {
  it("groups head problems per route into one candidate", () => {
    const pages = [
      page("https://x.com/procedures/a", { title: "MedBay", description: undefined }),
      page("https://x.com/procedures/b", { title: "Same", description: "short" }),
      page("https://x.com/procedures/c", { title: "Same" }),
    ];
    const [head] = detect({ ...base, pages }).filter((c) => c.kind === "head");
    assert.equal(head?.file, "app/procedures/[slug]/page.tsx");
    assert.deepEqual(head?.problems, ["description-length", "description-missing", "title-duplicate", "title-missing"]);
    assert.equal(head?.urls.length, 3);
  });

  it("waits for metadataBase before fixing canonicals", () => {
    const pages = [page("https://x.com/procedures/a", { canonical: undefined }), page("https://x.com/procedures/b", { canonical: undefined })];
    const out = detect({ ...base, pages, rootLayout: { path: "app/layout.tsx", hasMetadataBase: false } });
    assert.equal(out.find((c) => c.kind === "head"), undefined, "no canonical-only head fix yet");
    assert.equal(out.find((c) => c.kind === "metadata-base")?.pageCount, 2);
  });

  it("flags hreflang only on paths that exist in more than one locale", () => {
    const pages = [page("https://x.com/procedures/a"), page("https://x.com/id/procedures/a"), page("https://x.com/procedures/b")];
    const head = detect({ ...base, pages }).find((c) => c.kind === "head");
    assert.deepEqual(head?.problems, ["hreflang-missing"]);
    assert.deepEqual(head?.urls.sort(), ["https://x.com/id/procedures/a", "https://x.com/procedures/a"]);
    assert.deepEqual(head?.pathLocales, { "/procedures/a": ["default", "id"] });
  });

  it("proposes nothing for canonicals and hreflang while the root layout is unknown (C1)", () => {
    const pages = [page("https://x.com/procedures/a", { canonical: undefined }), page("https://x.com/id/procedures/a", { canonical: undefined })];
    const out = detect({ ...base, pages, rootLayout: undefined });
    assert.equal(out.find((c) => c.kind === "head"), undefined);
    assert.equal(out.find((c) => c.kind === "metadata-base"), undefined);
  });

  it("defers hreflang like canonicals and proposes metadataBase for a .js layout (C1)", () => {
    const pages = [page("https://x.com/procedures/a"), page("https://x.com/id/procedures/a")];
    const out = detect({ ...base, pages, rootLayout: { path: "app/layout.js", hasMetadataBase: false } });
    assert.equal(out.find((c) => c.kind === "head"), undefined);
    const fix = out.find((c) => c.kind === "metadata-base");
    assert.equal(fix?.file, "app/layout.js");
    assert.deepEqual(fix?.problems, ["hreflang-missing"]);
    assert.ok(ROOT_LAYOUTS.includes("app/layout.js") && ROOT_LAYOUTS.includes("src/app/layout.ts"));
  });

  it("proposes JSON-LD for dynamic routes mostly without it, plus llms.txt and AI robots when allowed", () => {
    const pages = [page("https://x.com/procedures/a", { jsonLdTypes: [] }), page("https://x.com/procedures/b", { jsonLdTypes: [] })];
    const out = detect({ ...base, pages, llmsTxt: { exists: false, managedByEumon: false }, robots: { path: "public/robots.txt", blocksAiSearch: ["OAI-SearchBot"] }, allowAiSearch: true });
    assert.equal(out.find((c) => c.kind === "jsonld")?.schemaType, "MedicalProcedure");
    assert.ok(out.some((c) => c.kind === "llms-txt"));
    assert.ok(out.some((c) => c.kind === "ai-robots"));
    assert.equal(detect({ ...base, pages, robots: { path: "public/robots.txt", blocksAiSearch: ["OAI-SearchBot"] } }).some((c) => c.kind === "ai-robots"), false, "off unless the site allows AI search");
  });

  it("ignores pages that aren't 200 and caps candidates and URLs", () => {
    const pages = Array.from({ length: 30 }, (_, i) => page(`https://x.com/procedures/p${i}`, { description: undefined }));
    pages.push(page("https://x.com/procedures/gone", { status: 404, title: undefined }));
    const head = detect({ ...base, pages, limit: 1 });
    assert.equal(head.length, 1);
    assert.equal(head[0]!.urls.length, 20);
    assert.ok(!head[0]!.urls.includes("https://x.com/procedures/gone"));
  });

  it("skips pages whose URL does not parse", () => {
    const pages = [page("not a url", { title: undefined, description: undefined, canonical: undefined })];
    assert.equal(detect({ ...base, pages }).some((c) => c.kind === "head" || c.kind === "metadata-base"), false);
  });
});
