/*
 * AI answer tracking, pure: the questions users ask AI assistants, and what an
 * assistant's answer says about the site — whether it names the brand
 * ("mentioned"), links the site among its sources ("cited"), and which
 * competitors it names or cites instead.
 */

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
