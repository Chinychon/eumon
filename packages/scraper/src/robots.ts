import { parseRobots as parseRobotsFor, type RobotsPolicy } from "@organic-growth/crawler";

export { ALLOW_ALL, DISALLOW_ALL, type RobotsPolicy } from "@organic-growth/crawler";

/** Product token Eumon identifies itself with when collecting third-party data. */
export const SCRAPER_USER_AGENT = "EumonBot/0.1 (+organic growth research; respects robots.txt)";
export const SCRAPER_TOKEN = "eumonbot";

/** robots.txt rules as they apply to EumonBot (or another crawler `token`). */
export function parseRobots(body: string, token = SCRAPER_TOKEN): RobotsPolicy {
  return parseRobotsFor(body, token);
}
