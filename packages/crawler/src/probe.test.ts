import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findingsFromHostProbe, probeAiCrawlers, probeHost, type AiProbe, type HostProbe } from "./probe.js";
import type { Fetcher } from "./index.js";

const robots = "User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n";
const site = (status: (userAgent: string, url: string) => number): Fetcher => async (url, init) => {
  const code = status(init?.userAgent ?? "", url);
  return { url, finalUrl: url, status: code, headers: (code === 403 ? { "cf-mitigated": "challenge" } : {}) as Record<string, string>, body: code === 403 ? "<title>Just a moment...</title>" : "<html><body><main>ok</main></body></html>" };
};
const urls = ["https://x.com/", "https://x.com/a"];

describe("probeAiCrawlers", () => {
  it("fetches each page as each AI agent robots.txt allows, and counts refusals", async () => {
    const result = await probeAiCrawlers(urls, robots, site((ua) => (/PerplexityBot/.test(ua) ? 403 : 200)));
    assert.deepEqual(result.find((p) => p.agent === "PerplexityBot"), { agent: "PerplexityBot", search: true, allowedByRobots: true, fetched: 2, refused: 2, challenge: true });
    assert.deepEqual(result.find((p) => p.agent === "GPTBot"), { agent: "GPTBot", search: false, allowedByRobots: false, fetched: 0, refused: 0, challenge: false }, "robots-blocked agents are not fetched");
    assert.equal(result.find((p) => p.agent === "OAI-SearchBot")!.refused, 0);
    assert.equal(result.length, 7);
  });

  it("counts one refused page as one, not a policy", async () => {
    const result = await probeAiCrawlers(urls, robots, site((ua, url) => (/ClaudeBot/.test(ua) && url.endsWith("/a") ? 429 : 200)));
    assert.equal(result.find((p) => p.agent === "ClaudeBot")!.refused, 1);
  });

  it("counts a fetch that throws as refused", async () => {
    const result = await probeAiCrawlers(urls, null, async () => { throw new Error("reset"); });
    assert.equal(result.find((p) => p.agent === "OAI-SearchBot")!.refused, 2);
  });
});

describe("probeHost", () => {
  it("checks the other host form, the HTTP homepage, HSTS and llms.txt", async () => {
    const fetcher: Fetcher = async (url) => {
      if (url.startsWith("http://")) return { url, finalUrl: "https://x.com/", status: 200, headers: {}, body: "" };
      if (url.startsWith("https://www.")) return { url, finalUrl: url, status: 200, headers: {}, body: "<html></html>" };
      if (url.endsWith("/llms.txt")) return { url, finalUrl: url, status: 200, headers: {}, body: "# X\n> about\n## Docs\n- [a](/a)\n" };
      return { url, finalUrl: url, status: 200, headers: { "strict-transport-security": "max-age=1" } as Record<string, string>, body: "<html></html>" };
    };
    assert.deepEqual(await probeHost("https://x.com", fetcher), { wwwDuplicate: true, httpRedirected: true, hsts: true, llmsTxt: "present" });
  });

  it("treats a redirect to the site, an unreachable host and an HTML llms.txt correctly", async () => {
    const fetcher: Fetcher = async (url) => {
      if (url.startsWith("https://www.")) return { url, finalUrl: "https://x.com/", status: 200, headers: {}, body: "" };
      if (url.startsWith("http://")) throw new Error("refused");
      if (url.endsWith("/llms.txt")) return { url, finalUrl: url, status: 200, headers: {}, body: "<!doctype html><html></html>" };
      return { url, finalUrl: url, status: 200, headers: {}, body: "<html></html>" };
    };
    assert.deepEqual(await probeHost("https://x.com", fetcher), { wwwDuplicate: false, httpRedirected: null, hsts: false, llmsTxt: "malformed" });
  });
});

describe("findingsFromHostProbe", () => {
  const host: HostProbe = { wwwDuplicate: false, httpRedirected: true, hsts: true, llmsTxt: "present" };
  const refused = (agent: string, search: boolean, refusedCount: number): AiProbe => ({ agent, search, allowedByRobots: true, fetched: 3, refused: refusedCount, challenge: true });
  const ids = (ai: AiProbe[], over: Partial<HostProbe> = {}) => findingsFromHostProbe({ siteId: "s", analysisId: "a", probe: { ai, host: { ...host, ...over }, robotsReadable: true } }).map((f) => f.checkId);

  it("reports a firewall that refuses a search crawler robots.txt allows, on every page", () => {
    assert.deepEqual(ids([refused("PerplexityBot", true, 3)]), ["ai.crawler_refused"]);
    assert.deepEqual(ids([refused("PerplexityBot", true, 1)]), [], "one refused page is rate limiting");
    assert.deepEqual(ids([refused("GPTBot", false, 3)]), [], "training crawlers are not reported");
  });

  it("names Cloudflare when the refusal was its challenge", () => {
    const [found] = findingsFromHostProbe({ siteId: "s", analysisId: "a", probe: { ai: [refused("PerplexityBot", true, 3)], host, robotsReadable: true } });
    assert.match(found!.summary, /PerplexityBot/);
    assert.match(found!.summary, /challenge/);
  });

  it("reports the host checks", () => {
    assert.deepEqual(ids([], { wwwDuplicate: true, httpRedirected: false, hsts: false, llmsTxt: "malformed" }), ["server.www_duplicate", "server.http_not_redirected", "security.hsts_missing", "ai.llms_txt_format"]);
    assert.deepEqual(ids([], { llmsTxt: "missing" }), ["ai.llms_txt"]);
    assert.deepEqual(ids([], { httpRedirected: null }), [], "an unreachable HTTP homepage is not a finding");
  });
});
