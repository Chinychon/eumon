/**
 * Compiles a path glob into a matcher. `*` matches one path segment, `**`
 * matches any number of segments, and a trailing `/` is optional:
 * `/doctors/*` matches `/doctors/jane-tan` but not `/doctors/jane-tan/reviews`.
 */
export function compilePathPattern(pattern: string): (url: string) => boolean {
  const normalized = pattern.trim().replace(/\/+$/, "") || "/";
  const regex = normalized
    .split(/(\*\*|\*)/)
    .map((part) => (part === "**" ? ".*" : part === "*" ? "[^/]+" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  const compiled = new RegExp(`^${regex}/?$`, "i");
  return (url: string) => {
    try {
      return compiled.test(new URL(url).pathname);
    } catch {
      return compiled.test(url);
    }
  };
}

/**
 * Groups URLs by their route shape (`/doctors/jane` → `/doctors/*`), most
 * common first. Used to suggest the site's own detail pages as data sources.
 */
export function summarizeRoutePatterns(urls: string[], limit = 12): Array<{ pattern: string; count: number; examples: string[] }> {
  const groups = new Map<string, string[]>();
  for (const url of urls) {
    let segments: string[];
    try {
      segments = new URL(url).pathname.split("/").filter(Boolean);
    } catch {
      continue;
    }
    if (segments.length < 2) continue;
    const pattern = `/${segments.slice(0, -1).join("/")}/*`;
    const bucket = groups.get(pattern) ?? [];
    bucket.push(url);
    groups.set(pattern, bucket);
  }
  return [...groups.entries()]
    .map(([pattern, members]) => ({ pattern, count: members.length, examples: members.slice(0, 3) }))
    .filter((group) => group.count >= 5)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
