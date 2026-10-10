import { bareDomain } from "./serp.js";

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
  EVIDENCE_MIN: 12, // a shorter quote ("dry eyes") proves a word, not coverage
  EVIDENCE_WORDS: 4, // and so does a quote of fewer words
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

/** Comparison form. Tolerates non-strings from unvalidated AI output. */
const norm = (text: unknown) =>
  String(text ?? "")
    .normalize("NFKC") // composes accents; "…" becomes "...", a no-break space a space
    .toLowerCase()
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "") // soft hyphen and zero-width characters
    .replace(/[‘’‛ʼ′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-") // hyphens, dashes and minus
    .replace(/\s+/g, " ")
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, ""); // punctuation at the ends

const GENERIC = new Set(["contact", "contact us", "get in touch", "book an appointment", "book a consultation", "why choose us", "related posts", "recent posts", "share", "share this", "comments", "leave a reply", "leave a comment", "table of contents", "faq", "faqs", "frequently asked questions", "frequently asked questions (faq)", "soalan lazim", "pertanyaan yang sering diajukan", "hubungi kami", "artikel berkaitan", "kongsi", "hubungi", "daftar isi", "artikel terkait", "bagikan", "overview", "introduction", "conclusion", "summary", "references", "sources", "resources", "disclaimer", "kesimpulan", "pengenalan", "pendahuluan", "ringkasan", "rujukan", "penafian", "referensi", "sumber"].map(norm));

const wordsOf = (text: string) => text.match(/[\p{L}\p{N}]+/gu) ?? [];
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `needle` appears in `hay` with no letter or digit touching either end. */
const within = (hay: string, needle: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(needle)}(?![\\p{L}\\p{N}])`, "u").test(hay);
/** A cited heading verifies when it is the heading, or a 2+ word stretch of it covering at least half its words. */
const cites = (heading: string, cited: string) =>
  heading === cited || (wordsOf(cited).length >= 2 && wordsOf(cited).length * 2 >= wordsOf(heading).length && within(heading, cited));

export function verifyTopics(proposals: TopicProposal[], input: { page: GradedPage; competitors: Array<GradedPage & { domain: string }>; query: string }): ContentTopic[] {
  if (!Array.isArray(proposals)) return [];
  const C = CONTENT_GRADE;
  const site = (domain: unknown) => bareDomain(String(domain ?? "").trim());
  const rivals = input.competitors.map((c) => ({ domain: site(c.domain), headings: c.headings.map(norm) }));
  const pageText = [norm(input.page.mainText), ...input.page.headings.map(norm)];
  const query = new Set(norm(input.query).match(/\p{L}+/gu) ?? []);
  // Words that tie a quote to its topic: 3+ letters (Malay "kos"), not the query's (every quote mentions the query).
  const content = (text: string) => (text.match(/\p{L}+/gu) ?? []).filter((w) => w.length >= 3 && !query.has(w));
  const topics = new Map<string, { label: string; domains: Set<string>; words: Set<string>; quotes: string[] }>();

  for (const p of proposals) {
    const key = norm(p?.label);
    if (!key || GENERIC.has(key)) continue;
    const topic = topics.get(key) ?? { label: String(p.label).trim(), domains: new Set<string>(), words: new Set(content(key)), quotes: [] };
    topics.set(key, topic);
    for (const cite of Array.isArray(p.headings) ? p.headings : []) {
      const domain = site(cite?.domain);
      const heading = norm(cite?.heading);
      if (!heading || GENERIC.has(heading)) continue;
      if (!rivals.some((r) => r.domain === domain && r.headings.some((h) => cites(h, heading)))) continue;
      topic.domains.add(domain);
      for (const w of content(heading)) topic.words.add(w);
    }
    if (p.covered === true && typeof p.evidence === "string") topic.quotes.push(p.evidence);
  }

  // Relevance is checked after every duplicate has added its citations.
  const proves = (quote: string, words: Set<string>) =>
    quote.length >= C.EVIDENCE_MIN && wordsOf(quote).length >= C.EVIDENCE_WORDS && content(quote).some((w) => words.has(w)) && pageText.some((t) => within(t, quote));
  const order = [...new Set(rivals.map((r) => r.domain))]; // coveredBy follows the competitors' order
  return [...topics.values()]
    .filter((t) => t.domains.size >= C.MIN_COMPETITORS_PER_TOPIC)
    .map((t) => {
      const evidence = t.quotes.find((q) => proves(norm(q), t.words)) ?? null;
      return { label: t.label, covered: evidence !== null, coveredBy: order.filter((d) => t.domains.has(d)), evidence };
    })
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
