import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DataRecord, Dataset, GeneratedPage, PageSettings, PageTemplate } from "@organic-growth/core";
import { chooseArm, probabilityBest } from "./bandit.js";
import { generatePages, normalizeMountPath } from "./generate.js";
import { buildPerformanceReport, expectedCtr, type PagePerformance } from "./insights.js";
import { fillPattern, fillProse } from "./patterns.js";
import { renderLandingPage, renderSitemap } from "./render.js";
import { defaultTemplate, unknownPlaceholders } from "./templates.js";

/** Deterministic PRNG so probabilistic tests are stable. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dataset: Pick<Dataset, "name" | "entityType" | "fields" | "keyField"> = {
  name: "Doctors",
  entityType: "doctor",
  keyField: "name",
  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "specialty", label: "Specialty", type: "list" },
    { key: "city", label: "City", type: "text" },
    { key: "hospital", label: "Hospital", type: "text" },
    { key: "consultation_fee", label: "Consultation fee (RM)", type: "number" },
    { key: "languages", label: "Languages", type: "list" },
    { key: "bio", label: "About", type: "text" },
  ],
};

let counter = 0;
function record(key: string, data: DataRecord["data"]): DataRecord {
  return { id: `rec_${++counter}`, siteId: "site_1", datasetId: "ds_1", key, data, createdAt: "", updatedAt: "" };
}

function template(overrides: Partial<PageTemplate>): PageTemplate {
  return {
    id: "tpl_1", siteId: "site_1", datasetId: "ds_1", name: "Doctor pages", groupBy: [],
    pathPattern: "/guides/doctors/{name}", titlePattern: "{name}, {specialty} in {city} | {site}",
    descriptionPattern: "Book {name} at {hospital}.", h1Pattern: "{name}",
    introPattern: "{name} is a {specialty} specialist in {city}. Consultations start at RM {consultation_fee}.",
    itemTitleField: "name", itemFields: ["specialty", "city", "hospital", "consultation_fee", "languages", "bio"],
    sortDir: "asc", minRecords: 1, faq: [{ question: "Where does {name} practise?", answer: "{name} practises at {hospital}." }],
    status: "draft", createdAt: "", updatedAt: "",
    ...overrides,
  };
}

const bio = "Dr Tan has over fifteen years of experience in interventional cardiology, with a focus on minimally invasive procedures and preventive heart care for international patients.";

const records = [
  record("dr-amy-tan", { name: "Dr Amy Tan", specialty: ["Cardiology"], city: "Kuala Lumpur", hospital: "Pantai Hospital", consultation_fee: 150, languages: ["English", "Malay"], bio }),
  record("dr-ben-lim", { name: "Dr Ben Lim", specialty: ["Cardiology", "Internal Medicine"], city: "Kuala Lumpur", hospital: "Gleneagles", consultation_fee: 200, languages: ["English"], bio }),
  record("dr-cara-ng", { name: "Dr Cara Ng", specialty: ["Cardiology"], city: "Kuala Lumpur", hospital: "Sunway Medical", consultation_fee: 120, languages: ["English", "Mandarin"], bio }),
  record("dr-dan-ho", { name: "Dr Dan Ho", specialty: ["Orthopaedics"], city: "Penang", hospital: null, consultation_fee: null, languages: null, bio: null }),
];

describe("patterns", () => {
  it("reports unresolved placeholders", () => {
    const result = fillPattern("{name} in {city}", (token) => (token === "name" ? "Dr Amy" : ""));
    assert.equal(result.text, "Dr Amy in");
    assert.deepEqual(result.missing, ["city"]);
  });

  it("drops only the sentences whose placeholders are empty", () => {
    const text = fillProse("{name} is a doctor. Fees start at RM {fee}. Book today.", (token) => (token === "name" ? "Dr Amy" : ""));
    assert.equal(text, "Dr Amy is a doctor. Book today.");
  });
});

describe("generatePages (entity templates)", () => {
  const pages = generatePages({ siteId: "site_1", siteName: "MedBay", template: template({}), dataset, records, mountPath: "/guides" });

  it("creates one landing page per record with stable, slugged paths", () => {
    assert.equal(pages.length, 4);
    assert.equal(pages[0]!.path, "/guides/doctors/dr-amy-tan");
    assert.equal(pages[0]!.title, "Dr Amy Tan, Cardiology in Kuala Lumpur | MedBay");
    assert.equal(pages[0]!.intro, "Dr Amy Tan is a Cardiology specialist in Kuala Lumpur. Consultations start at RM 150.");
    assert.equal(pages[0]!.faq[0]!.answer, "Dr Amy Tan practises at Pantai Hospital.");
  });

  it("marks records without enough facts as thin instead of publishing them", () => {
    const sparse = pages.find((page) => page.path.endsWith("dr-dan-ho"))!;
    assert.equal(sparse.status, "thin");
    assert.equal(sparse.qualityScore, 0);
    assert.ok(sparse.qualityIssues.some((issue) => issue.includes("page fields have data")));
    assert.equal(sparse.faq.length, 0, "FAQ entries with missing facts are dropped");
  });

  it("links related pages that share attributes", () => {
    const amy = pages[0]!;
    assert.ok(amy.related.some((link) => link.path === "/guides/doctors/dr-ben-lim"));
    assert.ok(!amy.related.some((link) => link.path.endsWith("dr-dan-ho")), "thin pages are never linked");
  });

  it("links field values to other entities' pages", () => {
    const linked = generatePages({
      siteId: "site_1", siteName: "MedBay", template: template({}), dataset, records, mountPath: "/guides",
      entityLinks: new Map([["pantai-hospital", { path: "/guides/hospitals/pantai-hospital", title: "Pantai Hospital" }]]),
    });
    const hospital = linked[0]!.items[0]!.fields.find((field) => field.label === "Hospital");
    assert.equal(hospital?.href, "/guides/hospitals/pantai-hospital");
  });

  it("de-duplicates colliding paths", () => {
    const twins = generatePages({
      siteId: "site_1", siteName: "MedBay", template: template({}), dataset, mountPath: "/guides",
      records: [records[0]!, { ...records[0]!, id: "rec_twin", key: "dr-amy-tan-2" }],
    });
    assert.deepEqual(twins.map((page) => page.path), ["/guides/doctors/dr-amy-tan", "/guides/doctors/dr-amy-tan-2"]);
  });
});

describe("generatePages (URL stability)", () => {
  it("keeps live URLs when the pattern changes, and links related pages to those URLs", () => {
    const stablePaths = new Map([["dr-amy-tan", "/guides/doctors/dr-amy-tan"], ["dr-ben-lim", "/guides/doctors/dr-ben-lim"]]);
    const pages = generatePages({
      siteId: "site_1", siteName: "MedBay", template: template({ pathPattern: "/guides/specialists/{name}" }),
      dataset, records, mountPath: "/guides", stablePaths,
    });
    const amy = pages.find((page) => page.groupKey === "dr-amy-tan")!;
    const cara = pages.find((page) => page.groupKey === "dr-cara-ng")!;
    assert.equal(amy.path, "/guides/doctors/dr-amy-tan");
    assert.equal(cara.path, "/guides/specialists/dr-cara-ng", "new pages follow the new pattern");
    assert.ok(cara.related.some((link) => link.path === "/guides/doctors/dr-amy-tan"), "related links use the live URL");
  });
});

describe("generatePages (grouped templates)", () => {
  const grouped = template({
    id: "tpl_2", name: "Specialty by city", groupBy: ["specialty", "city"], minRecords: 2,
    pathPattern: "/guides/{specialty}-doctors-in-{city}", titlePattern: "{count} {specialty} doctors in {city}",
    h1Pattern: "{specialty} doctors in {city}", introPattern: "Fees range from RM {min:consultation_fee} to RM {max:consultation_fee}.",
    sortBy: "consultation_fee", faq: [],
  });
  const pages = generatePages({ siteId: "site_1", siteName: "MedBay", template: grouped, dataset, records, mountPath: "/guides" });

  it("fans list fields out into every group they belong to", () => {
    const cardiology = pages.find((page) => page.path === "/guides/cardiology-doctors-in-kuala-lumpur")!;
    assert.equal(cardiology.recordIds.length, 3);
    assert.equal(cardiology.title, "3 Cardiology doctors in Kuala Lumpur");
    assert.equal(cardiology.intro, "Fees range from RM 120 to RM 200.");
    assert.deepEqual(cardiology.items.map((item) => item.title), ["Dr Cara Ng", "Dr Amy Tan", "Dr Ben Lim"], "sorted by fee ascending");
    assert.equal(cardiology.status, "draft");
  });

  it("holds back groups below the minimum record count", () => {
    const internal = pages.find((page) => page.path === "/guides/internal-medicine-doctors-in-kuala-lumpur")!;
    assert.equal(internal.status, "thin");
  });
});

describe("normalizeMountPath", () => {
  it("normalizes subdirectories and the root", () => {
    assert.equal(normalizeMountPath("guides/"), "/guides");
    assert.equal(normalizeMountPath("/"), "");
    assert.equal(normalizeMountPath(""), "");
  });
});

describe("templates", () => {
  it("flags placeholders that reference unknown fields", () => {
    assert.deepEqual(unknownPlaceholders("{name} {count} {min:consultation_fee} {rating} {max:rating}", dataset), ["rating", "max:rating"]);
  });

  it("builds a usable default entity template", () => {
    const draft = defaultTemplate(dataset, { name: "", groupBy: [] }, "/guides");
    assert.equal(draft.pathPattern, "/guides/doctors/{name}");
    assert.equal(unknownPlaceholders(draft.titlePattern + draft.introPattern, dataset).length, 0);
  });

  it("lets well-filled records pass the quality gate with data-only copy", () => {
    const draft = defaultTemplate(dataset, { name: "", groupBy: [] }, "/guides");
    const pages = generatePages({
      siteId: "site_1", siteName: "MedBay", dataset, records, mountPath: "/guides",
      template: { ...draft, id: "tpl_default", siteId: "site_1", datasetId: "ds_1", status: "draft", createdAt: "", updatedAt: "" },
    });
    assert.equal(pages.find((page) => page.groupKey === "dr-amy-tan")?.status, "draft");
    assert.equal(pages.find((page) => page.groupKey === "dr-dan-ho")?.status, "thin");
  });
});

describe("renderLandingPage", () => {
  const settings: PageSettings = {
    siteId: "site_1", publicOrigin: "https://medbaycare.com", mountPath: "/guides", siteName: "MedBay",
    brandColor: "#0a7", ctaLabel: "WhatsApp us", ctaUrl: "https://wa.me/60123456789", ctaCopy: "Free consultation.", updatedAt: "",
  };
  const [page] = generatePages({ siteId: "site_1", siteName: "MedBay", template: template({}), dataset, records, mountPath: "/guides" });
  const hostile: GeneratedPage = { ...page!, h1: "<img src=x onerror=alert(1)>", faq: [{ question: "Q", answer: "</script><script>alert(1)</script>" }] };
  const html = renderLandingPage(hostile, {
    settings, cta: { variantId: "var_1", label: "WhatsApp us", copy: "Free consultation.", url: settings.ctaUrl },
    beaconPath: "/guides/__eumon/e", indexable: true, entityType: "doctor",
  });

  it("serves the canonical URL on the customer domain", () => {
    assert.ok(html.includes('<link rel="canonical" href="https://medbaycare.com/guides/doctors/dr-amy-tan">'));
    assert.ok(html.includes('content="index, follow'));
  });

  it("escapes content in HTML and in JSON-LD", () => {
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
    assert.equal(html.match(/<\/script>/g)?.length, 2, "only the JSON-LD and beacon scripts close");
  });

  it("puts the CTA above the fold, after the content, and in a sticky bar", () => {
    const placements = [...html.matchAll(/data-eumon-cta="([a-z-]+)"/g)].map((match) => match[1]);
    assert.deepEqual(placements, ["header", "hero", "footer-band", "sticky"]);
    assert.ok(html.includes('rel="nofollow noopener"'), "external CTA links are nofollow");
  });

  it("marks drafts as noindex", () => {
    const draft = renderLandingPage(page!, { settings, cta: { label: "Go", copy: "", url: "/" }, beaconPath: "/e", indexable: false });
    assert.ok(draft.includes('content="noindex, nofollow"'));
  });

  it("lists pages in the sitemap with absolute URLs", () => {
    const xml = renderSitemap(settings, [{ path: "/guides/doctors/dr-amy-tan", updatedAt: "2026-10-01T00:00:00Z" }]);
    assert.ok(xml.includes("<loc>https://medbaycare.com/guides</loc>"));
    assert.ok(xml.includes("<loc>https://medbaycare.com/guides/doctors/dr-amy-tan</loc><lastmod>2026-10-01</lastmod>"));
  });
});

describe("bandit", () => {
  it("routes most traffic to the clearly better arm", () => {
    const random = seeded(42);
    const arms = [
      { id: "a", impressions: 1000, clicks: 20 },
      { id: "b", impressions: 1000, clicks: 60 },
    ];
    let b = 0;
    for (let i = 0; i < 500; i++) if (chooseArm(arms, random)?.id === "b") b++;
    assert.ok(b > 480, `expected the stronger arm to dominate, got ${b}/500`);
  });

  it("keeps exploring arms with little data", () => {
    const random = seeded(7);
    const arms = [{ id: "old", impressions: 300, clicks: 9 }, { id: "new", impressions: 0, clicks: 0 }];
    let fresh = 0;
    for (let i = 0; i < 500; i++) if (chooseArm(arms, random)?.id === "new") fresh++;
    assert.ok(fresh > 25 && fresh < 475, `expected exploration, got ${fresh}/500`);
  });

  it("estimates the probability that an arm is best", () => {
    const odds = probabilityBest([{ id: "a", impressions: 2000, clicks: 40 }, { id: "b", impressions: 2000, clicks: 100 }], 2000, seeded(3));
    assert.ok((odds.get("b") ?? 0) > 0.99);
  });
});

describe("buildPerformanceReport", () => {
  const base: PagePerformance = {
    pageId: "p1", templateId: "tpl_1", path: "/guides/doctors/dr-amy-tan", title: "Dr Amy Tan | MedBay",
    publishedAt: "2026-06-01T00:00:00Z", views: 0, ctaClicks: 0, conversions: 0,
    googlebotHits: 3, clicks: 2, impressions: 900, position: 3.2,
  };

  it("flags pages whose click-through rate trails their ranking", () => {
    const report = buildPerformanceReport({
      pages: [base], templates: [{ id: "tpl_1", name: "Doctor pages" }], publicOrigin: "https://medbaycare.com",
      queries: [{ pageUrl: "https://medbaycare.com/guides/doctors/dr-amy-tan", query: "dr amy tan cardiologist", clicks: 2, impressions: 900, position: 3.2 }],
      now: new Date("2026-10-01T00:00:00Z"),
    });
    const suggestion = report.suggestions.find((entry) => entry.kind === "rewrite_snippet");
    assert.ok(suggestion);
    assert.deepEqual(suggestion.queries, ["dr amy tan cardiologist"]);
    assert.ok(suggestion.impact > 50);
  });

  it("finds near-miss queries missing from the title", () => {
    const report = buildPerformanceReport({
      pages: [{ ...base, impressions: 40, clicks: 1, position: 12 }], templates: [{ id: "tpl_1", name: "Doctor pages" }],
      publicOrigin: "https://medbaycare.com",
      queries: [{ pageUrl: "https://medbaycare.com/guides/doctors/dr-amy-tan", query: "heart specialist kuala lumpur", clicks: 0, impressions: 120, position: 11 }],
      now: new Date("2026-10-01T00:00:00Z"),
    });
    assert.ok(report.suggestions.some((entry) => entry.kind === "target_queries" && entry.queries?.[0] === "heart specialist kuala lumpur"));
  });

  it("detects published pages Googlebot has never fetched", () => {
    const pages = Array.from({ length: 5 }, (_, index) => ({ ...base, pageId: `p${index}`, path: `/guides/x${index}`, googlebotHits: 0, impressions: 0, clicks: 0 }));
    const report = buildPerformanceReport({ pages, templates: [{ id: "tpl_1", name: "Doctor pages" }], publicOrigin: "https://medbaycare.com", queries: [], now: new Date("2026-10-01T00:00:00Z") });
    assert.ok(report.suggestions.some((entry) => entry.kind === "not_crawled"));
  });

  it("uses a monotonic expected-CTR curve", () => {
    assert.ok(expectedCtr(1) > expectedCtr(3) && expectedCtr(3) > expectedCtr(9) && expectedCtr(9) > expectedCtr(15));
  });
});
