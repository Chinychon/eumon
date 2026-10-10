/*
 * DataForSEO: Labs (a domain's ranked keywords in a country; volume,
 * difficulty and intent for a list of keywords; the domains that rank for a
 * list of keywords), the SERP API (one search's results page), and the
 * Backlinks API (link profiles and the link gap). Paid per request and per
 * row, so every answer carries what it cost; the account allows one task per
 * request.
 */
import { bareDomain, type AiAnswerEngine, type ReferringDomain, type AiSource, type BacklinkSummary, type LinkGap, type RankedKeyword, type SerpCompetitor, type SerpFeature, type SerpResult } from "@organic-growth/core";

export type DataForSeoAuth = { login: string; password: string };

/** Countries in Eumon's table that DataForSEO's Google locations don't cover (checked against its list on 2026-10-09): Brunei, Myanmar, Laos, China, Hong Kong, Taiwan, Nepal, Turkey, Russia, Qatar, Kuwait, Oman. */
const UNCOVERED = new Set([96, 104, 418, 156, 344, 158, 524, 792, 643, 634, 414, 512]);

/** DataForSEO's Google location for a country: 2000 + its ISO 3166-1 numeric code, or null for a country it doesn't cover. */
export const dataForSeoLocation = (numeric: number): number | null => (UNCOVERED.has(numeric) ? null : 2000 + numeric);

/** Rows from one call, and what it cost in US dollars. */
export type Answer<T> = { rows: T[]; cost: number };

type Task<T> = { status_code: number; status_message: string; cost: number | null; result: T[] | null };
type Envelope<T> = { status_code: number; status_message: string; tasks: Array<Task<T>> | null };

/** A refusal with DataForSEO's status code, e.g. 40204 when an API isn't active on the account. */
export class DataForSeoError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

/** Posts one task to `/v3/<path>/live` (or to `path` as given when it already names its live mode, like `…/live/advanced`) and returns its first result (undefined when the task has none) with its cost. */
async function post<T>(auth: DataForSeoAuth, path: string, task: object, fetchFn: typeof fetch): Promise<{ result: T | undefined; cost: number }> {
  const name = path.replace(/^dataforseo_labs\/google\//, "");
  const response = await fetchFn(`https://api.dataforseo.com/v3/${/\/live(\/|$)/.test(path) ? path : `${path}/live`}`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${auth.login}:${auth.password}`)}`, "Content-Type": "application/json" },
    body: JSON.stringify([task]),
  });
  if (!response.ok) throw new DataForSeoError(`DataForSEO ${name} request failed (${response.status}).`, response.status);
  const json = await response.json() as Envelope<T>;
  const first = json.tasks?.[0];
  if (!first) throw new DataForSeoError(`DataForSEO: ${json.status_message} (${json.status_code}).`, json.status_code);
  if (first.status_code !== 20000) throw new DataForSeoError(`DataForSEO ${name}: ${first.status_message} (${first.status_code}).`, first.status_code);
  return { result: first.result?.[0], cost: first.cost ?? 0 };
}

const labs = <T>(auth: DataForSeoAuth, endpoint: string, task: object, fetchFn: typeof fetch) => post<T>(auth, `dataforseo_labs/google/${endpoint}`, task, fetchFn);

type RankedItem = {
  keyword_data: { keyword: string; keyword_info?: { search_volume?: number | null } | null; keyword_properties?: { keyword_difficulty?: number | null } | null; search_intent_info?: { main_intent?: string | null } | null };
  ranked_serp_element: { serp_item: { rank_group: number; relative_url?: string | null; etv?: number | null } };
};

