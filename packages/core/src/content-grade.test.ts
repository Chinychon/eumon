import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TOPIC_PROPOSAL_SCHEMA, gradeContent, verifyTopics, type ContentTopic, type GradedPage, type TopicProposal } from "./content-grade.js";

const page = (over: Partial<GradedPage> = {}): GradedPage => ({ url: "https://me.com/p", headings: [], mainText: "", words: 1000, listsOrTables: false, questionHeadings: 0, faq: false, ...over });
const rival = (domain: string, over: Partial<GradedPage> = {}) => ({ ...page({ url: `https://${domain}/p`, ...over }), domain });
const proposal = (label: string, cites: Array<[string, string]>, evidence: string | null = null): TopicProposal => ({
  label,
  headings: cites.map(([domain, heading]) => ({ domain, heading })),
  covered: evidence !== null,
  evidence,
});

describe("verifyTopics citations", () => {
  const competitors = [
    rival("a.com", { headings: ["How much does LASIK cost?", "Recovery time after LASIK", "Who is a good candidate"] }),
    rival("b.com", { headings: ["Harga LASIK di Malaysia", "LASIK recovery", "Risks and side effects"] }),
    rival("c.com", { headings: ["Side effects of LASIK", "Contact us"] }),
  ];
  const verify = (proposals: TopicProposal[], over: { page?: GradedPage; competitors?: typeof competitors; query?: string } = {}) =>
    verifyTopics(proposals, { page: over.page ?? page(), competitors: over.competitors ?? competitors, query: over.query ?? "" });

  it("keeps a topic whose citations exist on two competitors, with both domains", () => {
    const [t] = verify([proposal("Recovery", [["a.com", "Recovery time after LASIK"], ["b.com", "LASIK recovery"]])]);
    assert.deepEqual(t, { label: "Recovery", covered: false, coveredBy: ["a.com", "b.com"], evidence: null });
  });

  it("ignores a citation to a heading the competitor does not have", () => {
    const [t] = verify([proposal("Side effects", [["a.com", "Side effects of LASIK"], ["b.com", "Risks and side effects"], ["c.com", "Side effects of LASIK"]])]);
    assert.deepEqual(t.coveredBy, ["b.com", "c.com"]);
    assert.deepEqual(verify([proposal("Candidates", [["a.com", "Who is a good candidate"], ["b.com", "Who is a good candidate"]])]), []);
  });

  it("drops a topic verified on one domain only", () => {
    assert.deepEqual(verify([proposal("Recovery", [["a.com", "Recovery time after LASIK"], ["a.com", "recovery time after lasik"]])]), []);
    const two = competitors.slice(0, 2);
    assert.deepEqual(verify([proposal("Recovery", [["a.com", "Recovery time after LASIK"]])], { competitors: two }), []);
    assert.equal(verify([proposal("Recovery", [["a.com", "Recovery time after LASIK"], ["b.com", "LASIK recovery"]])], { competitors: two }).length, 1);
  });

  it("matches case, whitespace, curly quotes and end punctuation", () => {
    const quoted = [rival("a.com", { headings: ["What’s the cost?"] }), rival("b.com", { headings: ["Cost – what to expect"] })];
    const [t] = verify([proposal("Cost", [["a.com", "  WHAT'S   the cost "], ["b.com", "Cost - what to expect"]])], { competitors: quoted });
    assert.deepEqual(t.coveredBy, ["a.com", "b.com"]);
  });

  it("a fragment counts only on word boundaries and when it covers half the heading", () => {
    const pairs = (a: string, b: string, cite: string) => verify([proposal("Topic", [["a.com", cite], ["b.com", cite]])], { competitors: [rival("a.com", { headings: [a] }), rival("b.com", { headings: [b] })] });
    assert.deepEqual(pairs("Costa Rica clinics", "Low-cost options", "cost"), []);
    assert.deepEqual(pairs("Our team", "Our team", "team"), []);
    assert.equal(pairs("LASIK recovery time explained", "1. Recovery time", "recovery time").length, 1);
    assert.equal(pairs("Q: How long is recovery?", "Q: How long is recovery?", "How long is recovery").length, 1);
    assert.deepEqual(pairs("LASIK recovery time explained", "LASIK recovery time explained", "tim"), []);
  });

  it("skips citations of generic headings", () => {
    const generic = [rival("a.com", { headings: ["Contact us", "Get in touch"] }), rival("b.com", { headings: ["Contact"] })];
    assert.deepEqual(verify([proposal("Clinic locations", [["a.com", "Contact us"], ["b.com", "Contact"]])], { competitors: generic }), []);
    assert.deepEqual(verify([proposal("Clinic locations", [["a.com", "Get in touch"], ["b.com", "Contact"]])], { competitors: generic }), []);
  });

  it("www and bare domains are one site on both sides", () => {
    const www = [rival("www.a.com", { headings: ["LASIK risks"] }), rival("a.com", { headings: ["Risks of LASIK"] }), rival("b.com", { headings: ["Risks of LASIK"] })];
    assert.deepEqual(verify([proposal("Risks", [["www.a.com", "LASIK risks"], ["a.com", "Risks of LASIK"]])], { competitors: www }), []);
    const [t] = verify([proposal("Risks", [["a.com", "LASIK risks"], ["B.com", "Risks of LASIK"]])], { competitors: www });
    assert.deepEqual(t.coveredBy, ["a.com", "b.com"]);
  });

  it("synonyms are the proposer's job: citations decide, not wording", () => {
    const [t] = verify([proposal("Cost", [["a.com", "How much does LASIK cost?"], ["b.com", "Harga LASIK di Malaysia"]])]);
    assert.equal(t.label, "Cost");
    assert.deepEqual(t.coveredBy, ["a.com", "b.com"]);
  });

  it("drops generic labels", () => {
    const cites: Array<[string, string]> = [["a.com", "Recovery time after LASIK"], ["b.com", "LASIK recovery"]];
    for (const label of ["Frequently Asked Questions", "Frequently asked questions (FAQ)", "FAQs:", "Leave a Reply", "Soalan lazim", "Contact us", "Contact", "Get in touch", "Book an appointment", "Why choose us", "Recent posts", "Leave a comment", "Book a consultation", "Pertanyaan yang sering diajukan", "Kesimpulan"]) {
      assert.deepEqual(verify([proposal(label, cites)]), [], label);
    }
  });

  it("tolerates malformed proposals", () => {
    const junk = [null, { label: null, headings: "x", covered: "yes", evidence: 5 }, { label: "Recovery", headings: [null, { domain: "a.com" }, { domain: "a.com", heading: "Recovery time after LASIK" }, { domain: "b.com", heading: "LASIK recovery" }], covered: true, evidence: null }] as unknown as TopicProposal[];
    assert.deepEqual(verify(junk).map((t) => t.label), ["Recovery"]);
    assert.deepEqual(verify(null as unknown as TopicProposal[]), []);
  });

  it("merges duplicate labels and caps at 12, most-covered first", () => {
    const merged = verify([proposal("Recovery", [["a.com", "Recovery time after LASIK"]]), proposal("recovery.", [["b.com", "LASIK recovery"]])]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].coveredBy, ["a.com", "b.com"]);

    const names = Array.from({ length: 14 }, (_, i) => `topic ${i}`);
    const wide = ["a.com", "b.com", "c.com"].map((d) => rival(d, { headings: names }));
    const proposals = names.map((n, i) => proposal(n, (i === 13 ? ["a.com", "b.com", "c.com"] : ["a.com", "b.com"]).map((d): [string, string] => [d, n])));
    const capped = verify(proposals, { competitors: wide });
    assert.equal(capped.length, 12);
    assert.equal(capped[0].label, "topic 13");
  });
});

