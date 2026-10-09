import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AI_AGENTS, AI_ENGINES, aiAssistantFrom, classifyUserAgent, landingSource } from "./ai-agents.js";

const agentOf = (userAgent: string) => {
  const result = classifyUserAgent(userAgent);
  return result?.kind === "ai" ? result.agent.agent : result?.kind ?? null;
};

describe("AI agents", () => {
  it("names each AI crawler and live fetcher from its real user agent", () => {
    assert.equal(agentOf("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot"), "GPTBot");
    assert.equal(agentOf("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot"), "OAI-SearchBot");
    assert.equal(agentOf("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot"), "ChatGPT-User");
    assert.equal(agentOf("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)"), "ClaudeBot");
    assert.equal(agentOf("Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)"), "Claude-SearchBot");
    assert.equal(agentOf("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)"), "Claude-User");
    assert.equal(agentOf("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)"), "Perplexity-User");
    assert.equal(agentOf("meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)"), "Meta-ExternalAgent");
    assert.equal(agentOf("CCBot/2.0 (https://commoncrawl.org/faq/)"), "CCBot");
  });

  it("keeps Googlebot first, other bots generic, and people null", () => {
    assert.equal(agentOf("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), "googlebot");
    assert.equal(agentOf("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"), "bot");
    assert.equal(agentOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15"), null);
  });

  it("counts DeepSeek: its reported crawler token, its chat host as a referrer, and an axis of its own", () => {
    assert.equal(agentOf("Mozilla/5.0 (compatible; DeepSeekBot/1.0; +https://www.deepseek.com/bot)"), "DeepSeekBot");
    assert.equal(aiAssistantFrom("chat.deepseek.com"), "deepseek");
    assert.equal(aiAssistantFrom("deepseek"), "deepseek");
    assert.equal(landingSource("chat.deepseek.com"), "ai:deepseek");
    assert.ok(AI_ENGINES.some((entry) => entry.engine === "deepseek"), "radar axis");
  });

  it("maps every agent to a radar engine", () => {
    const engines = new Set(AI_ENGINES.map((entry) => entry.engine));
    for (const agent of AI_AGENTS) assert.ok(engines.has(agent.engine), agent.agent);
  });

  it("tells where a visit came from by referrer host or utm_source", () => {
    assert.equal(aiAssistantFrom("chatgpt.com"), "chatgpt");
    assert.equal(aiAssistantFrom("https://www.perplexity.ai/search"), "perplexity");
    assert.equal(aiAssistantFrom("chatgpt"), "chatgpt");
    assert.equal(aiAssistantFrom("google.com"), null);
    assert.equal(landingSource("gemini.google.com"), "ai:gemini");
    assert.equal(landingSource("www.google.com.my"), "search");
    assert.equal(landingSource("www.bing.com", "chatgpt.com"), "ai:chatgpt");
    assert.equal(landingSource("", null), "other");
    assert.equal(landingSource("facebook.com"), "other");
  });
});

import * as agents from "./ai-agents.js";

describe("AI agents, roles and referrers", () => {
  it("knows which blocked tokens matter for AI answers: live fetchers and search crawlers, not training or control tokens", () => {
    const check = (agent: string) => agents.AI_ROBOTS_CHECKS.find((entry) => entry.agent === agent)!;
    assert.equal(check("PerplexityBot").search, true);
    assert.equal(check("OAI-SearchBot").search, true);
    assert.equal(check("ChatGPT-User").search, true);
    assert.equal(check("GPTBot").search, false);
    assert.equal(check("Google-Extended").search, false);
  });

  it("counts only Google's search hosts as search engines, not Docs, Gmail or Ads", () => {
    assert.equal(agents.landingSource("www.google.com.my"), "search");
    assert.equal(agents.landingSource("google.com"), "search");
    assert.equal(agents.landingSource("docs.google.com"), "other");
    assert.equal(agents.landingSource("mail.google.com"), "other");
    assert.equal(agents.landingSource("gemini.google.com"), "ai:gemini");
  });
});