/** Rows of a `ranked_keywords` result; a domain DataForSEO doesn't know has none. */
export function rankedKeywordRows(result: unknown): RankedKeyword[] {
  const items = (result as { items?: RankedItem[] | null } | undefined)?.items ?? [];
  return items.map((item) => ({
    keyword: item.keyword_data.keyword,
    volume: item.keyword_data.keyword_info?.search_volume ?? null,
    difficulty: item.keyword_data.keyword_properties?.keyword_difficulty ?? null,
    intent: item.keyword_data.search_intent_info?.main_intent ?? null,
    position: item.ranked_serp_element.serp_item.rank_group,
    url: item.ranked_serp_element.serp_item.relative_url ?? "/",
    traffic: item.ranked_serp_element.serp_item.etv ?? 0,
  }));
}

/** A domain's organic keywords in a country, every language, highest volume first; at most 1,000. Ads are left out: they aren't rankings, and rows cost money. */
export async function fetchRankedKeywords(auth: DataForSeoAuth, domain: string, location: number, fetchFn: typeof fetch = fetch): Promise<Answer<RankedKeyword>> {
  const { result, cost } = await labs(auth, "ranked_keywords", {
    target: domain, location_code: location, limit: 1000, item_types: ["organic"], order_by: ["keyword_data.keyword_info.search_volume,desc"],
  }, fetchFn);
  return { rows: rankedKeywordRows(result), cost };
}

type OverviewItem = { keyword: string; keyword_info?: { search_volume?: number | null } | null; keyword_properties?: { keyword_difficulty?: number | null } | null; search_intent_info?: { main_intent?: string | null } | null };
export type KeywordPrice = { keyword: string; volume: number | null; difficulty: number | null; intent: string | null };

export function keywordOverviewRows(result: unknown): KeywordPrice[] {
  const items = (result as { items?: OverviewItem[] | null } | undefined)?.items ?? [];
  return items.map((item) => ({
    keyword: item.keyword,
    volume: item.keyword_info?.search_volume ?? null,
    difficulty: item.keyword_properties?.keyword_difficulty ?? null,
    intent: item.search_intent_info?.main_intent ?? null,
  }));
}

/** Volume, difficulty and intent for up to 700 keywords in a country and language. Keywords DataForSEO doesn't know are left out, and not charged. */
export async function fetchKeywordOverview(auth: DataForSeoAuth, keywords: string[], location: number, language: string, fetchFn: typeof fetch = fetch): Promise<Answer<KeywordPrice>> {
  const { result, cost } = await labs(auth, "keyword_overview", { keywords: keywords.slice(0, 700), location_code: location, language_code: language }, fetchFn);
  return { rows: keywordOverviewRows(result), cost };
}

type SerpCompetitorItem = { domain: string; avg_position?: number | null; keywords_count?: number | null; visibility?: number | null; etv?: number | null };

export function serpCompetitorRows(result: unknown): SerpCompetitor[] {
  const items = (result as { items?: SerpCompetitorItem[] | null } | undefined)?.items ?? [];
  return items.map((item) => ({ domain: bareDomain(item.domain), keywords: item.keywords_count ?? 0, avgPosition: item.avg_position ?? 0, visibility: item.visibility ?? 0, traffic: item.etv ?? 0 }));
}

/** The domains ranking organically for up to 200 keywords in a country and language, most visible first; at most 100. */
export async function fetchSerpCompetitors(auth: DataForSeoAuth, keywords: string[], location: number, language: string, fetchFn: typeof fetch = fetch): Promise<Answer<SerpCompetitor>> {
  const { result, cost } = await labs(auth, "serp_competitors", {
    keywords: keywords.slice(0, 200), location_code: location, language_code: language, item_types: ["organic"], limit: 100, order_by: ["visibility,desc"],
  }, fetchFn);
  return { rows: serpCompetitorRows(result), cost };
}

/** DataForSEO item types as Eumon's result types; several item types are one feature (short videos are videos). */
const FEATURE_OF: Record<string, SerpFeature> = {
  ai_overview: "ai_overview", featured_snippet: "featured_snippet", local_pack: "local_pack", map: "local_pack", people_also_ask: "people_also_ask",
  video: "video", short_videos: "video", images: "images", shopping: "shopping", popular_products: "shopping", top_stories: "top_stories",
};

