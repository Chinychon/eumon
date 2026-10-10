/*
 * Who reads a page on behalf of AI assistants, and where AI-sent visitors
 * come from. One table drives the request counter (which crawler fetched a
 * landing page), the landing-page beacon (which assistant sent a visitor),
 * the robots.txt verdicts in an analysis, and the AI visibility radar, so
 * every place names engines the same way.
 */

/** The radar's axes, in a fixed order so trends and shapes stay comparable. */
export const AI_ENGINES = [
  { engine: "openai", label: "OpenAI" },
  { engine: "anthropic", label: "Anthropic" },
  { engine: "perplexity", label: "Perplexity" },
  { engine: "meta", label: "Meta" },
  { engine: "google", label: "Gemini / Google" },
  { engine: "commoncrawl", label: "Common Crawl" },
  { engine: "deepseek", label: "DeepSeek" },
  { engine: "other", label: "Others" },
] as const;

export type AiEngine = (typeof AI_ENGINES)[number]["engine"];

/**
 * `crawler`: collects pages ahead of time, for training or an AI search index.
 * `live`: fetches a page while an assistant answers a person, so each one is a
 * question the page was used to answer.
 */
export type AiFetchKind = "crawler" | "live";

export type AiAgent = {
  /** The product token as it appears in the user agent and in robots.txt. */
  agent: string;
  engine: AiEngine;
  kind: AiFetchKind;
  /** What the site's owner should know about blocking it. */
  purpose: string;
  /** A crawler that feeds AI answers (an AI search index), so blocking it hides the site from those answers. Live fetchers always do. */
  search?: boolean;
};

/**
 * AI user agents worth counting, from each operator's published crawler docs.
 * Gemini's answers and AI Overviews fetch as Googlebot (counted under Search);
 * Google's other AI fetchers, GoogleOther and Vertex AI, are its axis here.
 * `Google-Extended` (like `Applebot-Extended`) is only a robots.txt token, so
 * both appear in `AI_ROBOTS_TOKENS`, not here.
 */
export const AI_AGENTS: AiAgent[] = [
  { agent: "ChatGPT-User", engine: "openai", kind: "live", purpose: "ChatGPT opening a page to answer someone" },
  { agent: "OAI-SearchBot", engine: "openai", kind: "crawler", purpose: "ChatGPT search results", search: true },
  { agent: "GPTBot", engine: "openai", kind: "crawler", purpose: "OpenAI model training" },
  { agent: "Claude-User", engine: "anthropic", kind: "live", purpose: "Claude opening a page to answer someone" },
  { agent: "Claude-SearchBot", engine: "anthropic", kind: "crawler", purpose: "Claude search results", search: true },
  { agent: "ClaudeBot", engine: "anthropic", kind: "crawler", purpose: "Anthropic model training" },
  { agent: "anthropic-ai", engine: "anthropic", kind: "crawler", purpose: "Anthropic (older token)" },
  { agent: "Perplexity-User", engine: "perplexity", kind: "live", purpose: "Perplexity opening a page to answer someone" },
  { agent: "PerplexityBot", engine: "perplexity", kind: "crawler", purpose: "Perplexity search results", search: true },
  { agent: "Meta-ExternalFetcher", engine: "meta", kind: "live", purpose: "Meta AI opening a page to answer someone" },
  { agent: "Meta-ExternalAgent", engine: "meta", kind: "crawler", purpose: "Meta AI training and search", search: true },
  { agent: "GoogleOther", engine: "google", kind: "crawler", purpose: "Google's generic crawler, used by its product teams including AI research (Gemini's answers fetch as Googlebot)" },
  { agent: "Google-CloudVertexBot", engine: "google", kind: "crawler", purpose: "Google Vertex AI agents, fetching on a site owner's request" },
  { agent: "CCBot", engine: "commoncrawl", kind: "crawler", purpose: "Common Crawl, an open archive many AI models train on" },
  // DeepSeek publishes no crawler documentation; this is the token bot directories report seeing.
  { agent: "DeepSeekBot", engine: "deepseek", kind: "crawler", purpose: "DeepSeek (token reported by bot directories; DeepSeek documents none)" },
  { agent: "MistralAI-User", engine: "other", kind: "live", purpose: "Mistral's Le Chat opening a page to answer someone" },
  { agent: "DuckAssistBot", engine: "other", kind: "live", purpose: "DuckDuckGo's AI answers" },
  { agent: "Bytespider", engine: "other", kind: "crawler", purpose: "ByteDance model training" },
  { agent: "Amazonbot", engine: "other", kind: "crawler", purpose: "Amazon, including Alexa answers" },
];

/** robots.txt tokens that control AI use without a user agent of their own. */
export const AI_ROBOTS_TOKENS = [
  { agent: "Google-Extended", purpose: "Gemini and Google's AI training (Google's AI answers still use Googlebot)" },
  { agent: "Applebot-Extended", purpose: "Apple Intelligence training" },
];

