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
  const verify = (proposals: TopicProposal[], over: { page?: GradedPage; competitors?: typeof competitors } = {}) => verifyTopics(proposals, { page: over.page ?? page(), competitors: over.competitors ?? competitors });

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

  it("matches case, whitespace, curly quotes and end punctuation, and substrings of 4+ characters", () => {
    const quoted = [rival("a.com", { headings: ["What’s the cost?"] }), rival("b.com", { headings: ["LASIK recovery time explained"] })];
    const [t] = verify([proposal("Cost", [["a.com", "  WHAT'S   the cost "], ["b.com", "recovery time"]])], { competitors: quoted });
    assert.deepEqual(t.coveredBy, ["a.com", "b.com"]);
    assert.deepEqual(verify([proposal("Cost", [["a.com", "What's the cost"], ["b.com", "tim"]])], { competitors: quoted }), []);
  });

  it("synonyms are the proposer's job: citations decide, not wording", () => {
    const [t] = verify([proposal("Cost", [["a.com", "How much does LASIK cost?"], ["b.com", "Harga LASIK di Malaysia"]])]);
    assert.equal(t.label, "Cost");
    assert.deepEqual(t.coveredBy, ["a.com", "b.com"]);
  });

  it("drops generic labels", () => {
    const cites: Array<[string, string]> = [["a.com", "Recovery time after LASIK"], ["b.com", "LASIK recovery"]];
    for (const label of ["Frequently Asked Questions", "Leave a Reply", "Soalan lazim", "Contact us", "Recent posts", "Leave a comment", "Book a consultation", "Pertanyaan yang sering diajukan", "FAQ", "Kesimpulan"]) {
      assert.deepEqual(verify([proposal(label, cites)]), [], label);
    }
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
  const competitors = [rival("a.com", { headings: ["LASIK risks"] }), rival("b.com", { headings: ["Risks of LASIK"] })];
  const cites: Array<[string, string]> = [["a.com", "LASIK risks"], ["b.com", "Risks of LASIK"]];
  const verdict = (evidence: string | null, over: Partial<GradedPage> = {}, covered = evidence !== null) =>
    verifyTopics([{ ...proposal("Risks", cites, evidence), covered }], { page: page({ mainText: "Some patients get DRY eyes for a few weeks.\nThat’s normal.", ...over }), competitors })[0];

  it("covered when the quote is in the page text, despite case, whitespace and curly quotes", () => {
    const t = verdict("some patients   get dry eyes");
    assert.equal(t.covered, true);
    assert.equal(t.evidence, "some patients   get dry eyes");
    assert.equal(verdict("a few weeks. That's normal.").covered, true);
  });

  it("covered when the quote is one of the page's headings", () => {
    assert.equal(verdict("Risks and side effects", { headings: ["Risks and side effects"] }).covered, true);
  });

  it("not covered when the quote is not on the page", () => {
    const t = verdict("LASIK can cause halos at night");
    assert.equal(t.covered, false);
    assert.equal(t.evidence, null);
  });

  it("not covered when the quote is shorter than 12 characters", () => {
    assert.equal(verdict("dry eyes").covered, false);
  });

  it("covered:false stays uncovered even with a real quote", () => {
    assert.equal(verdict("some patients get dry eyes", {}, false).covered, false);
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