type SerpItem = { type: string; rank_group?: number; domain?: string | null; url?: string | null; title?: string | null; references?: Array<{ domain?: string | null }> | null; items?: SerpItem[] | null };

/** Every source domain an AI Overview names, in its own references and its sections'. */
function overviewSources(item: SerpItem): string[] {
  const own = (item.references ?? []).flatMap((reference) => (reference.domain ? [bareDomain(reference.domain)] : []));
  return [...own, ...(item.items ?? []).flatMap(overviewSources)];
}

/** One results page as Eumon keeps it: result types, the first ten organic results, the site's place, and the AI Overview's sources. */
export function serpResult(result: unknown, input: { keyword: string; site: string; checkedAt: string; volume: number | null }): SerpResult {
  const page = result as { item_types?: string[] | null; items?: SerpItem[] | null } | undefined;
  const items = page?.items ?? [];
  const site = bareDomain(input.site);
  const ours = (domain: string | null | undefined) => Boolean(domain) && (bareDomain(domain!) === site || bareDomain(domain!).endsWith(`.${site}`));
  const features = [...new Set((page?.item_types ?? []).map((type) => FEATURE_OF[type]).filter((feature): feature is SerpFeature => Boolean(feature)))];
  const organic = items.filter((item) => item.type === "organic" && item.domain && item.url)
    .map((item) => ({ position: item.rank_group ?? 0, domain: bareDomain(item.domain!), url: item.url!, title: item.title ?? "" }));
  const mine = organic.find((item) => ours(item.domain));
  const sources = [...new Set(items.filter((item) => item.type === "ai_overview").flatMap(overviewSources))];
  return {
    keyword: input.keyword, checkedAt: input.checkedAt, volume: input.volume, features,
    position: mine?.position ?? null, url: mine?.url ?? null,
    aiOverviewSources: sources, cited: sources.some((domain) => ours(domain)),
    organic: organic.slice(0, 10),
  };
}

/** Google's first page for one search in a country and language, AI Overview included (it loads after the page, and costs a little extra to wait for). */
export async function fetchSerp(auth: DataForSeoAuth, input: { keyword: string; location: number; language: string; site: string; checkedAt: string; volume: number | null }, fetchFn: typeof fetch = fetch): Promise<{ row: SerpResult; cost: number }> {
  const { result, cost } = await post(auth, "serp/google/organic/live/advanced", {
    keyword: input.keyword, location_code: input.location, language_code: input.language, depth: 10, load_async_ai_overview: true,
  }, fetchFn);
  return { row: serpResult(result, input), cost };
}

type SummaryResult = { target?: string; rank?: number | null; backlinks?: number | null; referring_domains?: number | null; referring_main_domains?: number | null; broken_backlinks?: number | null; backlinks_spam_score?: number | null };

export function backlinkSummary(result: unknown, domain: string): BacklinkSummary {
  const row = (result ?? {}) as SummaryResult;
  return {
    domain, rank: row.rank ?? 0, backlinks: row.backlinks ?? 0, referringDomains: row.referring_domains ?? 0,
    referringMainDomains: row.referring_main_domains ?? 0, brokenBacklinks: row.broken_backlinks ?? 0, spamScore: row.backlinks_spam_score ?? null,
  };
}

/** A domain's live link profile, subdomains included, internal links left out. */
export async function fetchBacklinkSummary(auth: DataForSeoAuth, domain: string, fetchFn: typeof fetch = fetch): Promise<{ row: BacklinkSummary; cost: number }> {
  const { result, cost } = await post(auth, "backlinks/summary", { target: domain, include_subdomains: true, exclude_internal_backlinks: true, backlinks_status_type: "live" }, fetchFn);
  return { row: backlinkSummary(result, domain), cost };
}

type BacklinkItem = {
  domain_from?: string | null; url_from?: string | null; url_to?: string | null; anchor?: string | null; dofollow?: boolean | null;
  first_seen?: string | null; last_seen?: string | null; is_lost?: boolean | null; is_broken?: boolean | null; domain_from_rank?: number | null; backlink_spam_score?: number | null;
};

