import type { RouteRef } from "./types.js";

// ponytail: a fixed list of locale prefixes; read the site's real locales from the crawl when a site uses others.
const LOCALE = /^\/(id|ms|zh|th|vi|km|en|ja|ko|ar|tl|my|lo)(?=\/|$)/i;

export function pathOf(url: string): string | null {
  try { return new URL(url).pathname.replace(/\/+$/, "") || "/"; } catch { return null; }
}

export function stripLocale(path: string): { locale: string | null; path: string } {
  const match = LOCALE.exec(path);
  return match ? { locale: match[1]!.toLowerCase(), path: path.slice(match[0].length) || "/" } : { locale: null, path };
}

// ponytail: `:x` matches one segment, so a catch-all `[...x]` route only matches single-segment paths.
export function patternRegex(pattern: string): RegExp {
  if (pattern === "/") return /^\/?$/;
  const body = pattern.split("/").filter(Boolean)
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/");
  return new RegExp(`^/${body}/?$`);
}

// Next.js precedence: left to right, the first segment where two routes differ, static beats dynamic. Negative means `a` wins, 0 a tie.
function compare(a: string, b: string): number {
  const x = a.split("/").filter(Boolean), y = b.split("/").filter(Boolean);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const dx = x[i]!.startsWith(":"), dy = y[i]!.startsWith(":");
    if (dx !== dy) return dx ? 1 : -1;
  }
  return 0;
}

/** The route Next.js would serve, or undefined when none matches or two match with no winner. */
export function routeForPath(path: string, routes: RouteRef[]): RouteRef | undefined {
  const hits = routes.filter((route) => patternRegex(route.pathPattern).test(path));
  return hits.find((r) => hits.every((o) => o === r || compare(r.pathPattern, o.pathPattern) < 0));
}
