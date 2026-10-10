/*
 * AI answer tracking, pure: the questions users ask AI assistants, and what an
 * assistant's answer says about the site — whether it names the brand
 * ("mentioned"), links the site among its sources ("cited"), and which
 * competitors it names or cites instead.
 */

import { addDays } from "./dates.js";
import { bareDomain, isOrUnder } from "./serp.js";

export const AI_ANSWER_ENGINES = [
  { engine: "chatgpt", label: "ChatGPT" },
  { engine: "gemini", label: "Gemini" },
  { engine: "ai_mode", label: "Google AI Mode" },
  { engine: "perplexity", label: "Perplexity" },
] as const;
export type AiAnswerEngine = (typeof AI_ANSWER_ENGINES)[number]["engine"];

export const AI_PROMPTS_MAX = 25;
export const AI_BRAND_NAMES_MAX = 5;
/** A question is asked again in a market and engine once its last answer is this many days old. */
export const AI_CHECK_FRESH_DAYS = 7;

export const normalizePrompt = (text: string) => text.trim().replace(/\s+/g, " ");

export type AiSource = { domain: string; url: string };
export type AiRival = { domain: string; mentioned: boolean; cited: boolean };
export type AiAnswerCheck = {
  prompt: string;
  market: string;
  engine: AiAnswerEngine;
  day: string;
  mentioned: boolean;
  cited: boolean;
  /** The site's place among the answer's distinct source domains (1 = first), or null when not cited. */
  citedRank: number | null;
  sources: AiSource[];
  rivals: AiRival[];
  excerpt: string;
};

/** "brightsmile.example" → "brightsmile"; "rival-dental.example" → "rival-dental". */
const domainLabel = (domain: string) => bareDomain(domain).split(".")[0] ?? domain;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BOUNDARY = "[^\\p{L}\\p{N}]";
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}]/u;
const straighten = (text: string) => text.replace(/[\u2018\u2019]/g, "'");

/** A whole-word pattern for a name; a hyphen or space in it matches either, or nothing; names of three characters or fewer match only in their exact case. Scripts written without spaces match as plain substrings. */
function namePattern(name: string): RegExp {
  const clean = straighten(name.trim());
  if (NO_SPACES.test(clean)) return new RegExp(`()${escapeRegExp(clean)}`, "u");
  const body = escapeRegExp(clean).replace(/[\s-]+/g, "[\\s-]?");
  return new RegExp(`(^|${BOUNDARY})${body}($|${BOUNDARY})`, clean.length <= 3 ? "u" : "iu");
}

/** A domain label as written ("rival-dental") or with its hyphens removed ("rivaldental"), whole-word, never with a space. */
function labelPattern(label: string): RegExp {
  const forms = [...new Set([label, label.replace(/-/g, "")])].map(escapeRegExp).join("|");
  return new RegExp(`(^|${BOUNDARY})(?:${forms})($|${BOUNDARY})`, "iu");
}

/** A label made only of the question's own words ("dentist-kl" for "best dentist kl") says nothing about a brand. */
const isGenericLabel = (label: string, prompt: string) =>
  label.split("-").filter(Boolean).every((part) => new RegExp(`(^|${BOUNDARY})${escapeRegExp(part)}($|${BOUNDARY})`, "iu").test(prompt));

function firstMatch(text: string, patterns: RegExp[]): number {
  let first = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const at = match.index + match[1]!.length;
      if (first < 0 || at < first) first = at;
    }
  }
  return first;
}

/** The patterns that find a domain in text: the domain itself, and its label unless the question's own words make it up. */
const domainPatterns = (domain: string, prompt: string) => {
  const label = domainLabel(domain);
  return [namePattern(domain), ...(label.length >= 2 && !isGenericLabel(label, prompt) ? [labelPattern(label)] : [])];
};

const EXCERPT = 600;

