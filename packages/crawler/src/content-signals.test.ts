import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentSignals, countQuotes, countStatistics, isQuestionHeading, parseModified } from "./content-signals.js";

describe("content signals", () => {
  it("detects question headings in four languages", () => {
    for (const heading of ["How much do braces cost?", "Berapa kos pendakap gigi", "Apa itu implan", "如何选择牙医", "Why choose us", "费用是多少？"]) assert.ok(isQuestionHeading(heading), heading);
    for (const heading of ["Our clinics", "Isabel's story", "Dokter gigi"]) assert.ok(!isQuestionHeading(heading), heading);
  });

  it("counts statistics with a currency before or a unit after the number", () => {
    assert.equal(countStatistics("Braces cost RM 4,500 and take 18 months; 72% of patients finish early."), 3);
    assert.equal(countStatistics("Call 03-1234 5678 or visit room 12."), 0);
  });

  it("counts blockquotes and long quoted passages", () => {
    assert.equal(countQuotes("<blockquote>x</blockquote> She said “this is the best clinic I have been to in years”."), 2);
    assert.equal(countQuotes("A “short” word."), 0);
  });

  it("reads the modified date from JSON-LD, then meta, then <time>", () => {
    assert.equal(parseModified({ jsonLd: [{ "@type": "Article", dateModified: "2026-03-01" }], metas: {}, html: "" }), "2026-03-01");
    assert.equal(parseModified({ jsonLd: [], metas: { "article:published_time": "2025-01-02T00:00:00Z" }, html: "" }), "2025-01-02");
    assert.equal(parseModified({ jsonLd: [], metas: {}, html: '<main><time datetime="2024-06-07">7 June</time></main>' }), "2024-06-07");
    assert.equal(parseModified({ jsonLd: [{ dateModified: "not a date" }], metas: {}, html: "" }), undefined);
  });

  it("summarises a page", () => {
    const html = `<html lang="ms"><head><meta name="viewport" content="width=device-width"><meta name="robots" content="max-snippet:0"><meta name="author" content="Dr A"></head>
      <body><header></header><main><article><h1>Braces</h1><p>${"word ".repeat(30)}</p><h2>How long do braces take?</h2><ul><li>a</li><li>b</li><li>c</li></ul><h4>skip</h4>
      <img src="http://cdn.example/a.jpg"><img src="/b.jpg" alt=""><a href="https://who.int/x">WHO</a><a href="https://facebook.com/x">fb</a><a href="http://site.example/old">old</a></article></main></body></html>`;
    const s = contentSignals(html, "https://site.example/blog/braces-2024", { jsonLdTypes: ["BlogPosting"], jsonLd: [{ "@type": "BlogPosting", author: { name: "Dr A" } }] });
    assert.equal(s.lang, "ms");
    assert.equal(s.viewport, true);
    assert.equal(s.snippetBlocked, true);
    assert.equal(s.author, true);
    assert.equal(s.images, 2);
    assert.equal(s.imagesNoAlt, 1, "an empty alt is decorative");
    assert.equal(s.mixedContent, 1);
    assert.equal(s.httpLinks, 1);
    assert.equal(s.externalLinks, 1, "social hosts are not citations");
    assert.equal(s.h1, "Braces");
    assert.equal(s.questionHeadings, 1);
    assert.equal(s.listsOrTables, true);
    assert.equal(s.leadWords, 30);
    assert.equal(s.headingSkips, true);
    assert.equal(s.landmarks, 3);
    assert.equal(s.articleLike, true);
    assert.ok(s.words > 30);
    assert.equal(s.entitySchema, false);
  });

  it("finds an organisation with sameAs, and no author or date on a plain page", () => {
    const s = contentSignals("<html><body><p>Hello</p></body></html>", "https://site.example/", { jsonLdTypes: ["Dentist"], jsonLd: [{ "@type": "Dentist", name: "X", sameAs: ["https://facebook.com/x"] }] });
    assert.equal(s.entitySchema, true);
    assert.equal(s.author, false);
    assert.equal(s.articleLike, false);
    assert.equal(s.modified, undefined);
    assert.equal(s.lang, undefined);
    assert.equal(s.viewport, false);
  });
});
