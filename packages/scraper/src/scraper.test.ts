import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RESEARCH_TOKEN, parseRobots as parseRobotsFor, type Fetcher } from "@organic-growth/crawler";
import { expandSource } from "./discover.js";
import type { JsonLlm, JsonRequest } from "@organic-growth/ai";
import { coerceField, extractRecordsFromHtml, mapCsvRows, normalizeRecords, parseCsv } from "./extract.js";
import { slugify } from "@organic-growth/core";
import { PoliteFetcher } from "./fetch.js";
import { extractJsonLd, extractLinks, extractMeta, findNextPage, htmlToText } from "./html.js";
import { findDuplicateRecords, mergeRecordData } from "./resolve.js";
import { proposeScope, validateProposal } from "./scope.js";
import { compilePathPattern, summarizeRoutePatterns } from "./url-pattern.js";

const parseRobots = (body: string) => parseRobotsFor(body, RESEARCH_TOKEN);

describe("parseRobots", () => {
  const robots = parseRobots(`
User-agent: *
Disallow: /private
Allow: /private/press
Disallow: /*.pdf$
Crawl-delay: 2

User-agent: BadBot
Disallow: /

Sitemap: https://example.com/sitemap.xml
`);

  it("applies the longest matching rule", () => {
    assert.equal(robots.isAllowed("/private/data"), false);
    assert.equal(robots.isAllowed("/private/press/2026"), true);
    assert.equal(robots.isAllowed("/public"), true);
  });

  it("supports * and $ wildcards", () => {
    assert.equal(robots.isAllowed("/files/report.pdf"), false);
    assert.equal(robots.isAllowed("/files/report.pdf?x=1"), true);
  });

  it("collects sitemaps and crawl-delay for the matching group", () => {
    assert.deepEqual(robots.sitemaps, ["https://example.com/sitemap.xml"]);
    assert.equal(robots.crawlDelay, 2);
  });

  it("prefers a group naming our bot over the wildcard group", () => {
    const specific = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: EumonBot\nAllow: /");
    assert.equal(specific.isAllowed("/anything"), true);
  });

  it("treats an empty Disallow as allow-all", () => {
    assert.equal(parseRobots("User-agent: *\nDisallow:").isAllowed("/x"), true);
  });
});

describe("html helpers", () => {
  const html = `<html><head><title>Dr Amy Tan &amp; Partners</title>
<meta name="description" content="Cardiologist in KL">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Physician","name":"Dr Amy Tan"},{"@type":"Hospital","name":"Pantai"}]}</script>
<script type="application/ld+json">{ not json }</script>
</head><body><nav><a href="/menu">Menu</a></nav>
<main><h1>Dr Amy Tan</h1><p>Consultant cardiologist with 15 years of experience treating heart disease in Kuala Lumpur and Selangor. She sees international patients every weekday.</p>
<table><tr><th>Procedure</th><th>Price</th></tr><tr><td>Angiogram</td><td>RM 4,500</td></tr></table>
<ul><li>English</li><li>Malay</li></ul>
<a href="/doctors/ben-lim">Ben</a><a href="https://other.com/x">Other</a><a href="/doctors/ben-lim#reviews">Ben again</a>
<a rel="next" href="/doctors?page=2">Next</a></main><script>alert(1)</script></body></html>`;

  it("flattens JSON-LD graphs and skips malformed blocks", () => {
    assert.deepEqual(extractJsonLd(html).map((entry) => entry["@type"]), ["Physician", "Hospital"]);
  });

  it("keeps headings, tables, and lists while dropping scripts and nav", () => {
    const text = htmlToText(html);
    assert.ok(text.includes("# Dr Amy Tan"));
    assert.ok(text.includes("| Angiogram | RM 4,500 |"));
    assert.ok(text.includes("- English"));
    assert.ok(!text.includes("alert(1)"));
    assert.ok(!text.includes("Menu"));
  });

  it("reads page metadata with entities decoded", () => {
    const meta = extractMeta(html);
    assert.equal(meta.title, "Dr Amy Tan & Partners");
    assert.equal(meta.description, "Cardiologist in KL");
    assert.equal(meta.h1, "Dr Amy Tan");
  });

  it("extracts same-origin links without fragments, and the next page", () => {
    assert.deepEqual(extractLinks(html, "https://example.com/doctors"), [
      "https://example.com/menu",
      "https://example.com/doctors/ben-lim",
      "https://example.com/doctors?page=2",
    ]);
    assert.equal(findNextPage(html, "https://example.com/doctors"), "https://example.com/doctors?page=2");
  });
});

