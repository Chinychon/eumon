import type { JsonObject, JsonValue } from "@organic-growth/core";
import { decodeEntities, findTags, hasToken } from "@organic-growth/crawler";

export { decodeEntities } from "@organic-growth/crawler";

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Every JSON-LD object on the page, with `@graph` containers flattened. */
export function extractJsonLd(html: string): JsonObject[] {
  const output: JsonObject[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    try {
      collect(JSON.parse(match[1]!.trim()) as JsonValue, output);
    } catch {
      // Malformed JSON-LD is common; skip it rather than fail the page.
    }
  }
  return output;
}

function collect(value: JsonValue, output: JsonObject[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, output);
  } else if (value && typeof value === "object") {
    const graph = value["@graph"];
    if (Array.isArray(graph)) collect(graph, output);
    else output.push(value);
  }
}

export type PageMeta = {
  title?: string;
  h1?: string;
  description?: string;
  image?: string;
  themeColor?: string;
  canonical?: string;
};

export function extractMeta(html: string): PageMeta {
  const head = html.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const metas = findTags(head, "meta");
  const meta = (key: "name" | "property", value: string) =>
    metas.find((tag) => tag[key]?.toLowerCase() === value)?.content?.trim() || undefined;
  const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const h1 = head.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  return {
    title: title ? stripTags(title) : undefined,
    h1: h1 ? stripTags(h1) : undefined,
    description: meta("name", "description"),
    image: meta("property", "og:image"),
    themeColor: meta("name", "theme-color"),
    canonical: findTags(head, "link").find((link) => hasToken(link.rel, "canonical") && link.href)?.href.trim(),
  };
}

/**
 * Converts HTML to compact, structure-preserving text for extraction:
 * headings, list items, and table rows keep their shape, while scripts,
 * navigation, and page chrome are dropped. Prefers `<main>`/`<article>`.
 */
export function htmlToText(html: string, maxChars = 15_000): string {
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|form)\b[\s\S]*?<\/\1>/gi, " ");
  const main = body.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    ?? body.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  if (main && stripTags(main).length > 200) body = main;
  else body = body.replace(/<(nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, " ");

  const text = body
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => `\n${"#".repeat(Number(level))} ${stripTags(inner)}\n`)
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_m, inner: string) => {
      const cells = [...inner.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => stripTags(cell[1]!));
      return `\n| ${cells.join(" | ")} |`;
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${stripTags(inner)}`)
    .replace(/<(br|\/p|\/div|\/section|\/dd|\/dt)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, maxChars);
}

/** Absolute same-origin links with fragments removed. */
export function extractLinks(html: string, pageUrl: string): string[] {
  const origin = new URL(pageUrl).origin;
  const links = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"'#]+)(?:#[^"']*)?["']/gi)) {
    try {
      const url = new URL(decodeEntities(match[1]!), pageUrl);
      if (url.origin === origin && /^https?:$/.test(url.protocol)) {
        url.hash = "";
        links.add(url.toString());
      }
    } catch {
      // Ignore unparsable hrefs such as `javascript:` or malformed values.
    }
  }
  return [...links];
}

const PAGE_PARAMS = ["page", "p", "pg", "paged", "pagenum", "offset"];

function pageNumber(url: URL): { param: string; value: number } | null {
  for (const param of PAGE_PARAMS) {
    const raw = url.searchParams.get(param);
    if (raw !== null && /^\d+$/.test(raw)) return { param, value: Number(raw) };
  }
  const path = url.pathname.match(/\/page\/(\d+)\/?$/);
  return path ? { param: "/page/", value: Number(path[1]) } : null;
}

const basePath = (url: URL) => url.pathname.replace(/\/page\/\d+\/?$/, "/").replace(/\/+$/, "") || "/";

/**
 * The next page of a paginated list. Understands `rel="next"`, links labelled
 * "next", and numbered pagers (`?page=2`, `?page=1` in zero-based Drupal
 * views, WordPress `/page/2/`), so lists are read past their first page.
 */
export function findNextPage(html: string, pageUrl: string): string | null {
  const here = new URL(pageUrl);
  const sameSite = (href: string): URL | null => {
    try {
      const url = new URL(decodeEntities(href), pageUrl);
      return url.origin === here.origin ? url : null;
    } catch {
      return null;
    }
  };

  const relNext = html.match(/<(?:a|link)\b[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<(?:a|link)\b[^>]*href=["']([^"']+)["'][^>]*rel=["']next["']/i)?.[1];
  const fromRel = relNext ? sameSite(relNext) : null;
  if (fromRel) return fromRel.toString();

  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].flatMap((match) => {
    const href = match[1]!.match(/href=["']([^"'#]+)["']/i)?.[1];
    const url = href ? sameSite(href) : null;
    return url ? [{ url, attrs: match[1]!, text: match[2]!.replace(/<[^>]+>/g, " ").trim() }] : [];
  });

  const labelled = anchors.find((anchor) =>
    /(title|aria-label)=["'][^"']*\bnext\b/i.test(anchor.attrs) || /^(next(\s+page)?|›|»|→|next\s*[›»→])$/i.test(anchor.text));
  if (labelled && labelled.url.toString() !== here.toString()) return labelled.url.toString();

  // Numbered pager: the smallest page number above the current one, on the same list.
  const pager = anchors.flatMap((anchor) => {
    const number = pageNumber(anchor.url);
    return number && basePath(anchor.url) === basePath(here) ? [{ ...anchor, number }] : [];
  });
  if (!pager.length) return null;
  const marked = pager.find((anchor) => /aria-current=["']page["']/i.test(anchor.attrs));
  const current = pageNumber(here)?.value ?? marked?.number.value ?? Math.min(...pager.map((anchor) => anchor.number.value)) - 1;
  const next = pager
    .filter((anchor) => anchor.number.value > current)
    .sort((a, b) => a.number.value - b.number.value)[0];
  return next ? next.url.toString() : null;
}