describe("verifyTopics evidence", () => {
  const competitors = [rival("a.com", { headings: ["LASIK risks", "Harga LASIK di Malaysia"] }), rival("b.com", { headings: ["Risks of LASIK", "Harga LASIK di Malaysia"] })];
  const cites: Array<[string, string]> = [["a.com", "LASIK risks"], ["b.com", "Risks of LASIK"]];
  const TEXT = "LASIK is a procedure that reshapes the cornea. Most risks fade within weeks.\nThat’s why risks like DRY eyes are temporary.";
  const verdict = (evidence: string | null, over: Partial<GradedPage> = {}, covered = evidence !== null) =>
    verifyTopics([{ ...proposal("Risks", cites, evidence), covered }], { page: page({ mainText: TEXT, headings: ["Book your appointment today"], ...over }), competitors, query: "lasik" })[0];

  it("covered when the quote is in the page text, despite case, whitespace, line breaks and curly quotes", () => {
    const t = verdict("why risks like   dry eyes");
    assert.equal(t.covered, true);
    assert.equal(t.evidence, "why risks like   dry eyes");
    assert.equal(verdict("fade within weeks. That's why risks").covered, true);
  });

  it("covered when the quote is one of the page's headings", () => {
    assert.equal(verdict("Risks and side effects explained", { headings: ["Risks and side effects explained"] }).covered, true);
  });

  it("not covered when the quote is not on the page", () => {
    const t = verdict("LASIK risks include halos at night");
    assert.equal(t.covered, false);
    assert.equal(t.evidence, null);
  });

  it("not covered by off-topic, short or mid-word quotes", () => {
    for (const quote of ["LASIK is a procedure", "Book your appointment today", "is a procedu", "sik is a procedure th", "dry eyes", "risks fade within"]) assert.equal(verdict(quote).covered, false, quote);
  });

  it("relevance counts words shared with the cited headings, minus the query", () => {
    const [t] = verifyTopics([proposal("Cost", [["a.com", "Harga LASIK di Malaysia"], ["b.com", "Harga LASIK di Malaysia"]], "Harga LASIK bermula RM 3,000 untuk kedua-dua mata")], {
      page: page({ mainText: "Harga LASIK bermula RM 3,000 untuk kedua-dua mata." }), competitors, query: "lasik",
    });
    assert.equal(t.covered, true);
  });

  it("a 3-letter word like Malay \"Kos\" ties a quote to its topic; the query alone does not", () => {
    const kos = [rival("a.com", { headings: ["Kos"] }), rival("b.com", { headings: ["Kos"] })];
    const covered = (quote: string) =>
      verifyTopics([proposal("Kos", [["a.com", "Kos"], ["b.com", "Kos"]], quote)], { page: page({ mainText: "Kos LASIK ialah RM 3,000 setiap mata. LASIK is a procedure that reshapes the cornea." }), competitors: kos, query: "lasik" })[0].covered;
    assert.equal(covered("Kos LASIK ialah RM 3,000 setiap mata"), true);
    assert.equal(covered("LASIK is a procedure that reshapes"), false);
  });

  it("normalises Unicode: dashes, invisible characters, composed accents, apostrophes and ellipses", () => {
    const cases: Array<[string, string]> = [
      ["Most risks fade—within a few weeks", "Most risks fade-within a few weeks"],
      ["Most risks fade within 2–3 weeks", "Most risks fade within 2-3 weeks"],
      ["Most risks\u200B fade within weeks", "Most risks fade within weeks"],
      ["Most ri\u00ADsks fade within weeks", "Most risks fade within weeks"],
      ["Les risques sont trés rares", "Les risques sont trés rares"],
      ["Itʼs true the risks are small", "It's true the risks are small"],
      ["The risks vary… ask your surgeon", "The risks vary... ask your surgeon"],
    ];
    for (const [text, quote] of cases) {
      const label = text.startsWith("Les") ? "Risques" : "Risks";
      const t = verifyTopics([{ ...proposal(label, cites, quote) }], { page: page({ mainText: text }), competitors, query: "" })[0];
      assert.equal(t.covered, true, text);
    }
  });

  it("covered:false stays uncovered even with a real quote", () => {
    assert.equal(verdict("why risks like dry eyes", {}, false).covered, false);
  });
});