describe("findNextPage", () => {
  it("follows a zero-based numbered pager (Drupal views)", () => {
    const pager = `<a href="?page=0" title="Current page" aria-current="page">1</a><a href="?page=1" title="Go to page 2">2</a><a href="?page=2">3</a>`;
    assert.equal(findNextPage(pager, "https://x.com/project-highlights"), "https://x.com/project-highlights?page=1");
    assert.equal(findNextPage(pager.replace('aria-current="page"', ""), "https://x.com/project-highlights?page=1"), "https://x.com/project-highlights?page=2");
    assert.equal(findNextPage(pager, "https://x.com/project-highlights?page=2"), null);
  });

  it("follows WordPress-style /page/N/ paths and labelled next links", () => {
    assert.equal(findNextPage(`<a href="/blog/page/2/">2</a><a href="/blog/page/3/">3</a>`, "https://x.com/blog/"), "https://x.com/blog/page/2/");
    assert.equal(findNextPage(`<a href="/blog/page/3/">3</a>`, "https://x.com/blog/page/2/"), "https://x.com/blog/page/3/");
    assert.equal(findNextPage(`<a class="nav" href="/list?start=20">Next ›</a>`, "https://x.com/list"), "https://x.com/list?start=20");
  });

  it("ignores pagers of other lists and other sites", () => {
    assert.equal(findNextPage(`<a href="/other?page=2">2</a><a href="https://y.com/list?page=2">2</a>`, "https://x.com/list"), null);
  });
});

describe("url patterns", () => {
  it("matches one segment with * and many with **", () => {
    const single = compilePathPattern("/doctors/*");
    assert.equal(single("https://x.com/doctors/amy-tan"), true);
    assert.equal(single("https://x.com/doctors/amy-tan/"), true);
    assert.equal(single("https://x.com/doctors/amy-tan/reviews"), false);
    assert.equal(single("https://x.com/doctors"), false);
    assert.equal(compilePathPattern("/en/**")("https://x.com/en/a/b/c"), true);
  });

  it("summarizes route families from sitemap URLs", () => {
    const urls = [
      ...Array.from({ length: 8 }, (_, index) => `https://x.com/doctors/dr-${index}`),
      ...Array.from({ length: 3 }, (_, index) => `https://x.com/blog/post-${index}`),
      "https://x.com/about",
    ];
    assert.deepEqual(summarizeRoutePatterns(urls).map((group) => [group.pattern, group.count]), [["/doctors/*", 8]]);
  });
});

describe("record normalization", () => {
  const dataset = {
    keyField: "name",
    fields: [
      { key: "name", label: "Name", type: "text" as const, required: true },
      { key: "price", label: "Price (RM)", type: "number" as const },
      { key: "languages", label: "Languages", type: "list" as const },
      { key: "website", label: "Website", type: "url" as const },
      { key: "accepts_insurance", label: "Accepts insurance", type: "boolean" as const },
    ],
  };

  it("coerces values to their declared types", () => {
    assert.equal(coerceField(dataset.fields[1]!, "RM 12,500"), 12500);
    assert.equal(coerceField(dataset.fields[1]!, "call for price"), null);
    assert.deepEqual(coerceField(dataset.fields[2]!, "English; Malay, English"), ["English", "Malay"]);
    assert.equal(coerceField(dataset.fields[3]!, "javascript:alert(1)"), null);
    assert.equal(coerceField(dataset.fields[4]!, "Yes"), true);
  });

  it("combines repeated mentions of one entity on a page instead of keeping only the last", () => {
    const records = normalizeRecords(dataset, [
      { name: "Sunway Carnival Mall", languages: "Box Hunt" },
      { name: "Sunway Carnival Mall", languages: "OGAWA", price: "120" },
      { name: "Sunway Carnival Mall", languages: "TEVA" },
    ]);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0]!.data.languages, ["Box Hunt", "OGAWA", "TEVA"], "in page order");
    assert.equal(records[0]!.data.price, 120);
  });

  it("drops a record's own name from its list fields", () => {
    const [record] = normalizeRecords(dataset, [{ name: "Sunway Carnival Mall", languages: ["Sunway Carnival", "Paris Baguette", "sunway carnival mall"] }]);
    assert.deepEqual(record!.data.languages, ["Paris Baguette"]);
  });

  it("keeps records that only have a name, so list pages are not lost", () => {
    const records = normalizeRecords({ ...dataset, fields: dataset.fields.map((field) => ({ ...field, required: true })) }, [{ name: "Sunway Pyramid" }]);
    assert.deepEqual(records.map((record) => record.key), ["sunway-pyramid"]);
  });

  it("drops rows without a key and merges rows that share one", () => {
    const records = normalizeRecords(dataset, [
      { name: "Dr. Amy Tan", price: "150" },
      { name: "", price: 100 },
      { name: "dr amy tan", price: 160 },
    ]);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.key, "dr-amy-tan");
    assert.equal(records[0]!.data.price, 150, "within a page, the first mention wins single values");
  });

  it("slugifies accents and symbols", () => {
    assert.equal(slugify("Clínica Señor & Co."), "clinica-senor-and-co");
  });

  it("parses quoted CSV and maps headers by label", () => {
    const rows = parseCsv('Name,"Price (RM)",Languages\r\n"Tan, Amy",150,"English, Malay"\n\nBen Lim,,English\n');
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.Name, "Tan, Amy");
    const records = mapCsvRows(dataset, rows);
    assert.equal(records[0]!.data.price, 150);
    assert.deepEqual(records[0]!.data.languages, ["English", "Malay"]);
    assert.equal(records[1]!.data.price, null);
  });
});

