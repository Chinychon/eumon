import { AI_ROBOTS_CHECKS, type AiFetchKind } from "@organic-growth/core";
import { parseRobots } from "./robots.js";

/*
 * Whether AI assistants may read the site: robots.txt as it applies to each
 * AI crawler and control token, whether the site publishes an llms.txt, and
 * how many sampled pages carry question-and-answer markup. Blocking an AI
 * crawler is a legitimate choice, so this is reported, never "fixed".
 */

export type AiReadiness = {
  /** `read`: robots.txt was fetched; `missing`: none (everything allowed); `unreadable`: an error or a page that isn't robots.txt. */
  robots: "read" | "missing" | "unreadable";
  crawlers: Array<{ agent: string; purpose: string; kind: AiFetchKind | "control"; allowed: boolean }>;
  llmsTxt: boolean;
  /** Sampled pages with FAQPage or QAPage structured data, of how many sampled. */
  faqPages: { pages: number; of: number };
};

type Fetched = { status: number; body: string; headers?: Record<string, string> } | null;

const looksLikeHtml = (body: string, headers?: Record<string, string>) =>
  /text\/html/i.test(headers?.["content-type"] ?? "") || /^\s*<(!doctype|html|head|body)/i.test(body);

/** How a robots.txt response reads: the body to parse, or why there is none. */
export function robotsState(response: Fetched): { robots: AiReadiness["robots"]; body?: string } {
  if (!response) return { robots: "unreadable" };
  if (response.status >= 400 && response.status < 500) return { robots: "missing" };
  if (response.status >= 300 || looksLikeHtml(response.body, response.headers)) return { robots: "unreadable" };
  return { robots: "read", body: response.body };
}

export function aiReadiness(input: { robots: Fetched; llms: Fetched; pages: Array<{ jsonLdTypes?: string[] }> }): AiReadiness {
  const { robots, body } = robotsState(input.robots);
  const crawlers = AI_ROBOTS_CHECKS.map((check) => ({
    ...check,
    // Unreadable robots.txt can't be judged; it is shown as allowed and the state says why.
    allowed: body ? parseRobots(body, check.agent.toLowerCase(), { exact: true }).isAllowed("/") : true,
  }));
  const llms = input.llms;
  return {
    robots,
    crawlers,
    llmsTxt: Boolean(llms && llms.status === 200 && llms.body.trim() && !looksLikeHtml(llms.body, llms.headers)),
    faqPages: {
      pages: input.pages.filter((page) => (page.jsonLdTypes ?? []).some((type) => /^(FAQPage|QAPage)$/i.test(type))).length,
      of: input.pages.length,
    },
  };
}
