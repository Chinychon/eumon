import { RESEARCH_TOKEN, parseRobots as parseRobotsFor, type RobotsPolicy } from "@organic-growth/crawler";

export { ALLOW_ALL, DISALLOW_ALL, type RobotsPolicy } from "@organic-growth/crawler";

/** Product token Eumon identifies itself with when collecting third-party data. */
export { RESEARCH_USER_AGENT as SCRAPER_USER_AGENT, RESEARCH_TOKEN as SCRAPER_TOKEN } from "@organic-growth/crawler";

/** robots.txt rules as they apply to EumonBot (or another crawler `token`). */
export function parseRobots(body: string, token = RESEARCH_TOKEN): RobotsPolicy {
  return parseRobotsFor(body, token);
}