describe("validateProposal", () => {
  it("repairs model output into engine invariants", () => {
    const proposal = validateProposal({
      businessSummary: "Mall hoarding contractor",
      conversionGoal: "WhatsApp enquiry",
      datasets: [{
        name: "Malls", entityType: "mall", description: "Malls served", keyField: "Mall Name",
        fields: [
          { key: "Mall Name", label: "Mall name", type: "text", required: false },
          { key: "state", label: "State", type: "nonsense" },
          { key: "state", label: "Duplicate", type: "text" },
        ],
        pageIdeas: [{ name: "Malls by state", groupBy: ["state", "missing"], exampleTitle: "", exampleQueries: [], intent: "", rationale: "" }],
        sources: [
          { url: "https://evil.example/ignored", kind: "own_site", urlPattern: "/malls/*", rationale: "own" },
          { url: "http://localhost/admin", kind: "listing", urlPattern: null, rationale: "bad" },
          { url: "https://www.malls.my/directory", kind: "listing", urlPattern: "/mall/*", rationale: "directory" },
        ],
      }],
    }, "https://edeadesign.com.my");
    const dataset = proposal.datasets[0]!;
    assert.deepEqual(dataset.fields.map((field) => [field.key, field.type]), [["mall_name", "text"], ["state", "text"]]);
    assert.equal(dataset.keyField, "mall_name");
    assert.equal(dataset.fields[0]!.required, true, "the key field is always required");
    assert.deepEqual(dataset.pageIdeas.map((idea) => idea.groupBy), [[], ["state"]], "an entity page idea is always present");
    assert.deepEqual(dataset.sources.map((source) => source.url), ["https://edeadesign.com.my", "https://www.malls.my/directory"]);
  });
});

