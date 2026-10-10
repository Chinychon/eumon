import { gradeContent, verifyTopics, type ContentGradeRow, type GradedPage, type TopicProposal } from "@organic-growth/core";

/*
 * The demo's five graded searches. No AI or network: each search has small synthetic
 * pages (the clinic's and three rivals') and fixed topic proposals, which go through the
 * real `verifyTopics` and `gradeContent`, so the scores come from the real grader.
 */

const RIVALS = ["smile-dental.example", "brightcare-dental.example", "gigi-sihat.example"];

/** Per topic: how each rival words the heading, and the sentence on the clinic's page that covers it. */
const TOPICS: Array<{ label: string; headings: [string, string, string]; sentence: (t: string) => string }> = [
  { label: "Procedure steps", headings: ["How {T} works, step by step", "The {T} procedure steps", "What happens during {T}"], sentence: (t) => `The procedure steps for ${t} start with a scan and a planning visit.` },
  { label: "Who is suitable", headings: ["Who is suitable for {T}", "Are you a good candidate?", "Is {T} right for you?"], sentence: (t) => `Who is suitable for ${t}: most healthy adults after a dentist's check.` },
  { label: "Aftercare", headings: ["Aftercare for {T}", "Looking after your teeth after {T}", "{T} aftercare tips"], sentence: (t) => `Aftercare for ${t} includes gentle brushing and a review visit.` },
  { label: "Recovery time", headings: ["Recovery time after {T}", "How long does {T} take to heal?", "Recovery and healing"], sentence: (t) => `Recovery time after ${t} is usually a few days of mild soreness.` },
  { label: "Risks and side effects", headings: ["Risks and side effects of {T}", "Possible side effects", "Is {T} safe? Risks to know"], sentence: (t) => `Risks and side effects of ${t} are small and we explain each one first.` },
  { label: "Cost breakdown", headings: ["{T} cost breakdown in Kuala Lumpur", "What affects the price of {T}", "Cost breakdown and payment plans"], sentence: (t) => `The cost breakdown for ${t} lists consultation, treatment and follow-up in ringgit.` },
];

type Target = { query: string; treatment: string; slug: string; covered: number[]; words: number; lists: boolean; impressions: number; topics: number };
/** `covered` indexes TOPICS; rivals' median is 1,400 words and they all use lists. */
const TARGETS: Target[] = [
  { query: "dental implants price malaysia", treatment: "dental implants", slug: "dental-implants", topics: 6, covered: [0, 1, 2, 3, 4, 5], words: 1_350, lists: true, impressions: 2_600 },
  { query: "braces price malaysia", treatment: "braces", slug: "braces", topics: 6, covered: [0, 1, 2, 5], words: 1_260, lists: true, impressions: 2_450 },
  { query: "invisalign price malaysia", treatment: "invisalign", slug: "invisalign", topics: 6, covered: [0, 1, 3, 5], words: 1_200, lists: true, impressions: 2_300 },
  // Missing Recovery time, Risks and side effects and Cost breakdown: 2 of 5 topics.
  { query: "root canal cost kuala lumpur", treatment: "root canal", slug: "root-canal", topics: 5, covered: [0, 1], words: 900, lists: true, impressions: 1_160 },
  // Missing five of six, half the median length, no list.
  { query: "teeth whitening cost kuala lumpur", treatment: "teeth whitening", slug: "teeth-whitening", topics: 6, covered: [0], words: 700, lists: false, impressions: 1_080 },
];
// The five-topic search leaves out Aftercare, so its missing topics are the three named above.
const TOPIC_ORDER = [0, 1, 3, 4, 5, 2];

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function demoContentGrades(origin: string, checkedAt: string): ContentGradeRow[] {
  return TARGETS.map((target): ContentGradeRow => {
    const chosen = TOPIC_ORDER.slice(0, target.topics);
    const topics = chosen.map((n) => TOPICS[n]!);
    const own = new Set(target.covered);
    const T = cap(target.treatment);
    const page: GradedPage = {
      url: `${origin}${target.query.includes("kuala lumpur") ? `/prices/${target.slug}/kuala-lumpur` : `/treatments/${target.slug}`}`,
      headings: chosen.filter((n) => own.has(n)).map((n) => TOPICS[n]!.label),
      mainText: chosen.filter((n) => own.has(n)).map((n) => TOPICS[n]!.sentence(target.treatment)).join(" "),
      words: target.words, listsOrTables: target.lists, questionHeadings: 1, faq: true,
    };
    const competitors = RIVALS.map((domain, r) => ({
      domain, url: `https://${domain}/${target.slug}`, words: [1_300, 1_400, 1_500][r]!,
      headings: topics.map((t) => t.headings[r]!.replace("{T}", T)),
      mainText: "", listsOrTables: true, questionHeadings: 1, faq: true,
    }));
    const proposals: TopicProposal[] = chosen.map((n) => ({
      label: TOPICS[n]!.label,
      headings: RIVALS.map((domain, r) => ({ domain, heading: TOPICS[n]!.headings[r]!.replace("{T}", T) })),
      covered: own.has(n),
      evidence: own.has(n) ? TOPICS[n]!.sentence(target.treatment) : null,
    }));
    const grade = gradeContent({ page, competitors, topics: verifyTopics(proposals, { page, competitors, query: target.query }) });
    if (!grade) throw new Error(`demo content grade for "${target.query}" has too few verified topics`);
    return {
      ...grade, query: target.query, market: "mys", page: page.url, checkedAt, source: "search", impressions: target.impressions,
      competitors: competitors.map((c) => ({ domain: c.domain, url: c.url, words: c.words })),
    };
  });
}
