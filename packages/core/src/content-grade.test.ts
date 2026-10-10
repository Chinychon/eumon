import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gradeContent, normaliseHeading, type GradedPage } from "./content-grade.js";

const page = (over: Partial<GradedPage> = {}): GradedPage => ({ url: "https://me.com/p", headings: [], mainText: "", words: 1000, listsOrTables: false, questionHeadings: 0, faq: false, ...over });
const rival = (domain: string, over: Partial<GradedPage> = {}) => ({ ...page({ url: `https://${domain}/p`, ...over }), domain });
// Three unrelated filler topics so the grader has the minimum number of topics to grade.
const FILLER = ["Alpha guide", "Bravo guide", "Charlie guide"];
const pair = (headings: string[], over: Partial<GradedPage> = {}) => [rival("a.com", { headings: [...headings, ...FILLER], ...over }), rival("b.com", { headings: [...headings, ...FILLER], ...over })];
const grade = (input: { page?: GradedPage; competitors: ReturnType<typeof pair>; query?: string }) => {
  const g = gradeContent({ page: input.page ?? page(), competitors: input.competitors, query: input.query ?? "" });
  assert.ok(g);
  return g;
};

describe("normaliseHeading", () => {
  it("generic headings are dropped", () => {
    for (const text of ["Contact us", "Related posts", "Share this", "Table of contents", "FAQ", "Hubungi kami", "Artikel berkaitan", "Overview", "Conclusion", "Kesimpulan", "Rujukan"]) assert.deepEqual(normaliseHeading(text), [], text);
  });

  it("stop words and digits go", () => {
    assert.deepEqual(normaliseHeading("The 5 best ways to recover after LASIK"), ["best", "way", "recov", "lasik"]);
    const ms = normaliseHeading("Cara terbaik untuk pulih selepas rawatan");
    assert.deepEqual(ms, ["cara", "terba", "pulih", "rawat"]);
  });

  it("keeps letters with diacritics", () => {
    assert.deepEqual(normaliseHeading("Café résumé tips"), ["café", "résum", "tip"]);
  });

  it("one-word headings are kept", () => {
    for (const text of ["Recovery", "Risks", "Kos", "Pemulihan", "Risiko"]) assert.equal(normaliseHeading(text).length, 1, text);
  });

  it("possessives and contractions leave no junk", () => {
    assert.deepEqual(normaliseHeading("Dan's clinic"), ["clini"]);
    assert.deepEqual(normaliseHeading("LASIK do's and don'ts"), ["lasik"]);
  });

  it("strips the query's tokens", () => {
    assert.deepEqual(normaliseHeading("LASIK eye surgery cost", new Set(["lasik", "eye", "surge"])), ["cost"]);
  });
});