describe("TOPIC_PROPOSAL_SCHEMA", () => {
  it("is a strict object schema for { topics: TopicProposal[] }", () => {
    const s = TOPIC_PROPOSAL_SCHEMA as unknown as { required: string[]; additionalProperties: boolean; properties: { topics: { type: string; items: { required: string[]; additionalProperties: boolean } } } };
    assert.deepEqual(s.required, ["topics"]);
    assert.equal(s.additionalProperties, false);
    assert.equal(s.properties.topics.type, "array");
    assert.deepEqual(s.properties.topics.items.required, ["label", "headings", "covered", "evidence"]);
    assert.equal(s.properties.topics.items.additionalProperties, false);
  });
});

const topic = (label: string, covered: boolean, coveredBy = ["a.com", "b.com"]): ContentTopic => ({ label, covered, coveredBy, evidence: covered ? "quote" : null });

describe("gradeContent", () => {
  const comps = (over: Partial<GradedPage> = {}) => [rival("a.com", over), rival("b.com", over)];
  const four = (covered: number) => ["alpha", "bravo", "charlie", "delta"].map((l, i) => topic(l, i < covered));
  const grade = (input: { page?: GradedPage; competitors?: ReturnType<typeof comps>; topics: ContentTopic[] }) => {
    const g = gradeContent({ page: input.page ?? page(), competitors: input.competitors ?? comps(), topics: input.topics });
    assert.ok(g);
    return g;
  };

  it("fewer than 3 topics returns null", () => {
    assert.equal(gradeContent({ page: page(), competitors: comps(), topics: four(2).slice(0, 2) }), null);
  });

  it("full coverage, equal length, same structure is 100 and A", () => {
    const g = grade({ page: page({ listsOrTables: true }), competitors: comps({ listsOrTables: true }), topics: four(4) });
    assert.equal(g.score, 100);
    assert.equal(g.grade, "A");
    assert.equal(g.covered, 4);
    assert.deepEqual(g.missing, []);
  });

  it("nothing covered, half length, missing lists is 7.5 and F", () => {
    const g = grade({ page: page({ words: 500 }), competitors: comps({ listsOrTables: true }), topics: four(0) });
    assert.equal(g.score, 7.5);
    assert.equal(g.grade, "F");
    assert.equal(g.medianWords, 1000);
    assert.equal(g.ownWords, 500);
    assert.deepEqual(g.structure.find((s) => s.feature === "lists"), { feature: "lists", competitors: true, page: false });
  });

  it("0 covered of 4 can't exceed F, however long and well structured", () => {
    const g = grade({ page: page({ words: 5000, listsOrTables: true, faq: true }), topics: four(0) });
    assert.ok(g.score <= 30);
    assert.equal(g.grade, "F");
  });

  it("a feature is expected only when more than half the competitors have it", () => {
    const g = grade({ competitors: [rival("a.com", { faq: true }), rival("b.com")], topics: four(0) });
    assert.equal(g.structure.find((s) => s.feature === "faq")!.competitors, false);
  });

  it("missing is ordered by how many competitors cover the topic, capped at 8", () => {
    const topics = Array.from({ length: 10 }, (_, i) => topic(`t${i}`, false, i === 7 ? ["a.com", "b.com", "c.com"] : ["a.com", "b.com"]));
    const g = grade({ topics });
    assert.equal(g.missing.length, 8);
    assert.equal(g.missing[0], "t7");
    assert.equal(g.covered, 0);
  });

  it("grade boundaries, at and just below each cut-off", () => {
    // 10 topics; competitors are 1500 words, so score = 70 * covered/10 + words/100 + 15
    const at = (covered: number, words: number) => {
      const topics = Array.from({ length: 10 }, (_, i) => topic(`t${i}`, i < covered));
      const g = grade({ page: page({ words }), competitors: comps({ words: 1500 }), topics });
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
