/*
 * AI answer tracking, pure: the questions users ask AI assistants, and what an
 * assistant's answer says about the site — whether it names the brand
 * ("mentioned"), links the site among its sources ("cited"), and which
 * competitors it names or cites instead.
 */

import { bareDomain } from "./serp.js";

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

const isOrUnder = (domain: string, root: string) => domain === root || domain.endsWith(`.${root}`);
/** "brightsmile.example" → "brightsmile"; "rival-dental.example" → "rival-dental". */
const domainLabel = (domain: string) => bareDomain(domain).split(".")[0] ?? domain;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A whole-word pattern for a name; a hyphen or space in it matches either, or nothing; names of three characters or fewer match only in their exact case. */
function namePattern(name: string): RegExp {
  const body = escapeRegExp(name.trim()).replace(/[\s-]+/g, "[\\s-]?");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${body}($|[^\\p{L}\\p{N}])`, name.trim().length <= 3 ? "u" : "iu");
}

function firstMention(text: string, names: string[]): number {
  let first = -1;
  for (const name of names) {
    const match = namePattern(name).exec(text);
    if (match) {
      const at = match.index + match[1]!.length;
      if (first < 0 || at < first) first = at;
    }
  }
  return first;
}

const EXCERPT = 600;

/** What one answer says about the site: mentioned (a brand name, the domain or its label in the text), cited (a source on the site's domain), and which competitors it names or cites. */
export function readAnswer(input: { text: string; sources: AiSource[]; brandNames: string[]; site: string; competitors: string[] }) {
  const site = bareDomain(input.site);
  const names = [...new Set([...input.brandNames, site, domainLabel(site)])].filter((name) => name.trim().length >= 2);
  const at = firstMention(input.text, names);
  const domains = [...new Set(input.sources.map((source) => bareDomain(source.domain)))];
  const rank = domains.findIndex((domain) => isOrUnder(domain, site));
  const rivals: AiRival[] = input.competitors.map((competitor) => {
    const domain = bareDomain(competitor);
    return { domain, mentioned: firstMention(input.text, [domain, domainLabel(domain)]) >= 0, cited: domains.some((source) => isOrUnder(source, domain)) };
  }).filter((rival) => rival.mentioned || rival.cited);
  const start = at < 0 ? 0 : Math.max(0, Math.min(at - EXCERPT / 2, input.text.length - EXCERPT));
  return { mentioned: at >= 0, cited: rank >= 0, citedRank: rank >= 0 ? rank + 1 : null, rivals, excerpt: input.text.slice(start, start + EXCERPT) };
}
