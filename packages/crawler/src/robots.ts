/** Product token Google's main crawler matches in robots.txt. */
export const GOOGLEBOT_TOKEN = "googlebot";

type Rule = { allow: boolean; pattern: string };
type Group = { agents: string[]; rules: Rule[]; crawlDelay?: number };

export type RobotsPolicy = {
  isAllowed(pathAndQuery: string): boolean;
  /** Seconds between requests the site asks of this user agent, if any. */
  crawlDelay?: number;
  sitemaps: string[];
};

/**
 * Parses robots.txt per RFC 9309 for one crawler `token` (lower-case product
 * name, e.g. `googlebot`): the most specific matching user-agent group
 * applies, and within it the longest matching rule wins, with `allow` winning
 * ties. `*` and `$` wildcards are supported.
 */
export function parseRobots(body: string, token: string): RobotsPolicy {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const match = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!match) continue;
    const field = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      // An empty Disallow means "allow everything" and contributes no rule.
      if (value) current.rules.push({ allow: field === "allow", pattern: value });
    } else if (field === "crawl-delay") {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) current.crawlDelay = delay;
    }
  }

  const specific = groups.filter((group) => group.agents.some((agent) => agent !== "*" && token.includes(agent)));
  const applicable = specific.length ? specific : groups.filter((group) => group.agents.includes("*"));
  const rules = applicable.flatMap((group) => group.rules);
  const crawlDelay = applicable.map((group) => group.crawlDelay).find((delay) => delay !== undefined);

  return {
    sitemaps,
    crawlDelay,
    isAllowed(pathAndQuery: string) {
      if (pathAndQuery === "/robots.txt") return true;
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!ruleMatches(rule.pattern, pathAndQuery)) continue;
        if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
          best = rule;
        }
      }
      return best ? best.allow : true;
    },
  };
}

function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = body.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${regex}${anchored ? "$" : ""}`).test(path);
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** A policy that allows everything, used when robots.txt is missing (4xx). */
export const ALLOW_ALL: RobotsPolicy = { isAllowed: () => true, sitemaps: [] };

/** A policy that blocks everything, used when robots.txt is unreachable (5xx). */
export const DISALLOW_ALL: RobotsPolicy = { isAllowed: () => false, sitemaps: [] };
