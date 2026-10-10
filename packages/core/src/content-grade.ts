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
  MIN_TOPICS: 3, // below this a coverage share says little, so no grade is given
  GRADE_A: 85, // matches or beats the top results on nearly everything
  GRADE_B: 70, // covers most topics, small gaps
  GRADE_C: 55, // covers about half; clear gaps
  GRADE_D: 40, // covers few topics
} as const;

const words = (list: string) => new Set(list.split(/\s+/));
const EN = words("a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up us versus very vs was we were what when where which while who whom why will with would you your yours");
const MS = words("dan di ke dari yang untuk dengan pada ini itu adalah ialah atau juga akan dalam oleh selepas sebelum anda kami kita saya apa bagaimana berapa mengapa kenapa bila mana apakah adakah siapa berapakah bagaimanakah boleh tentang mengenai bagi");
const ID = words("dan di ke dari yang untuk dengan pada ini itu adalah ialah atau juga akan dalam oleh selepas sebelum anda kami kita saya apa bagaimana berapa mengapa kenapa bila mana apakah adakah siapa berapakah bagaimanakah boleh tentang mengenai bagi tidak bisa sudah belum setelah sebagai");
const GENERIC = new Set(["contact us", "related posts", "share", "share this", "comments", "leave a reply", "table of contents", "faq", "faqs", "hubungi kami", "artikel berkaitan", "kongsi", "hubungi", "daftar isi", "artikel terkait", "bagikan", "overview", "introduction", "conclusion", "summary", "references", "sources", "resources", "disclaimer", "kesimpulan", "pengenalan", "pendahuluan", "ringkasan", "rujukan", "penafian", "referensi", "sumber"]);

// ponytail: crude stemmer (plural s, first 5 letters); upgrade to a real stemmer if topics merge wrongly.
const stem = (t: string) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t).slice(0, 5);
// Contractions ("don't", "don'ts") and "'s" go first so "Dan's" and "do's and don'ts" leave no junk; 1-letter tokens go.
const rawTokens = (text: string) => (text.toLocaleLowerCase().replace(/\p{L}+n['\u2019]ts?\b/gu, "").replace(/['\u2019]s\b/g, "").match(/[\p{L}]+/gu) ?? []).filter((t) => t.length > 1);
const tokenise = (text: string) => rawTokens(text).map(stem);
const content = (tokens: string[]) => tokens.filter((t) => !EN.has(t) && !MS.has(t) && !ID.has(t)).map(stem);

export function normaliseHeading(text: string, queryTokens: ReadonlySet<string> = new Set()): string[] {
  const all = rawTokens(text);
  if (GENERIC.has(all.join(" "))) return [];
  return content(all).filter((t) => !queryTokens.has(t));
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

const label = (headings: string[]) => {
  const shortest = (list: string[]) => list.reduce((short, h) => (h.length < short.length ? h : short));
  const plain = headings.filter((h) => !/\d/.test(h));
  return shortest(plain.length ? plain : headings);
};

export function gradeContent(input: { page: GradedPage; competitors: Array<GradedPage & { domain: string }>; query: string }): ContentGrade | null {
  const { page, competitors } = input;
  const C = CONTENT_GRADE;
  const query = new Set(content(rawTokens(input.query)));

  const clusters: Array<{ tokens: string[]; headings: string[]; domains: Set<string> }> = [];
  for (const rival of competitors) {
    for (const heading of rival.headings) {
      const tokens = normaliseHeading(heading, query);
      if (!tokens.length) continue;
      let home: (typeof clusters)[number] | undefined;
      let best: number = C.TOPIC_JACCARD;
      for (const c of clusters) {
        const sim = jaccard(c.tokens, tokens);
        if (sim >= best && (!home || sim > best)) {
          home = c;
          best = sim;
        }
      }
      if (home) {
        home.headings.push(heading);
        home.domains.add(rival.domain);
      } else clusters.push({ tokens, headings: [heading], domains: new Set([rival.domain]) });
    }
  }

  const pageHeadings = page.headings.map((h) => normaliseHeading(h, query)).filter((t) => t.length);
  const sentences = page.mainText.split(/[.!?\n]+/).map((s) => new Set(tokenise(s)));
  const topics = clusters
    .filter((c) => c.domains.size >= C.MIN_COMPETITORS_PER_TOPIC)
    .map((c) => ({
      label: label(c.headings),
      covered: sentences.some((s) => c.tokens.filter((t) => s.has(t)).length / c.tokens.length >= C.TEXT_COVERAGE) || pageHeadings.some((h) => jaccard(h, c.tokens) >= C.TOPIC_JACCARD),
      coveredBy: [...c.domains],
    }));
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
