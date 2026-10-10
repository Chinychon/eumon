export type GradedPage = { url: string; headings: string[]; mainText: string; words: number; listsOrTables: boolean; questionHeadings: number; faq: boolean };
export type ContentTopic = { label: string; covered: boolean; coveredBy: string[] };
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
  TOPIC_JACCARD: 0.5, // two headings sharing half their words are the same subject, wording aside
  TEXT_COVERAGE: 0.7, // a page that uses 70% of a topic's words in its text covers it without a heading
  MISSING_MAX: 8, // a longer list stops being actionable
  MIN_COMPETITORS_PER_TOPIC: 2, // one competitor's quirk is not a topic
  WEIGHT_COVERAGE: 0.7, // topics are what searchers and AI answers look for
  WEIGHT_LENGTH: 0.15, // length matters less than substance
  WEIGHT_STRUCTURE: 0.15, // lists, questions and FAQ help skimming and answer extraction
  GRADE_A: 85,
  GRADE_B: 70,
  GRADE_C: 55,
  GRADE_D: 40,
} as const;

const words = (list: string) => new Set(list.split(/\s+/));
const EN = words("a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your yours");
const MS = words("dan di ke dari yang untuk dengan pada ini itu adalah ialah atau juga akan dalam oleh selepas sebelum anda kami kita saya apa bagaimana berapa mengapa kenapa bila mana");
const ID = words("dan di ke dari yang untuk dengan pada ini itu adalah ialah atau juga akan dalam oleh selepas sebelum anda kami kita saya apa bagaimana berapa mengapa kenapa bila mana tidak bisa sudah belum setelah sebagai");
const GENERIC = new Set(["contact us", "related posts", "share", "share this", "comments", "leave a reply", "table of contents", "faq", "faqs", "hubungi kami", "artikel berkaitan", "kongsi", "hubungi", "daftar isi", "artikel terkait", "bagikan"]);

const tokenise = (text: string) => text.toLocaleLowerCase().match(/[\p{L}]+/gu) ?? [];

export function normaliseHeading(text: string): string[] {
  const all = tokenise(text);
  if (GENERIC.has(all.join(" "))) return [];
  const kept = all.filter((t) => !EN.has(t) && !MS.has(t) && !ID.has(t));
  return kept.length < 2 ? [] : kept;
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let both = 0;
  for (const t of sa) if (sb.has(t)) both += 1;
  return both / (sa.size + sb.size - both);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function gradeContent(input: { page: GradedPage; competitors: Array<GradedPage & { domain: string }> }): ContentGrade {
  const { page, competitors } = input;
  const C = CONTENT_GRADE;

  const clusters: Array<{ tokens: string[]; headings: string[]; domains: Set<string> }> = [];
  for (const rival of competitors) {
    for (const heading of rival.headings) {
      const tokens = normaliseHeading(heading);
      if (!tokens.length) continue;
      const home = clusters.find((c) => jaccard(c.tokens, tokens) >= C.TOPIC_JACCARD);
      if (home) {
        home.headings.push(heading);
        home.domains.add(rival.domain);
      } else clusters.push({ tokens, headings: [heading], domains: new Set([rival.domain]) });
    }
  }

  const pageHeadings = page.headings.map(normaliseHeading).filter((t) => t.length);
  const pageText = new Set(tokenise(page.mainText));
  const topics = clusters
    .filter((c) => c.domains.size >= C.MIN_COMPETITORS_PER_TOPIC)
    .map((c) => {
      const inText = c.tokens.filter((t) => pageText.has(t)).length / c.tokens.length >= C.TEXT_COVERAGE;
      return {
        label: c.headings.reduce((short, h) => (h.length < short.length ? h : short)),
        covered: inText || pageHeadings.some((h) => jaccard(h, c.tokens) >= C.TOPIC_JACCARD),
        coveredBy: [...c.domains],
      };
    });

  const covered = topics.filter((t) => t.covered).length;
  const missing = topics.filter((t) => !t.covered).sort((x, y) => y.coveredBy.length - x.coveredBy.length).slice(0, C.MISSING_MAX).map((t) => t.label);

  const medianWords = median(competitors.map((c) => c.words));
  const ratio = medianWords ? Math.min(1, page.words / medianWords) : 1;

  const has = { lists: (p: GradedPage) => p.listsOrTables, questions: (p: GradedPage) => p.questionHeadings > 0, faq: (p: GradedPage) => p.faq };
  const structure = (["lists", "questions", "faq"] as const).map((feature) => ({
    feature,
    competitors: competitors.length > 0 && competitors.filter(has[feature]).length >= competitors.length / 2,
    page: has[feature](page),
  }));
  const wanted = structure.filter((s) => s.competitors);
  const structureShare = wanted.length ? wanted.filter((s) => s.page).length / wanted.length : 1;

  const coverage = topics.length ? covered / topics.length : 1;
  const score = Math.round(100 * (C.WEIGHT_COVERAGE * coverage + C.WEIGHT_LENGTH * ratio + C.WEIGHT_STRUCTURE * structureShare) * 10) / 10;
  const grade = score >= C.GRADE_A ? "A" : score >= C.GRADE_B ? "B" : score >= C.GRADE_C ? "C" : score >= C.GRADE_D ? "D" : "F";
  return { score, grade, topics, covered, missing, ownWords: page.words, medianWords, structure };
}