/** Tokens checked in robots.txt for AI readiness: every counted agent, then the control-only tokens. `search` says whether blocking it hides the site from AI answers. */
export const AI_ROBOTS_CHECKS: Array<{ agent: string; purpose: string; kind: AiFetchKind | "control"; search: boolean }> = [
  ...AI_AGENTS.map((entry) => ({ agent: entry.agent, purpose: entry.purpose, kind: entry.kind, search: entry.kind === "live" || Boolean(entry.search) })),
  ...AI_ROBOTS_TOKENS.map((entry) => ({ ...entry, kind: "control" as const, search: false })),
];

/**
 * The agents an analysis fetches as, with the user-agent string each vendor
 * documents. The search-facing ones feed answers and are reported when a
 * firewall refuses them; the training ones are probed so the policy is
 * visible, never reported.
 */
export const AI_PROBE_AGENTS: Array<{ agent: string; userAgent: string; search: boolean }> = [
  { agent: "OAI-SearchBot", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot", search: true },
  { agent: "ChatGPT-User", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", search: true },
  { agent: "PerplexityBot", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", search: true },
  { agent: "Claude-SearchBot", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +https://www.anthropic.com/claude-searchbot)", search: true },
  { agent: "Claude-User", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +https://www.anthropic.com/claude-user)", search: true },
  { agent: "GPTBot", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot", search: false },
  { agent: "ClaudeBot", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", search: false },
];

/** Longest tokens first, so `Claude-SearchBot` is never read as `ClaudeBot` and `ChatGPT-User` wins over a generic match. */
const BY_LENGTH = [...AI_AGENTS].sort((a, b) => b.agent.length - a.agent.length);
const token = (agent: string) => new RegExp(`(^|[^a-z0-9-])${agent.replace(/[-]/g, "\\-")}([^a-z0-9-]|$)`, "i");
const AGENT_PATTERNS = BY_LENGTH.map((entry) => ({ entry, pattern: token(entry.agent) }));

export type UserAgentClass =
  | { kind: "googlebot" }
  | { kind: "ai"; agent: AiAgent }
  | { kind: "bot" }
  | null;

/**
 * What a request's user agent says it is: Googlebot first (as before), then
 * an AI agent, then any other bot; null is a person. It is a claim: nothing
 * verifies the user agent.
 */
export function classifyUserAgent(userAgent: string): UserAgentClass {
  if (/googlebot|google-inspectiontool|storebot-google/i.test(userAgent)) return { kind: "googlebot" };
  const match = AGENT_PATTERNS.find(({ pattern }) => pattern.test(userAgent));
  if (match) return { kind: "ai", agent: match.entry };
  if (/bot|crawler|spider|slurp|bingpreview|facebookexternalhit|embedly|preview/i.test(userAgent)) return { kind: "bot" };
  return null;
}

/** Assistants that send visitors, by the referrer host or `utm_source` they leave. */
export const AI_ASSISTANTS = [
  { assistant: "chatgpt", label: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com"] },
  { assistant: "perplexity", label: "Perplexity", hosts: ["perplexity.ai"] },
  { assistant: "gemini", label: "Gemini", hosts: ["gemini.google.com", "bard.google.com"] },
  { assistant: "copilot", label: "Copilot", hosts: ["copilot.microsoft.com", "copilot.com"] },
  { assistant: "claude", label: "Claude", hosts: ["claude.ai"] },
  { assistant: "meta", label: "Meta AI", hosts: ["meta.ai"] },
  { assistant: "deepseek", label: "DeepSeek", hosts: ["chat.deepseek.com", "deepseek.com"] },
] as const;

export type AiAssistant = (typeof AI_ASSISTANTS)[number]["assistant"];

// Google's search host only: Docs, Gmail, Ads and Maps live on other google.* hosts and are not search engines.
const SEARCH_HOSTS = [/^(www\.)?google\.[a-z.]+$/, /(^|\.)bing\.com$/, /(^|\.)duckduckgo\.com$/, /(^|\.)search\.yahoo\.com$/, /(^|\.)yandex\.[a-z.]+$/, /(^|\.)ecosia\.org$/, /(^|\.)baidu\.com$/];

const hostMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** The assistant a referrer host or `utm_source` value names, if any. */
export function aiAssistantFrom(value: string | null | undefined): AiAssistant | null {
  const text = (value ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!text) return null;
  for (const entry of AI_ASSISTANTS) {
    if (entry.hosts.some((domain) => hostMatches(text, domain))) return entry.assistant;
    // utm_source is often the bare product name ("chatgpt", "perplexity").
    if (text === entry.assistant || text === entry.label.toLowerCase().replace(/\s+/g, "")) return entry.assistant;
  }
  return null;
}

/** Where a session started: an AI assistant, a search engine, or anything else. Stored once, on the session's first landing. */
export type LandingSource = `ai:${AiAssistant}` | "search" | "other";

export function landingSource(referrerHost: string | null | undefined, utmSource?: string | null): LandingSource {
  const assistant = aiAssistantFrom(utmSource) ?? aiAssistantFrom(referrerHost);
  if (assistant) return `ai:${assistant}`;
  const host = (referrerHost ?? "").trim().toLowerCase();
  if (host && SEARCH_HOSTS.some((pattern) => pattern.test(host))) return "search";
  return "other";
}
