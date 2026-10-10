import { AI_FRESHNESS_DAYS, CHECKS, finding, THIN_WORDS, type CrawlCoverage, type CrawlIssue, type CrawlPageResult, type Finding } from "@organic-growth/core";

const n = (value: number) => value.toLocaleString("en");
const pages = (value: number, singular = "page", plural = `${singular}s`) => `${n(value)} ${value === 1 ? singular : plural}`;

/*
 * Whether pages are written so AI assistants can read, trust and quote them:
 * snippet controls, freshness, answer structure, evidence, authorship, entity
 * markup and landmarks. Counted in SQL over the full crawl; the homepage's
 * entity markup comes from the sampled homepage.
 */
export function findingsFromAiContent(input: { siteId: string; analysisId: string; coverage: CrawlCoverage; homepage?: CrawlPageResult }): Finding[] {
  const issues = input.coverage.issues ?? {};
  const examples = input.coverage.issueExamples ?? {};
  const out: Finding[] = [];
  const add = (checkId: string, issue: CrawlIssue, impact: (count: number) => number, title: (count: number) => string, summary: (count: number) => string) => {
    const count = issues[issue] ?? 0;
    if (count <= 0) return;
    out.push(finding(CHECKS[checkId]!, {
      siteId: input.siteId, analysisId: input.analysisId, impact: impact(count), title: title(count), summary: summary(count),
      evidence: { [issue]: count, examples: examples[issue] ?? [] }, pagesAffected: (examples[issue] ?? []).map((example) => example.url),
    }));
  };
  // 35 plus 10 per tenfold of pages: the generic formula would leave every AI content check LOW beside technical ones.
  const scaled = (cap: number) => (count: number) => Math.min(Math.round(35 + Math.log10(count + 1) * 10), cap);
  add("ai.snippet_blocked", "snippetBlocked", scaled(80), (c) => `${pages(c)} block search snippets`,
    (c) => `${pages(c)} carry nosnippet or max-snippet:0. Google says these controls keep a page out of AI Overviews and AI Mode: it can rank, but it cannot be quoted.`);
  add("ai.stale", "stale", scaled(55), (c) => `${pages(c, "article")} ${c === 1 ? "has" : "have"} not been updated in over a year`,
    (c) => `${pages(c, "article")} were last modified more than ${AI_FRESHNESS_DAYS} days ago. Assistants prefer recent sources: three quarters of pages cited in AI answers were updated within twelve months.`);
  add("ai.no_date", "noDate", () => 12, (c) => `${pages(c, "article")} ${c === 1 ? "has" : "have"} no date`,
    (c) => `${pages(c, "article")} carry no publish or update date in structured data, Open Graph tags or a <time> element, so nobody can tell whether they are current.`);
  add("ai.no_answer_structure", "noAnswerStructure", scaled(50), (c) => `${pages(c)} have no question headings, lists or summary`,
    (c) => `${pages(c)} of ${THIN_WORDS} words or more open with a long paragraph and have no question headings, lists or tables. Assistants quote short, self-contained answers; Q&A format and a summary up front raise citation rates by 20 to 30%.`);
  add("ai.low_evidence", "lowEvidence", () => 14, (c) => `${pages(c, "article")} cite no figures, quotes or sources`,
    (c) => `${pages(c, "article")} contain no numbers with units, no quotations and no links to outside sources. In the GEO study, adding statistics, quotations and cited sources raised visibility in AI answers by 28 to 41%.`);
  add("ai.no_author", "noAuthor", () => 14, (c) => `${pages(c, "article")} ${c === 1 ? "has" : "have"} no author`,
    (c) => `${pages(c, "article")} name no author in structured data, a meta tag or a byline. Experience and expertise signals raise AI citation rates.`);
  add("ai.semantic_html_missing", "noLandmarks", () => 12, (c) => `${pages(c)} have no <main> or <article>`,
    (c) => `${pages(c)} use none of <main>, <article>, <nav>, <header> or <footer>, so crawlers cannot tell the content from the menus around it.`);
  // A homepage from before the content signals has no entitySchema field: not judged.
  if (input.homepage && input.homepage.entitySchema === false) {
    out.push(finding(CHECKS["ai.no_entity_schema"]!, {
      siteId: input.siteId, analysisId: input.analysisId, impact: 45,
      title: "The homepage does not say which business this is",
      summary: "The homepage has no Organization or LocalBusiness structured data with sameAs links. Entity markup is how search engines and assistants tell the business apart from namesakes and connect it to its profiles and reviews.",
      evidence: { url: input.homepage.url }, pagesAffected: [input.homepage.url],
    }));
  }
  return out;
}