/** The site's referring domains: the strongest link from each, live and lost, up to 1,000, one row per bare domain (the first, strongest, stays). */
export async function fetchReferringDomains(auth: DataForSeoAuth, domain: string, fetchFn: typeof fetch = fetch): Promise<{ rows: Array<Omit<ReferringDomain, "spam" | "spamReason">>; cost: number }> {
  const { result, cost } = await post(auth, "backlinks/backlinks", {
    target: domain, mode: "one_per_domain", backlinks_status_type: "all", include_subdomains: true, exclude_internal_backlinks: true, order_by: ["domain_from_rank,desc"], limit: 1000,
  }, fetchFn);
  const items = (result as { items?: BacklinkItem[] | null } | undefined)?.items ?? [];
  const seen = new Set<string>();
  const rows = items.flatMap((item) => {
    if (!item.domain_from) return [];
    const key = bareDomain(item.domain_from);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      // Clipped: a thousand rows are stored whole and some anchors are pages of text.
      domain: key, urlFrom: /^https?:\/\//i.test(item.url_from ?? "") ? item.url_from!.slice(0, 500) : "", urlTo: (item.url_to ?? "").slice(0, 500), anchor: (item.anchor ?? "").slice(0, 200), dofollow: Boolean(item.dofollow),
      firstSeen: (item.first_seen ?? "").slice(0, 10), lastSeen: (item.last_seen ?? "").slice(0, 10), lost: Boolean(item.is_lost), broken: Boolean(item.is_broken),
      rank: item.domain_from_rank ?? 0, spamScore: item.backlink_spam_score ?? null,
    }];
  });
  return { rows, cost };
}

type IntersectionItem = { domain_intersection?: Record<string, { target?: string | null; rank?: number | null; backlinks?: number | null } | null> | null };

export function linkGapRows(result: unknown, targets: string[]): LinkGap[] {
  const items = (result as { items?: IntersectionItem[] | null } | undefined)?.items ?? [];
  return items.flatMap((item) => {
    const entries = Object.entries(item.domain_intersection ?? {}).filter(([, entry]) => entry?.target);
    if (!entries.length) return [];
    return [{
      domain: bareDomain(entries[0]![1]!.target!),
      rank: Math.max(...entries.map(([, entry]) => entry!.rank ?? 0)),
      backlinks: entries.reduce((sum, [, entry]) => sum + (entry!.backlinks ?? 0), 0),
      linksTo: entries.map(([key]) => targets[Number(key) - 1]).filter((domain): domain is string => Boolean(domain)),
    }];
  });
}

/** Sites linking to every one of up to three competitors and not to the site, strongest first; at most 100. */
export async function fetchLinkGap(auth: DataForSeoAuth, competitors: string[], site: string, fetchFn: typeof fetch = fetch): Promise<Answer<LinkGap>> {
  const targets = competitors.slice(0, 3);
  const { result, cost } = await post(auth, "backlinks/domain_intersection", {
    targets: Object.fromEntries(targets.map((domain, index) => [String(index + 1), domain])),
    exclude_targets: [site], limit: 100, order_by: ["1.rank,desc"], exclude_internal_backlinks: true, backlinks_status_type: "live",
  }, fetchFn);
  return { rows: linkGapRows(result, targets), cost };
}

type ScraperResult = { markdown?: string | null; items?: Array<{ text?: string | null; markdown?: string | null }> | null; sources?: Array<{ domain?: string | null; url?: string | null }> | null };
type AiNode = { text?: string | null; markdown?: string | null; references?: Array<{ domain?: string | null; url?: string | null }> | null; items?: AiNode[] | null };
type ResponsesResult = { items?: Array<{ sections?: Array<{ text?: string | null; annotations?: Array<{ url?: string | null }> | null }> | null }> | null };

