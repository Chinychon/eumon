export type GradedPage = { url: string; headings: string[]; mainText: string; words: number; listsOrTables: boolean; questionHeadings: number; faq: boolean };
/** `evidence` is the verified quote from the page, shown on the card; null when the page does not cover the topic. */
export type ContentTopic = { label: string; covered: boolean; coveredBy: string[]; evidence: string | null };
export type ContentGrade = {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  topics: ContentTopic[];
  covered: number;
  missing: string[];
  ownWords: number;
  medianWords: number;
  structure: Array<{ feature: "lists" | "questions" | "faq"; competitors: boolean; page: boolean }>;
};

export const CONTENT_GRADE = {
  MISSING_MAX: 8, // a longer list stops being actionable
  MIN_COMPETITORS_PER_TOPIC: 2, // one competitor's quirk is not a topic
  TOPICS_MAX: 12, // keeps the card readable; the proposer may send up to 15
  CITATION_MIN: 4, // a cited fragment shorter than this matches almost any heading
  EVIDENCE_MIN: 12, // a shorter quote ("dry eyes") proves a word, not coverage
  WEIGHT_COVERAGE: 0.7, // topics are what searchers and AI answers look for
  WEIGHT_LENGTH: 0.15, // length matters less than substance
  WEIGHT_STRUCTURE: 0.15, // lists, questions and FAQ help skimming and answer extraction
  MIN_TOPICS: 3, // below this a coverage share says little, so no grade is given
  GRADE_A: 85, // matches or beats the top results on nearly everything
  GRADE_B: 70, // covers most topics, small gaps
  GRADE_C: 55, // covers about half; clear gaps
  GRADE_D: 40, // covers few topics
} as const;

/** What the AI returns per topic; every citation and quote is checked by `verifyTopics`. */
export type TopicProposal = { label: string; headings: Array<{ domain: string; heading: string }>; covered: boolean; evidence: string | null };

const strict = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
/** JSON schema for the AI's answer, `{ topics: TopicProposal[] }`, in the strict subset `JsonLlm` providers accept. */
export const TOPIC_PROPOSAL_SCHEMA = strict({
  topics: {
    type: "array",
    // The cap lives in the description: Anthropic structured outputs do not support maxItems.
    description: "At most 15 topics.",
    items: strict({
      label: { type: "string", description: "Short topic name in the page's language." },
      headings: { type: "array", items: strict({ domain: { type: "string" }, heading: { type: "string", description: "Copied verbatim from that competitor's headings." } }) },
      covered: { type: "boolean" },
      evidence: { anyOf: [{ type: "string", description: "A passage copied verbatim from the site's page that covers the topic." }, { type: "null" }] },
    }),
  },
});

const GENERIC = new Set(["contact us", "related posts", "recent posts", "share", "share this", "comments", "leave a reply", "leave a comment", "book a consultation", "table of contents", "faq", "faqs", "frequently asked questions", "soalan lazim", "pertanyaan yang sering diajukan", "hubungi kami", "artikel berkaitan", "kongsi", "hubungi", "daftar isi", "artikel terkait", "bagikan", "overview", "introduction", "conclusion", "summary", "references", "sources", "resources", "disclaimer", "kesimpulan", "pengenalan", "pendahuluan", "ringkasan", "rujukan", "penafian", "referensi", "sumber"]);

/** Comparison form: lower-case, straight quotes, single spaces, no punctuation at the ends. Tolerates non-strings from unvalidated AI output. */
const norm = (text: unknown) =>
  String(text ?? "").toLocaleLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, " ").replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "");

export function verifyTopics(proposals: TopicProposal[], input: { page: GradedPage; competitors: Array<GradedPage & { domain: string }> }): ContentTopic[] {
  const C = CONTENT_GRADE;
  const rivals = input.competitors.map((c) => ({ domain: norm(c.domain), headings: c.headings.map(norm) }));
  const pageText = [norm(input.page.mainText), ...input.page.headings.map(norm)];
  const topics = new Map<string, { label: string; domains: Set<string>; evidence: string | null }>();

  for (const p of proposals) {
    const key = norm(p.label);
    if (!key || GENERIC.has(key)) continue;
    const topic = topics.get(key) ?? { label: String(p.label).trim(), domains: new Set<string>(), evidence: null };
    topics.set(key, topic);
    for (const cite of Array.isArray(p.headings) ? p.headings : []) {
      const domain = norm(cite?.domain);
      const heading = norm(cite?.heading);
      const ok = heading && rivals.some((r) => r.domain === domain && r.headings.some((h) => h === heading || (heading.length >= C.CITATION_MIN && h.includes(heading))));
      if (ok) topic.domains.add(domain);
    }
    const quote = norm(p.evidence);
    if (p.covered === true && !topic.evidence && quote.length >= C.EVIDENCE_MIN && pageText.some((t) => t.includes(quote))) topic.evidence = String(p.evidence);
  }

  const order = [...new Set(rivals.map((r) => r.domain))]; // coveredBy follows the competitors' order
  return [...topics.values()]
    .filter((t) => t.domains.size >= C.MIN_COMPETITORS_PER_TOPIC)
    .map((t) => ({ label: t.label, covered: t.evidence !== null, coveredBy: order.filter((d) => t.domains.has(d)), evidence: t.evidence }))
    .sort((x, y) => y.coveredBy.length - x.coveredBy.length)
    .slice(0, C.TOPICS_MAX);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function gradeContent(input: { page: GradedPage; competitors: Array<GradedPage & { domain: string }>; topics: ContentTopic[] }): ContentGrade | null {
  const { page, competitors, topics } = input;
  const C = CONTENT_GRADE;
  if (topics.length < C.MIN_TOPICS) return null;

  const covered = topics.filter((t) => t.covered).length;
  const missing = topics.filter((t) => !t.covered).sort((x, y) => y.coveredBy.length - x.coveredBy.length).slice(0, C.MISSING_MAX).map((t) => t.label);

  const medianWords = median(competitors.map((c) => c.words));
  const ratio = medianWords ? Math.min(1, page.words / medianWords) : 1;

  const has = { lists: (p: GradedPage) => p.listsOrTables, questions: (p: GradedPage) => p.questionHeadings > 0, faq: (p: GradedPage) => p.faq };
  const structure = (["lists", "questions", "faq"] as const).map((feature) => ({
    feature,
    competitors: competitors.filter(has[feature]).length > competitors.length / 2, // same majority rule as topics
    page: has[feature](page),
  }));
  const wanted = structure.filter((s) => s.competitors);
  const structureShare = wanted.length ? wanted.filter((s) => s.page).length / wanted.length : 1;

  const score = Math.round(100 * (C.WEIGHT_COVERAGE * (covered / topics.length) + C.WEIGHT_LENGTH * ratio + C.WEIGHT_STRUCTURE * structureShare) * 10) / 10;
  const grade = score >= C.GRADE_A ? "A" : score >= C.GRADE_B ? "B" : score >= C.GRADE_C ? "C" : score >= C.GRADE_D ? "D" : "F";
  return { score, grade, topics, covered, missing, ownWords: page.words, medianWords, structure };
}
