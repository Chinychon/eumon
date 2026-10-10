import { AI_PROBE_AGENTS, CHECKS, finding, type Finding } from "@organic-growth/core";
import { isBotChallenge, type Fetcher } from "./index.js";
import { parseRobots } from "./robots.js";

/*
 * What a firewall does to AI crawlers that robots.txt allows, and how the
 * host answers: the other host form, the HTTP homepage, HSTS, and llms.txt.
 * One analysis step: 7 agents × up to 6 pages, plus 4 host fetches.
 */

export type AiProbe = { agent: string; search: boolean; allowedByRobots: boolean; fetched: number; refused: number; challenge: boolean };
export type HostProbe = { wwwDuplicate: boolean; httpRedirected: boolean | null; hsts: boolean; llmsTxt: "missing" | "present" | "malformed" };
export type HostProbeResult = { ai: AiProbe[]; host: HostProbe; robotsReadable: boolean };

/** Statuses a firewall or rate limiter answers with. */
const REFUSED = new Set([401, 403, 429, 503]);

/** Fetches each page as each AI agent robots.txt allows it (`robotsTxt` null: no rules), and counts refusals and challenge pages. */
export async function probeAiCrawlers(urls: string[], robotsTxt: string | null, fetcher: Fetcher): Promise<AiProbe[]> {
  const out: AiProbe[] = [];
  // One agent at a time, its pages together: at most six requests in flight.
  for (const entry of AI_PROBE_AGENTS) {
    const policy = robotsTxt ? parseRobots(robotsTxt, entry.agent.toLowerCase(), { exact: true }) : null;
    const allowed = urls.filter((url) => !policy || policy.isAllowed(new URL(url).pathname));
    const results = await Promise.all(allowed.map((url) => fetcher(url, { userAgent: entry.userAgent }).catch(() => null)));
    let refused = 0;
    let challenge = false;
    for (const result of results) {
      if (!result || REFUSED.has(result.status)) refused++;
      if (result && isBotChallenge(result)) challenge = true;
    }
    out.push({ agent: entry.agent, search: entry.search, allowedByRobots: !policy || policy.isAllowed("/"), fetched: allowed.length, refused, challenge });
  }
  return out;
}

const looksLikeLlmsTxt = (body: string) => /^\s*#\s+\S/.test(body) && !/^\s*<(!doctype|html)/i.test(body);
const bareHost = (hostname: string) => hostname.replace(/^www\./, "");

/** The other host form (with or without www), the HTTP homepage, HSTS on the homepage, and /llms.txt. */
export async function probeHost(baseUrl: string, fetcher: Fetcher): Promise<HostProbe> {
  const site = new URL(baseUrl);
  const otherHost = site.hostname.startsWith("www.") ? site.hostname.slice(4) : `www.${site.hostname}`;
  const [home, other, http, llms] = await Promise.all([
    fetcher(`${site.origin}/`).catch(() => null),
    fetcher(`${site.protocol}//${otherHost}/`).catch(() => null),
    site.protocol === "https:" ? fetcher(`http://${site.host}/`).catch(() => null) : Promise.resolve(null),
    fetcher(`${site.origin}/llms.txt`, { maxBytes: 200_000 }).catch(() => null),
  ]);
  return {
    // Answering 200 at its own address, rather than redirecting to the site's.
    wwwDuplicate: Boolean(other && other.status === 200 && new URL(other.finalUrl || other.url).hostname === otherHost),
    httpRedirected: http ? new URL(http.finalUrl || http.url).protocol === "https:" && bareHost(new URL(http.finalUrl || http.url).hostname) === bareHost(site.hostname) : null,
    hsts: Boolean(home?.headers["strict-transport-security"]),
    llmsTxt: !llms || llms.status !== 200 || !llms.body.trim() ? "missing" : looksLikeLlmsTxt(llms.body) ? "present" : "malformed",
  };
}

/** Findings from the probe: AI search crawlers refused on every page robots.txt lets them read, and the host checks. */
export function findingsFromHostProbe(input: { siteId: string; analysisId: string; probe: HostProbeResult | undefined }): Finding[] {
  if (!input.probe) return [];
  const { ai, host } = input.probe;
  const base = { siteId: input.siteId, analysisId: input.analysisId };
  const out: Finding[] = [];
  const refused = ai.filter((agent) => agent.search && agent.allowedByRobots && agent.fetched > 0 && agent.refused === agent.fetched);
  if (refused.length) {
    const challenged = refused.some((agent) => agent.challenge);
    out.push(finding(CHECKS["ai.crawler_refused"]!, {
      ...base, impact: 75,
      title: `The firewall refuses ${refused.map((agent) => agent.agent).join(", ")}`,
      summary: `robots.txt allows ${refused.map((agent) => agent.agent).join(", ")}, but every page probed refused ${refused.length === 1 ? "it" : "them"}${challenged ? " with a bot challenge (Cloudflare's AI crawler setting blocks them by default on new zones)" : ""}. Those assistants cannot read or cite the site.`,
      evidence: { refused: refused.map((agent) => ({ agent: agent.agent, pages: agent.fetched, challenge: agent.challenge })) },
    }));
  }
  if (host.wwwDuplicate) {
    out.push(finding(CHECKS["server.www_duplicate"]!, { ...base, impact: 40, title: "The site answers at both www and the bare domain", summary: "The other host form answers 200 itself instead of redirecting to the site's address, so every page exists twice and its signals split between them.", evidence: { host } }));
  }
  if (host.httpRedirected === false) {
    out.push(finding(CHECKS["server.http_not_redirected"]!, { ...base, impact: 70, title: "The HTTP homepage does not redirect to HTTPS", summary: "http:// requests are served or sent elsewhere instead of being redirected to the https:// site, so visitors and crawlers can stay on an insecure copy.", evidence: { host } }));
  }
  if (!host.hsts) {
    out.push(finding(CHECKS["security.hsts_missing"]!, { ...base, impact: 10, title: "The homepage sends no HSTS header", summary: "Without Strict-Transport-Security, browsers may try the HTTP version first. A security hardening, not a ranking factor.", evidence: { host } }));
  }
  if (host.llmsTxt === "missing") {
    out.push(finding(CHECKS["ai.llms_txt"]!, { ...base, impact: 5, title: "No llms.txt", summary: "The site publishes no /llms.txt. It is optional: no AI engine has confirmed reading it, and it never affects the score.", evidence: { llmsTxt: "missing" } }));
  } else if (host.llmsTxt === "malformed") {
    out.push(finding(CHECKS["ai.llms_txt_format"]!, { ...base, impact: 5, title: "llms.txt is not Markdown", summary: "/llms.txt answers, but not with Markdown starting with an H1 (often an HTML page served at that path).", evidence: { llmsTxt: "malformed" } }));
  }
  return out;
}
