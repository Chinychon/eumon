import { LlmError, type JsonLlm } from "@organic-growth/ai";
import {
  addDays, bareDomain, competitorKind, gradeContent, TOPIC_PROPOSAL_SCHEMA, verifyTopics,
  type ContentGrade, type GradedPage, type RankCheck, type SearchMetricRow, type SerpResult, type TopicProposal,
} from "@organic-growth/core";
import { BROWSER_UA, contentSignals, defaultFetcher, fetchRobots, isEmptyShell, parseHtmlSignals, type Fetcher } from "@organic-growth/crawler";

/*
 * Content grading, the agent half: which searches to grade this analysis, and
 * reading the site's page and the pages that outrank it. The AI proposes the
 * topics the top results share; core verifies every citation and grades.
 */

export type ContentTarget = { query: string; market: string; page: string; source: "tracked" | "search"; impressions: number | null };
export type ContentGradeRow = ContentGrade & {
  query: string;
  market: string;
  page: string;
  checkedAt: string;
  source: ContentTarget["source"];
  impressions: number | null;
  competitors: Array<{ domain: string; url: string; words: number }>;
};

export const CONTENT_TARGETS = {
  MAX: 8, // per analysis; the rest wait for the next one
  TOP: 10, // a tracked keyword is graded once it ranks in the ten
  SEARCH_MIN: 4, // striking distance: close enough to the top to be worth closing the gap
  SEARCH_MAX: 15,
  SPACING_DAYS: 28, // a search is graded once per four weeks
  COMPETITORS: 3,
  MIN_COMPETITORS: 2,
  MIN_WORDS: 100, // less is a stub, not a page to compare
  MAIN_TEXT_CHARS: 8000, // what the AI reads of the site's page
} as const;

const key = (query: string, market: string) => `${query.trim().toLowerCase()}|${market}`;

export function pickContentTargets(input: { checks: RankCheck[]; tracked: string[]; markets: string[]; searchRows: SearchMetricRow[]; graded: ContentGradeRow[]; today: string }): ContentTarget[] {
  const C = CONTENT_TARGETS;
  const candidates: ContentTarget[] = [];
  const queries = new Set<string>();
  const pages = new Set<string>();
  const add = (target: ContentTarget) => {
    const query = target.query.trim().toLowerCase();
    if (queries.has(query) || pages.has(target.page)) return;
    queries.add(query);
    pages.add(target.page);
    candidates.push(target);
  };

  const latest = new Map<string, RankCheck>();
  for (const check of input.checks) {
    const k = `${check.keyword}|${check.market}`;
    if ((latest.get(k)?.day ?? "") <= check.day) latest.set(k, check);
  }
  for (const keyword of input.tracked) {
    for (const market of input.markets) {
      const check = latest.get(`${keyword}|${market}`);
      if (check?.position != null && check.position <= C.TOP && check.url) add({ query: keyword, market, page: check.url, source: "tracked", impressions: null });
    }
  }

  // Search Console pairs across devices and countries; position weighted by impressions, market from the biggest country.
  const pairs = new Map<string, { query: string; page: string; impressions: number; weighted: number; countries: Map<string, number> }>();
  for (const row of input.searchRows) {
    const k = `${row.query}\u0000${row.page}`;
    const pair = pairs.get(k) ?? { query: row.query, page: row.page, impressions: 0, weighted: 0, countries: new Map<string, number>() };
    pairs.set(k, pair);
    pair.impressions += row.impressions;
    pair.weighted += row.position * row.impressions;
    pair.countries.set(row.country, (pair.countries.get(row.country) ?? 0) + row.impressions);
  }
  const striking = [...pairs.values()]
    .filter((p) => p.impressions > 0 && p.weighted / p.impressions >= C.SEARCH_MIN && p.weighted / p.impressions <= C.SEARCH_MAX)
    .sort((a, b) => b.impressions - a.impressions);
  for (const pair of striking) {
    const country = [...pair.countries].sort((a, b) => b[1] - a[1])[0]![0];
    const market = input.markets.includes(country) ? country : input.markets[0];
    if (market) add({ query: pair.query, market, page: pair.page, source: "search", impressions: pair.impressions });
  }

  // Spacing applies after de-duplication: a page graded recently for one search is not re-graded for another.
  const since = addDays(input.today, -C.SPACING_DAYS);
  const recent = new Set(input.graded.filter((row) => row.checkedAt.slice(0, 10) > since).map((row) => key(row.query, row.market)));
  return candidates.filter((t) => !recent.has(key(t.query, t.market))).slice(0, C.MAX);
}

/** The page as content grading reads it, or null when it can't be read: error status, failed fetch, empty shell or a stub. */
export async function fetchGradedPage(url: string, fetcher: Fetcher = defaultFetcher): Promise<GradedPage | null> {
  let response;
  try {
    response = await fetcher(url, { userAgent: BROWSER_UA });
  } catch {
    return null;
  }
  if (response.status >= 400) return null;
  const signals = parseHtmlSignals(response.body, response.finalUrl);
  if (isEmptyShell(response.body, signals)) return null;
  const content = contentSignals(response.body, response.finalUrl, { jsonLdTypes: signals.jsonLdTypes, jsonLd: signals.jsonLdObjects });
  if (content.words < CONTENT_TARGETS.MIN_WORDS) return null;
  // ponytail: headingOutline keeps the first 20 H1–H3 (120 characters each); read the spans directly if long guides lose topics.
  const headings = signals.headingOutline.filter((h) => /^h[23]:/.test(h)).map((h) => h.slice(3).trim()).filter(Boolean);
  return {
    url,
    headings,
    mainText: signals.mainText,
    words: content.words,
    listsOrTables: content.listsOrTables,
    questionHeadings: content.questionHeadings,
    faq: signals.jsonLdTypes.includes("FAQPage"),
  };
}