describe("expandSource", () => {
  const site: Record<string, string> = {
    "https://shop.example/robots.txt": "User-agent: *\nDisallow: /products/secret\nSitemap: https://shop.example/sitemap-index.xml",
    "https://shop.example/sitemap-index.xml": "<sitemapindex><sitemap><loc>https://shop.example/sitemap-1.xml</loc></sitemap></sitemapindex>",
    "https://shop.example/sitemap-1.xml": `<urlset>
      <url><loc>https://shop.example/products/chair</loc></url>
      <url><loc>https://shop.example/products/table</loc></url>
      <url><loc>https://shop.example/products/secret</loc></url>
      <url><loc>https://shop.example/about</loc></url>
      <url><loc>https://elsewhere.example/products/x</loc></url>
    </urlset>`,
  };
  const fake: Fetcher = async (url) => ({
    url, finalUrl: url, headers: {}, status: site[url] ? 200 : 404, body: site[url] ?? "",
  });

  it("follows robots-declared sitemaps, filters by pattern, and respects robots.txt", async () => {
    const result = await expandSource(
      { url: "https://shop.example", kind: "own_site", urlPattern: "/products/*", maxPages: 100 },
      new PoliteFetcher(fake),
    );
    assert.deepEqual(result.urls, ["https://shop.example/products/chair", "https://shop.example/products/table"]);
    assert.equal(result.blocked, 1);
    assert.equal(result.matched, 3);
  });

  it("reads every page of a paginated list source", async () => {
    const pages: Record<string, string> = {
      "https://dir.example/robots.txt": "User-agent: *\nAllow: /",
      "https://dir.example/malls": `<ul><li>A</li></ul><a href="?page=1">2</a>`,
      "https://dir.example/malls?page=1": `<ul><li>B</li></ul><a href="?page=0">1</a><a href="?page=2">3</a>`,
      "https://dir.example/malls?page=2": `<ul><li>C</li></ul><a href="?page=1">2</a>`,
    };
    const listFetcher: Fetcher = async (url) => ({ url, finalUrl: url, headers: {}, status: pages[url] ? 200 : 404, body: pages[url] ?? "" });
    const result = await expandSource({ url: "https://dir.example/malls", kind: "page", maxPages: 25 }, new PoliteFetcher(listFetcher));
    assert.deepEqual(result.urls, ["https://dir.example/malls", "https://dir.example/malls?page=1", "https://dir.example/malls?page=2"]);
  });

  it("caps pages at the source budget", async () => {
    const result = await expandSource(
      { url: "https://shop.example", kind: "own_site", urlPattern: "/products/*", maxPages: 1 },
      new PoliteFetcher(fake),
    );
    assert.equal(result.urls.length, 1);
    assert.ok(result.notes.some((note) => note.includes("capped")));
  });

  it("refuses to fetch disallowed pages", async () => {
    await assert.rejects(new PoliteFetcher(fake).fetch("https://shop.example/products/secret"), /robots\.txt disallows/);
  });
});

/** A model stand-in that records each request and returns a canned answer. */
function stubLlm(answer: unknown): JsonLlm & { requests: JsonRequest[] } {
  const requests: JsonRequest[] = [];
  return {
    model: "stub",
    requests,
    async json<T>(request: JsonRequest): Promise<T> {
      requests.push(request);
      return answer as T;
    },
  };
}

describe("model-backed steps (stubbed model)", () => {
  const dataset = {
    name: "Malls", entityType: "mall", description: "Shopping malls", keyField: "name",
    fields: [
      { key: "name", label: "Name", type: "text" as const, required: true },
      { key: "stores", label: "Stores", type: "number" as const },
      { key: "services", label: "Services", type: "list" as const },
    ],
  };

  it("sends JSON-LD and cleaned text, then normalizes the model's records", async () => {
    const llm = stubLlm({
      sourceSummary: "A mall directory page.",
      records: [{ name: "Sunway Pyramid", stores: "1,000+", services: "Hoarding; Signage" }, { name: null, stores: 3 }],
    });
    const html = `<html><head><title>Malls</title><script type="application/ld+json">{"@type":"ShoppingCenter","name":"Sunway Pyramid"}</script></head>
      <body><main><h1>Malls in Selangor</h1><p>${"Sunway Pyramid is a large mall in Bandar Sunway with over a thousand stores. ".repeat(3)}</p></main><script>tracking()</script></body></html>`;
    const result = await extractRecordsFromHtml({ llm, dataset, url: "https://malls.example/selangor", html });
    assert.deepEqual(result.records, [{ key: "sunway-pyramid", data: { name: "Sunway Pyramid", stores: 1000, services: ["Hoarding", "Signage"] } }]);
    const sent = JSON.parse(llm.requests[0]!.user) as { page: { jsonLd: string; text: string } };
    assert.ok(sent.page.jsonLd.includes("ShoppingCenter"));
    assert.ok(sent.page.text.includes("# Malls in Selangor"));
    assert.ok(!sent.page.text.includes("tracking()"));
    assert.equal(llm.requests[0]!.effort, "low", "bulk extraction runs at low effort");
  });

  it("skips the model for pages with no readable content", async () => {
    const llm = stubLlm({ records: [] });
    const result = await extractRecordsFromHtml({ llm, dataset, url: "https://x.example/", html: "<html><body><div id=root></div></body></html>" });
    assert.equal(llm.requests.length, 0);
    assert.equal(result.records.length, 0);
  });

  it("validates a scoping proposal against the site", async () => {
    const llm = stubLlm({
      businessSummary: "Hoarding contractor for shopping malls.",
      conversionGoal: "WhatsApp enquiry",
      datasets: [{ name: "Malls", entityType: "mall", description: "", keyField: "name", fields: [{ key: "name", label: "Name", type: "text", description: "", required: true }, { key: "city", label: "City", type: "text", description: "", required: false }], pageIdeas: [], sources: [{ url: "", kind: "own_site", urlPattern: "/malls/*", rationale: "" }] }],
    });
    const proposal = await proposeScope(llm, { name: "Edea", baseUrl: "https://edeadesign.com.my", pages: [], routeGroups: [], topQueries: [] });
    assert.equal(proposal.datasets[0]!.sources[0]!.url, "https://edeadesign.com.my");
    assert.equal(proposal.datasets[0]!.pageIdeas[0]!.groupBy.length, 0);
    assert.equal(llm.requests[0]!.effort, "high", "strategy runs at high effort");
  });
});