describe("gradeContent topics", () => {
  it("headings on different pages are one topic at Jaccard >= 0.5", () => {
    const same = grade({ competitors: [rival("a.com", { headings: ["Recovery time after LASIK", ...FILLER] }), rival("b.com", { headings: ["LASIK recovery time", ...FILLER] })] });
    assert.equal(same.topics.length, 4);
    assert.deepEqual(same.topics[0].coveredBy, ["a.com", "b.com"]);
    const two = grade({ competitors: pair(["LASIK cost", "Recovery time"]) });
    assert.equal(two.topics.length, 5);
  });

  it("a topic counts only when two competitors cover it", () => {
    const three = grade({ competitors: [rival("a.com", { headings: ["Celebrity patients", "LASIK cost", ...FILLER] }), rival("b.com", { headings: ["LASIK cost", ...FILLER] }), rival("c.com", { headings: ["Other things", ...FILLER] })] });
    assert.ok(three.topics.some((t) => t.label === "LASIK cost"));
    assert.ok(!three.topics.some((t) => t.label === "Celebrity patients"));
    const two = grade({ competitors: [rival("a.com", { headings: ["Celebrity patients", "LASIK cost", ...FILLER] }), rival("b.com", { headings: ["LASIK cost", ...FILLER] })] });
    assert.ok(!two.topics.some((t) => t.label === "Celebrity patients"));
  });

  it("covered by heading or by text", () => {
    const competitors = pair(["LASIK risks"]);
    const topic = (g: ReturnType<typeof grade>) => g.topics.find((t) => t.label === "LASIK risks")!;
    assert.equal(topic(grade({ competitors })).covered, false);
    assert.equal(topic(grade({ competitors, page: page({ headings: ["LASIK risks explained"] }) })).covered, true);
    const byText = grade({ competitors, page: page({ mainText: "Here the risks of LASIK include dry eyes." }) });
    assert.equal(topic(byText).covered, true);
    assert.ok(!byText.missing.includes("LASIK risks"));
  });

  it("fewer than 3 topics returns null", () => {
    const competitors = [rival("a.com", { headings: ["Alpha guide", "Bravo guide"] }), rival("b.com", { headings: ["Alpha guide", "Bravo guide"] })];
    assert.equal(gradeContent({ page: page(), competitors, query: "" }), null);
    assert.equal(gradeContent({ page: page(), competitors: [], query: "" }), null);
  });

  it("missing is ordered by how many competitors cover the topic, capped at 8", () => {
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
    const all = words.map((w) => `${w} guide`);
    const g = grade({ competitors: [rival("a.com", { headings: all }), rival("b.com", { headings: all }), rival("c.com", { headings: ["hotel guide"] })] });
    assert.equal(g.topics.length, 10);
    assert.equal(g.missing.length, 8);
    assert.equal(g.missing[0], "hotel guide");
    assert.equal(g.covered, 0);
  });

  it("the query's own words do not merge topics", () => {
    const g = grade({ query: "lasik eye surgery", competitors: pair(["LASIK eye surgery cost", "LASIK eye surgery recovery"]) });
    assert.equal(g.topics.length, 5);
    assert.ok(g.topics.some((t) => t.label === "LASIK eye surgery cost"));
    assert.ok(g.topics.some((t) => t.label === "LASIK eye surgery recovery"));
  });

  it("a heading that is only the query is dropped", () => {
    const g = grade({ query: "lasik eye surgery", competitors: pair(["LASIK eye surgery"]) });
    assert.equal(g.topics.length, 3);
  });

  it("rephrased headings are one topic", () => {
    const g = grade({ query: "lasik", competitors: [rival("a.com", { headings: ["What affects the price of LASIK", ...FILLER] }), rival("b.com", { headings: ["Factors that affect LASIK price", ...FILLER] })] });
    assert.equal(g.topics.length, 4);
    assert.deepEqual(g.topics[0].coveredBy, ["a.com", "b.com"]);
  });

  it("a long page without the word is missing the topic", () => {
    const long = "LASIK is a popular procedure. ".repeat(200);
    const g = grade({ query: "lasik eye surgery", competitors: pair(["LASIK eye surgery risks"]), page: page({ mainText: long, words: 1200 }) });
    assert.ok(g.missing.includes("LASIK eye surgery risks"));
  });

  it("text covers a topic only within one sentence", () => {
    const competitors = pair(["Is LASIK covered by insurance?"]);
    const missing = (mainText: string) => grade({ query: "lasik", competitors, page: page({ mainText }) }).missing;
    assert.ok(missing("We have covered the basics. Bring your insurance card.").includes("Is LASIK covered by insurance?"));
    assert.ok(!missing("Your insurance may cover LASIK.").includes("Is LASIK covered by insurance?"));
  });

  it("Malay headings: the query is stripped, so different remainders stay apart", () => {
    // query "kos lasik" leaves "pembedahan" and "malaysia" as two different subjects
    const g = grade({ query: "kos lasik", page: page({ mainText: "kos pembedahan lasik ialah antara RM3000 hingga RM6000" }), competitors: pair(["Kos pembedahan LASIK", "Kos LASIK di Malaysia"]) });
    const surgery = g.topics.find((t) => t.label === "Kos pembedahan LASIK")!;
    const country = g.topics.find((t) => t.label === "Kos LASIK di Malaysia")!;
    assert.equal(g.topics.length, 5);
    assert.equal(surgery.covered, true);
    assert.equal(country.covered, false);
  });

  it("labels avoid digits and the cluster takes its best match", () => {
    const g = grade({ competitors: [rival("a.com", { headings: ["5 LASIK risks", ...FILLER] }), rival("b.com", { headings: ["LASIK risks explained", ...FILLER] })] });
    assert.ok(g.topics.some((t) => t.label === "LASIK risks explained"));
    const near = grade({ competitors: [rival("a.com", { headings: ["red green blue", "red green yellow orange", ...FILLER] }), rival("b.com", { headings: ["red green yellow", ...FILLER] })] });
    assert.deepEqual(near.topics.find((t) => t.label === "red green yellow")?.coveredBy, ["a.com", "b.com"]);
  });
});

describe("gradeContent score", () => {
  const heads = ["alpha topic", "bravo topic", "charlie topic", "delta topic"];
  const comps = (over: Partial<GradedPage> = {}) => [rival("a.com", { headings: heads, ...over }), rival("b.com", { headings: heads, ...over })];

  it("full coverage, equal length, same structure is 100 and A", () => {
    const g = grade({ page: page({ headings: heads, listsOrTables: true }), competitors: comps({ listsOrTables: true }) });
    assert.equal(g.score, 100);
    assert.equal(g.grade, "A");
  });

  it("nothing covered, half length, missing lists is 7.5 and F", () => {
    const g = grade({ page: page({ words: 500 }), competitors: comps({ listsOrTables: true }) });
    assert.equal(g.score, 7.5);
    assert.equal(g.grade, "F");
    assert.equal(g.medianWords, 1000);
    assert.equal(g.ownWords, 500);
    assert.deepEqual(g.structure.find((s) => s.feature === "lists"), { feature: "lists", competitors: true, page: false });
  });

  it("a feature is expected only when more than half the competitors have it", () => {
    const g = grade({ competitors: [rival("a.com", { headings: heads, faq: true }), rival("b.com", { headings: heads })] });
    assert.equal(g.structure.find((s) => s.feature === "faq")!.competitors, false);
  });

  it("grade boundaries, at and just below each cut-off", () => {
    // 10 topics; competitors are 1500 words, so score = 70 * covered/10 + words/100 + 15
    const ten = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"].map((w) => `${w} guide`);
    const at = (covered: number, words: number) => {
      const g = grade({ page: page({ headings: ten.slice(0, covered), words }), competitors: [rival("a.com", { headings: ten, words: 1500 }), rival("b.com", { headings: ten, words: 1500 })] });
      return [g.score, g.grade];
    };
    assert.deepEqual(at(10, 0), [85, "A"]);
    assert.deepEqual(at(9, 690), [84.9, "B"]);
    assert.deepEqual(at(7, 600), [70, "B"]);
    assert.deepEqual(at(7, 590), [69.9, "C"]);
    assert.deepEqual(at(5, 500), [55, "C"]);
    assert.deepEqual(at(5, 490), [54.9, "D"]);
    assert.deepEqual(at(3, 400), [40, "D"]);
    assert.deepEqual(at(3, 390), [39.9, "F"]);
  });
});
