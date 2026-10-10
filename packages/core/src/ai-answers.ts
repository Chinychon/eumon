/*
 * AI answer tracking, pure: the questions users ask AI assistants, and what an
 * assistant's answer says about the site — whether it names the brand
 * ("mentioned"), links the site among its sources ("cited"), and which
 * competitors it names or cites instead.
 */

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