/** The AI's topic list could not be used; the caller notes a skip. */
export class TopicProposalError extends Error {}

const PROPOSE_SYSTEM = [
  "You compare a web page with the pages that rank above it on Google for a search.",
  "You are given each competitor's H2 and H3 headings, by domain, and the page's own headings and main text.",
  "List up to 15 topics that at least two competitors cover.",
  "For each topic, quote the competitor headings that cover it, copied character for character, each with its domain.",
  "Say whether the page covers the topic. If it does, quote one passage of at least 4 words copied character for character from the page's text or headings; if it does not, give null.",
  "Write topic labels in the page's language.",
  "Never invent headings or quotes: anything not copied exactly is discarded.",
  "Leave out navigation, contact, booking and comment sections.",
].join(" ");

/** One AI call that proposes the topics the competitors share. The answer is returned unverified: `verifyTopics` checks it. */
export async function proposeTopics(
  llm: JsonLlm,
  input: { query: string; market: string; page: GradedPage; competitors: Array<GradedPage & { domain: string }> },
): Promise<TopicProposal[]> {
  let answer: { topics?: unknown } | null;
  try {
    answer = await llm.json<{ topics?: unknown } | null>({
      system: PROPOSE_SYSTEM,
      user: JSON.stringify({
        query: input.query,
        market: input.market,
        competitors: input.competitors.map((c) => ({ domain: c.domain, headings: c.headings })),
        page: { url: input.page.url, headings: input.page.headings, mainText: input.page.mainText.slice(0, CONTENT_TARGETS.MAIN_TEXT_CHARS) },
      }),
      schema: TOPIC_PROPOSAL_SCHEMA,
      maxTokens: 4000,
      effort: "low",
    });
  } catch (error) {
    // Provider outages (LlmHttpError, network) propagate: they are not a bad answer.
    if (error instanceof LlmError) throw new TopicProposalError(error.message);
    throw error;
  }
  if (!answer || !Array.isArray(answer.topics)) throw new TopicProposalError("The AI's answer had no topic list.");
  return answer.topics as TopicProposal[];
}

const domainOf = (url: string) => {
  try {
    return bareDomain(new URL(url).hostname);
  } catch {
    return "";
  }
};

export async function gradeTarget(
  target: ContentTarget,
  input: { serpRow: SerpResult; site: string; llm: JsonLlm | null; fetcher?: Fetcher },
): Promise<{ row: ContentGradeRow } | { skipped: string }> {
  const C = CONTENT_TARGETS;
  if (!input.llm) return { skipped: "no AI model configured" };
  const fetcher = input.fetcher ?? defaultFetcher;
  const site = bareDomain(input.site);
  const isSite = (domain: string) => domain === site || domain.endsWith(`.${site}`);

  // The first three organic results that are rivals, one page per domain (topics are verified per domain).
  const picked: Array<{ domain: string; url: string }> = [];
  for (const result of [...input.serpRow.organic].sort((a, b) => a.position - b.position)) {
    const domain = domainOf(result.url); // empty for a URL that can't be parsed
    if (!domain || isSite(domain) || competitorKind(domain) === "platform" || picked.some((p) => p.domain === domain)) continue;
    picked.push({ domain, url: result.url });
    if (picked.length === C.COMPETITORS) break;
  }

  // One domain per rival, so robots.txt is read once per origin. An unreachable robots.txt means an unreachable site: skip it like a failed fetch.
  const allowed = (url: string) => {
    const { origin, pathname, search } = new URL(url);
    return fetchRobots(origin, "*", BROWSER_UA, fetcher).then((policy) => policy?.isAllowed(pathname + search) ?? true, () => false);
  };

  const [page, ...rivals] = await Promise.all([
    fetchGradedPage(target.page, fetcher),
    ...picked.map(async (rival) => ((await allowed(rival.url)) ? fetchGradedPage(rival.url, fetcher) : null)),
  ]);
  if (!page) return { skipped: "the page could not be read" };
  const competitors = picked.flatMap((rival, i) => (rivals[i] ? [{ ...rivals[i]!, domain: rival.domain }] : []));
  if (competitors.length < C.MIN_COMPETITORS) return { skipped: "fewer than 2 competitor pages could be read" };

  let proposals: TopicProposal[];
  try {
    proposals = await proposeTopics(input.llm, { query: target.query, market: target.market, page, competitors });
  } catch (error) {
    if (error instanceof TopicProposalError) return { skipped: "the AI's topic list could not be read" };
    throw error;
  }
  const topics = verifyTopics(proposals, { page, competitors, query: target.query });
  const grade = gradeContent({ page, competitors, topics });
  if (!grade) return { skipped: "too few topics the top results share" };
  return {
    row: {
      ...grade,
      ...target,
      checkedAt: new Date().toISOString(),
      competitors: competitors.map((c) => ({ domain: c.domain, url: c.url, words: c.words })),
    },
  };
}