describe("duplicate resolution", () => {
  const record = (id: string, name: string, data: Record<string, unknown> = {}) =>
    ({ id, siteId: "s", datasetId: "d", key: id, data: { name, ...data }, createdAt: "", updatedAt: "" }) as never;
  const dataset = { name: "Malls", entityType: "shopping mall", keyField: "name" };

  it("accepts only groups of existing names, each name in one group", async () => {
    const llm = stubLlm({ groups: [
      { canonical: "Gurney Paragon Mall", members: ["Gurney Paragon", "Gurney Paragon Mall", "Gurney Paragon Mall Penang"] },
      { canonical: "Invented Mall", members: ["Invented Mall", "Nowhere Plaza"] },
      { canonical: "Gurney Paragon", members: ["Gurney Paragon", "Sunway Pyramid"] },
    ] });
    const clusters = await findDuplicateRecords({ llm, dataset, records: [
      record("a", "Gurney Paragon"), record("b", "Gurney Paragon Mall"), record("c", "Gurney Paragon Mall Penang"), record("d", "Sunway Pyramid"),
    ] });
    assert.deepEqual(clusters, [{ canonicalId: "b", duplicateIds: ["a", "c"], names: ["Gurney Paragon", "Gurney Paragon Mall", "Gurney Paragon Mall Penang"] }]);
  });

  it("never lets an empty value erase a known one", () => {
    const fields = [{ key: "name", label: "Name", type: "text" as const }, { key: "city", label: "City", type: "text" as const }, { key: "clients", label: "Clients", type: "list" as const }];
    const merged = mergeRecordData(fields, { name: "Gurney Paragon Mall", city: null, clients: ["Guardian"] }, [{ name: "Gurney Paragon Mall", city: "George Town", clients: ["Hanam BBQ"] }]);
    assert.deepEqual(merged, { name: "Gurney Paragon Mall", city: "George Town", clients: ["Guardian", "Hanam BBQ"] });
  });

  it("keeps canonical values, fills gaps, and unions lists", () => {
    const fields = [
      { key: "name", label: "Name", type: "text" as const },
      { key: "city", label: "City", type: "text" as const },
      { key: "clients", label: "Clients", type: "list" as const },
    ];
    const merged = mergeRecordData(fields, { name: "1st Avenue", city: null, clients: ["Hanzo"] }, [
      { name: "1st Avenue Mall Penang", city: "George Town", clients: ["Pepper Lunch", "hanzo"] },
    ]);
    assert.deepEqual(merged, { name: "1st Avenue", city: "George Town", clients: ["Hanzo", "Pepper Lunch"] });
  });
});

describe("htmlToText on large malformed pages", () => {
  it("handles lists and tables without end tags in linear time", () => {
    const html = `<html><body><main><h1>Malls</h1><ul>${"<li>Gurney Plaza, Penang ".repeat(20_000)}</ul><table>${"<tr><td>Mall<td>Penang ".repeat(5_000)}</table></main></body></html>`;
    const started = performance.now();
    const text = htmlToText(html, 1_000_000);
    assert.ok(performance.now() - started < 1500, `took ${Math.round(performance.now() - started)} ms`);
    assert.ok(text.startsWith("# Malls\n- Gurney Plaza, Penang\n- Gurney Plaza, Penang"), text.slice(0, 80));
    assert.ok(text.includes("| Mall | Penang |"), "table rows keep their shape without end tags");
  });
});
