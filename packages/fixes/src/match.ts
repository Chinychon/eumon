import type { RouteRef } from "./types.js";

// ponytail: a fixed list of locale prefixes; read the site's real locales from the crawl when a site uses others.
const LOCALE = /^\/(id|ms|zh|th|vi|km|en|ja|ko|ar|tl|my|lo)(?=\/|$)/i;

export function pathOf(url: string): string {
  try { return new URL(url).pathname.replace(/\/+$/, "") || "/"; } catch { return "/"; }
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

const staticSegments = (pattern: string) => pattern.split("/").filter((s) => s && !s.startsWith(":")).length;

export function routeForPath(path: string, routes: RouteRef[]): RouteRef | undefined {
  return routes.filter((route) => patternRegex(route.pathPattern).test(path))
    .sort((a, b) => staticSegments(b.pathPattern) - staticSegments(a.pathPattern))[0];
}
