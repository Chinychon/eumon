import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gradeContent, normaliseHeading, type GradedPage } from "./content-grade.js";

const page = (over: Partial<GradedPage> = {}): GradedPage => ({ url: "https://me.com/p", headings: [], mainText: "", words: 1000, listsOrTables: false, questionHeadings: 0, faq: false, ...over });
const rival = (domain: string, over: Partial<GradedPage> = {}) => ({ ...page({ url: `https://${domain}/p`, ...over }), domain });

describe("normaliseHeading", () => {
  it("generic headings are dropped", () => {
    for (const text of ["Contact us", "Related posts", "Share this", "Table of contents", "FAQ", "Hubungi kami", "Artikel berkaitan"]) assert.deepEqual(normaliseHeading(text), [], text);
  });

  it("stop words and digits go", () => {
    assert.deepEqual(normaliseHeading("The 5 best ways to recover after LASIK"), ["best", "ways", "recover", "lasik"]);
    const ms = normaliseHeading("Cara terbaik untuk pulih selepas rawatan");
    assert.ok(!ms.includes("untuk") && !ms.includes("selepas"));
    assert.deepEqual(ms, ["cara", "terbaik", "pulih", "rawatan"]);
  });

  it("keeps letters with diacritics", () => {
    assert.deepEqual(normaliseHeading("Café résumé tips"), ["café", "résumé", "tips"]);
  });
});

describe("gradeContent topics", () => {
  it("headings on different pages are one topic at Jaccard >= 0.5", () => {
    const same = gradeContent({ page: page(), competitors: [rival("a.com", { headings: ["Recovery time after LASIK"] }), rival("b.com", { headings: ["LASIK recovery time"] })] });
    assert.equal(same.topics.length, 1);
    assert.deepEqual(same.topics[0].coveredBy, ["a.com", "b.com"]);
    const two = gradeContent({ page: page(), competitors: [rival("a.com", { headings: ["LASIK cost", "Recovery time"] }), rival("b.com", { headings: ["LASIK cost", "Recovery time"] })] });
    assert.equal(two.topics.length, 2);
  });

  it("a topic counts only when two competitors cover it", () => {
    const three = gradeContent({ page: page(), competitors: [rival("a.com", { headings: ["Celebrity patients", "LASIK cost"] }), rival("b.com", { headings: ["LASIK cost"] }), rival("c.com", { headings: ["Other things"] })] });
    assert.deepEqual(three.topics.map((t) => t.label), ["LASIK cost"]);
    const two = gradeContent({ page: page(), competitors: [rival("a.com", { headings: ["Celebrity patients", "LASIK cost"] }), rival("b.com", { headings: ["LASIK cost"] })] });
    assert.deepEqual(two.topics.map((t) => t.label), ["LASIK cost"]);
  });

  it("covered by heading or by text", () => {
    const competitors = [rival("a.com", { headings: ["LASIK risks"] }), rival("b.com", { headings: ["Risks of LASIK"] })];
    assert.equal(gradeContent({ page: page(), competitors }).topics[0].covered, false);
    assert.equal(gradeContent({ page: page({ headings: ["LASIK risks explained"] }), competitors }).topics[0].covered, true);
    const byText = gradeContent({ page: page({ mainText: "Here the risks of LASIK include dry eyes." }), competitors });
    assert.equal(byText.topics[0].covered, true);
    assert.deepEqual(byText.missing, []);
  });

  it("no common topics means coverage 1", () => {
    const g = gradeContent({ page: page(), competitors: [rival("a.com", { headings: ["Alpha thing"] }), rival("b.com", { headings: ["Beta other"] })] });
    assert.equal(g.topics.length, 0);
    assert.equal(g.score, 100);
  });

  it("missing is ordered by how many competitors cover the topic, capped at 8", () => {
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
    // "alpha" is covered by 3 competitors, the rest by 2
    const competitors = [rival("a.com", { headings: words.map((w) => `${w} guide`) }), rival("b.com", { headings: words.map((w) => `${w} guide`) }), rival("c.com", { headings: ["alpha guide"] })];
    const g = gradeContent({ page: page(), competitors });
    assert.equal(g.topics.length, 10);
    assert.equal(g.missing.length, 8);
    assert.equal(g.missing[0], "alpha guide");
    assert.equal(g.covered, 0);
  });

  it("Malay headings", () => {
    const g = gradeContent({ page: page({ mainText: "kos pembedahan lasik ialah antara RM3000 hingga RM6000" }), competitors: [rival("a.my", { headings: ["Kos pembedahan LASIK"] }), rival("b.my", { headings: ["Kos LASIK di Malaysia"] })] });
    assert.equal(g.topics.length, 1);
    assert.equal(g.topics[0].covered, true);
    assert.equal(g.topics[0].label, "Kos pembedahan LASIK");
  });
});

describe("gradeContent score", () => {
  const heads = ["alpha topic", "bravo topic", "charlie topic", "delta topic"];
  const comps = (over: Partial<GradedPage> = {}) => [rival("a.com", { headings: heads, ...over }), rival("b.com", { headings: heads, ...over })];

  it("full coverage, equal length, same structure is 100 and A", () => {
    const g = gradeContent({ page: page({ headings: heads, listsOrTables: true }), competitors: comps({ listsOrTables: true }) });
    assert.equal(g.score, 100);
    assert.equal(g.grade, "A");
  });

  it("nothing covered, half length, missing lists is 7.5 and F", () => {
    const g = gradeContent({ page: page({ words: 500 }), competitors: comps({ listsOrTables: true }) });
    assert.equal(g.score, 7.5);
    assert.equal(g.grade, "F");
    assert.equal(g.medianWords, 1000);
    assert.equal(g.ownWords, 500);
    assert.deepEqual(g.structure.find((s: { feature: string }) => s.feature === "lists"), { feature: "lists", competitors: true, page: false });
  });

  it("cut-offs", () => {
    const at = (covered: number) => gradeContent({ page: page({ headings: heads.slice(0, covered) }), competitors: comps() });
    // coverage only: 70 * covered/4 + 30
    assert.deepEqual([at(4).score, at(4).grade], [100, "A"]);
    assert.deepEqual([at(3).score, at(3).grade], [82.5, "B"]);
    assert.deepEqual([at(2).score, at(2).grade], [65, "C"]);
    assert.deepEqual([at(1).score, at(1).grade], [47.5, "D"]);
    assert.deepEqual([at(0).score, at(0).grade], [30, "F"]);
  });

  it("no competitors: nothing to compare, length ratio 1", () => {
    const g = gradeContent({ page: page(), competitors: [] });
    assert.equal(g.medianWords, 0);
    assert.equal(g.score, 100);
  });
});