/** What one answer says about the site: mentioned (a brand name, the domain or its label in the text, links aside), cited (a source on the site's domain), and which competitors it names or cites. The excerpt is cut from the link-stripped text. */
export function readAnswer(input: { text: string; prompt: string; sources: AiSource[]; brandNames: string[]; site: string; competitors: string[] }) {
  const site = bareDomain(input.site);
  const text = straighten(input.text).replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+/g, " ");
  const names = [...new Set(input.brandNames)].filter((name) => name.trim().length >= 2);
  const at = firstMatch(text, [...names.map(namePattern), ...domainPatterns(site, input.prompt)]);
  const domains = [...new Set(input.sources.map((source) => bareDomain(source.domain)))];
  const rank = domains.findIndex((domain) => isOrUnder(domain, site));
  const rivals: AiRival[] = input.competitors.map((competitor) => {
    const domain = bareDomain(competitor);
    return { domain, mentioned: firstMatch(text, domainPatterns(domain, input.prompt)) >= 0, cited: domains.some((source) => isOrUnder(source, domain)) };
  }).filter((rival) => rival.mentioned || rival.cited);
  const start = at < 0 ? 0 : Math.max(0, Math.min(at - EXCERPT / 2, text.length - EXCERPT));
  return { mentioned: at >= 0, cited: rank >= 0, citedRank: rank >= 0 ? rank + 1 : null, rivals, excerpt: text.slice(start, start + EXCERPT) };
}

/** The latest check of each (prompt, market, engine) among current prompts and markets. */
export function latestChecks(checks: AiAnswerCheck[], prompts: string[], markets: string[]): AiAnswerCheck[] {
  const wanted = new Set(prompts);
  const latest = new Map<string, AiAnswerCheck>();
  for (const check of checks) {
    if (!wanted.has(check.prompt) || !markets.includes(check.market)) continue;
    const key = `${check.prompt}|${check.market}|${check.engine}`;
    const seen = latest.get(key);
    if (!seen || check.day > seen.day) latest.set(key, check);
  }
  return [...latest.values()];
}

/** The day's ledger points over the latest answers of the last 7 days: answers checked, mentioning, citing — overall, per engine, and per competitor. */
export function aiAnswerPoints(checks: AiAnswerCheck[], prompts: string[], markets: string[], competitors: string[], day: string) {
  const recent = latestChecks(checks.filter((check) => check.day > addDays(day, -AI_CHECK_FRESH_DAYS)), prompts, markets);
  const count = (rows: AiAnswerCheck[], pick: (row: AiAnswerCheck) => boolean) => rows.filter(pick).length;
  const points = [
    { metric: "ai_answers_checked", day, value: recent.length },
    { metric: "ai_answers_mentioned", day, value: count(recent, (row) => row.mentioned) },
    { metric: "ai_answers_cited", day, value: count(recent, (row) => row.cited) },
  ];
  for (const { engine } of AI_ANSWER_ENGINES) {
    const rows = recent.filter((row) => row.engine === engine);
    points.push({ metric: `ai_answers_checked.${engine}`, day, value: rows.length }, { metric: `ai_answers_mentioned.${engine}`, day, value: count(rows, (row) => row.mentioned) }, { metric: `ai_answers_cited.${engine}`, day, value: count(rows, (row) => row.cited) });
  }
  for (const domain of competitors) {
    points.push({ metric: `ai_answers_mentioned:${domain}`, day, value: count(recent, (row) => row.rivals.some((rival) => rival.domain === domain && rival.mentioned)) },
      { metric: `ai_answers_cited:${domain}`, day, value: count(recent, (row) => row.rivals.some((rival) => rival.domain === domain && rival.cited)) });
  }
  return points;
}

export type AiAnswersView = {
  prompts: number;
  markets: string[];
  /** Cells (question × market × engine) with an answer. */
  checked: number;
  /** The latest day any current cell was checked. */
  asOf: string | null;
  totals: { mentioned: number; cited: number };
  engines: Array<{ engine: AiAnswerEngine; label: string; checked: number; mentioned: number; cited: number }>;
  rows: Array<{ prompt: string; market: string; cells: Partial<Record<AiAnswerEngine, AiAnswerCheck>> }>;
  /** Answers naming or citing the site and each competitor; share of their sum. */
  shareOfVoice: Array<{ domain: string; site: boolean; answers: number; share: number | null }>;
  /** Source domains by the number of answers citing them, top 10. */
  topDomains: Array<{ domain: string; answers: number; kind: "site" | "competitor" | "other" }>;
  /** The last 12 Monday weeks, oldest first: each cell counted once a week, its later check. */
  weeks: Array<{ week: string; checked: number; mentioned: number; cited: number }>;
  /** Google AI Overviews in the checked search results, and those citing the site. */
  overview: { searches: number; citesYou: number };
};

const mondayOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

/** The AI answers card: the latest answer per question, market and engine, and what they add up to. */
export function aiAnswersView(input: { prompts: string[]; markets: string[]; checks: AiAnswerCheck[]; site: string; competitors: string[]; today: string; overview: { searches: number; citesYou: number } }): AiAnswersView {
  const latest = latestChecks(input.checks, input.prompts, input.markets);
  const count = (rows: AiAnswerCheck[], pick: (row: AiAnswerCheck) => boolean) => rows.filter(pick).length;
  const cellOf = new Map(latest.map((check) => [`${check.prompt}|${check.market}|${check.engine}`, check]));
  const rows = input.prompts.flatMap((prompt) => input.markets.map((market) => {
    const cells: Partial<Record<AiAnswerEngine, AiAnswerCheck>> = {};
    for (const { engine } of AI_ANSWER_ENGINES) {
      const check = cellOf.get(`${prompt}|${market}|${engine}`);
      if (check) cells[engine] = check;
    }
    return { prompt, market, cells };
  }));

  const site = bareDomain(input.site);
  const siteAnswers = count(latest, (row) => row.mentioned || row.cited);
  const rivals = input.competitors.map((domain) => ({
    domain, site: false,
    answers: count(latest, (row) => row.rivals.some((rival) => rival.domain === bareDomain(domain) && (rival.mentioned || rival.cited))),
  })).sort((a, b) => b.answers - a.answers);
  const voices = [{ domain: input.site, site: true, answers: siteAnswers }, ...rivals];
  const total = voices.reduce((sum, voice) => sum + voice.answers, 0);

  const cites = new Map<string, number>();
  for (const check of latest) {
    for (const domain of new Set(check.sources.map((source) => bareDomain(source.domain)))) cites.set(domain, (cites.get(domain) ?? 0) + 1);
  }
  const topDomains = [...cites].map(([domain, answers]) => ({
    domain, answers,
    kind: site && isOrUnder(domain, site) ? "site" as const : input.competitors.some((rival) => isOrUnder(domain, bareDomain(rival))) ? "competitor" as const : "other" as const,
  })).sort((a, b) => b.answers - a.answers || a.domain.localeCompare(b.domain)).slice(0, 10);

  // Every check of a current cell, keyed by its week: a cell's later check in a week replaces the earlier.
  const thisWeek = mondayOf(input.today);
  const weekStarts = Array.from({ length: 12 }, (_, index) => addDays(thisWeek, -7 * (11 - index)));
  const byWeek = new Map(weekStarts.map((week) => [week, new Map<string, AiAnswerCheck>()]));
  for (const check of input.checks) {
    if (!input.prompts.includes(check.prompt) || !input.markets.includes(check.market)) continue;
    const cells = byWeek.get(mondayOf(check.day));
    const key = `${check.prompt}|${check.market}|${check.engine}`;
    const seen = cells?.get(key);
    if (cells && (!seen || check.day > seen.day)) cells.set(key, check);
  }
  const weeks = weekStarts.map((week) => {
    const cells = [...byWeek.get(week)!.values()];
    return { week, checked: cells.length, mentioned: count(cells, (row) => row.mentioned), cited: count(cells, (row) => row.cited) };
  });

  return {
    prompts: input.prompts.length,
    markets: input.markets,
    checked: latest.length,
    asOf: latest.reduce<string | null>((max, check) => (max === null || check.day > max ? check.day : max), null),
    totals: { mentioned: count(latest, (row) => row.mentioned), cited: count(latest, (row) => row.cited) },
    engines: AI_ANSWER_ENGINES.map(({ engine, label }) => {
      const mine = latest.filter((row) => row.engine === engine);
      return { engine, label, checked: mine.length, mentioned: count(mine, (row) => row.mentioned), cited: count(mine, (row) => row.cited) };
    }),
    rows,
    shareOfVoice: voices.map((voice) => ({ ...voice, share: total ? voice.answers / total : null })),
    topDomains,
    weeks,
    overview: input.overview,
  };
}
