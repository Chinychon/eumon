import { defaultFetcher, type Fetcher, type FetchResult } from "@organic-growth/crawler";
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, SCRAPER_USER_AGENT, type RobotsPolicy } from "./robots.js";

/**
 * Fetches pages as EumonBot with robots.txt enforced per origin. One instance
 * should be used per scrape step so robots.txt is fetched once per host.
 */
export class PoliteFetcher {
  private readonly robots = new Map<string, Promise<RobotsPolicy>>();

  constructor(private readonly fetcher: Fetcher = defaultFetcher) {}

  policy(url: string): Promise<RobotsPolicy> {
    const origin = new URL(url).origin;
    let policy = this.robots.get(origin);
    if (!policy) {
      policy = this.fetcher(`${origin}/robots.txt`, { userAgent: SCRAPER_USER_AGENT, maxBytes: 500_000 })
        .then((response) => {
          if (response.status >= 500) return DISALLOW_ALL;
          if (response.status >= 400) return ALLOW_ALL;
          return parseRobots(response.body);
        })
        .catch(() => DISALLOW_ALL);
      this.robots.set(origin, policy);
    }
    return policy;
  }

  async isAllowed(url: string): Promise<boolean> {
    const parsed = new URL(url);
    return (await this.policy(url)).isAllowed(`${parsed.pathname}${parsed.search}`);
  }

  /** Fetches a URL, throwing `RobotsBlockedError` when robots.txt disallows it. */
  async fetch(url: string, maxBytes?: number): Promise<FetchResult> {
    if (!(await this.isAllowed(url))) throw new RobotsBlockedError(url);
    return this.fetcher(url, { userAgent: SCRAPER_USER_AGENT, maxBytes });
  }
}

export class RobotsBlockedError extends Error {
  constructor(readonly url: string) {
    super(`robots.txt disallows ${url}`);
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