/** A source as Eumon keeps it: its bare domain (from the URL when DataForSEO gives none) and URL, kept only when http(s) since the card links it; sources with neither are dropped. */
function source(entry: { domain?: string | null; url?: string | null }): AiSource[] {
  const url = /^https?:\/\//i.test(entry.url ?? "") ? entry.url! : "";
  let domain = entry.domain ?? "";
  if (!domain && url) { try { domain = new URL(url).hostname; } catch { return []; } }
  return domain ? [{ domain: bareDomain(domain), url }] : [];
}

/** Each source once: by URL, or by domain when it has no URL; the first occurrence stays. */
function uniqueSources(sources: AiSource[]): AiSource[] {
  const seen = new Set<string>();
  return sources.filter((entry) => {
    const key = entry.url || entry.domain;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** ChatGPT and Gemini as people see them (DataForSEO's LLM Scraper). */
function scraperAnswer(result: ScraperResult | undefined) {
  const text = result?.markdown || (result?.items ?? []).map((item) => item.markdown || item.text || "").filter(Boolean).join("\n");
  return { text, sources: uniqueSources((result?.sources ?? []).flatMap(source)) };
}

/** Google's AI Mode: the text of each AI Overview node (not repeated from a node that already has it) and every reference, however deeply nested. */
function aiModeAnswer(result: { items?: AiNode[] | null } | undefined) {
  const texts: string[] = [];
  const sources: AiSource[] = [];
  const walk = (node: AiNode, hasText: boolean) => {
    const text = node.markdown || node.text;
    if (text && !hasText) texts.push(text);
    for (const reference of node.references ?? []) sources.push(...source(reference));
    for (const child of node.items ?? []) walk(child, hasText || !!text);
  };
  for (const item of result?.items ?? []) walk(item, false);
  return { text: texts.join("\n"), sources: uniqueSources(sources) };
}

/** Perplexity's answer through its API (Sonar searches the web), with the URLs it annotates. */
function responsesAnswer(result: ResponsesResult | undefined) {
  const sections = (result?.items ?? []).flatMap((item) => item.sections ?? []);
  return { text: sections.map((section) => section.text ?? "").filter(Boolean).join("\n"), sources: uniqueSources(sections.flatMap((section) => section.annotations ?? []).flatMap(source)) };
}

/** One question asked of one AI engine in a market: the answer's text and the sources it cites, and what the ask cost. */
export async function fetchAiAnswer(auth: DataForSeoAuth, input: { engine: AiAnswerEngine; prompt: string; location: number; language: string; countryIso2: string | null }, fetchFn: typeof fetch = fetch): Promise<{ text: string; sources: AiSource[]; cost: number }> {
  switch (input.engine) {
    case "chatgpt": {
      const { result, cost } = await post<ScraperResult>(auth, "ai_optimization/chat_gpt/llm_scraper/live/advanced", { keyword: input.prompt, location_code: input.location, language_code: input.language, force_web_search: true }, fetchFn);
      return { ...scraperAnswer(result), cost };
    }
    case "gemini": {
      const { result, cost } = await post<ScraperResult>(auth, "ai_optimization/gemini/llm_scraper/live/advanced", { keyword: input.prompt, location_code: input.location, language_code: input.language }, fetchFn);
      return { ...scraperAnswer(result), cost };
    }
    case "ai_mode": {
      const { result, cost } = await post<{ items?: AiNode[] | null }>(auth, "serp/google/ai_mode/live/advanced", { keyword: input.prompt, location_code: input.location, language_code: input.language }, fetchFn);
      return { ...aiModeAnswer(result), cost };
    }
    case "perplexity": {
      const { result, cost } = await post<ResponsesResult>(auth, "ai_optimization/perplexity/llm_responses", {
        user_prompt: input.prompt, model_name: "sonar", max_output_tokens: 2048, ...(input.countryIso2 ? { web_search_country_iso_code: input.countryIso2 } : {}),
      }, fetchFn);
      return { ...responsesAnswer(result), cost };
    }
  }
}
