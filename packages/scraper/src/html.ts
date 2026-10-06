import type { JsonObject, JsonValue } from "@organic-growth/core";
import { decodeEntities, elementSpans, findTags, hasToken, parseAttributes, stripElements } from "@organic-growth/crawler";

export { decodeEntities } from "@organic-growth/crawler";

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Every JSON-LD object on the page, with `@graph` containers flattened. */
export function extractJsonLd(html: string): JsonObject[] {
  const output: JsonObject[] = [];
  for (const script of elementSpans(html, ["script"])) {
    if (parseAttributes(script.attrs).type?.toLowerCase() !== "application/ld+json") continue;
    try {
      collect(JSON.parse(html.slice(script.contentStart, script.contentEnd).trim()) as JsonValue, output);
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
  const head = stripElements(html, ["script", "style", "noscript", "template", "svg"]);
  const metas = findTags(head, "meta");
  const meta = (key: "name" | "property", value: string) =>
    metas.find((tag) => tag[key]?.toLowerCase() === value)?.content?.trim() || undefined;
  const inner = (tag: string) => {
    const span = elementSpans(head, [tag])[0];
    return span ? head.slice(span.contentStart, Math.min(span.contentEnd, span.contentStart + 5000)) : undefined;
  };
  const title = inner("title");
  const h1 = inner("h1");
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
  // Linear-time element handling throughout: end tags such as </li>, </tr>,
  // and </p> are optional in HTML, and regex pairs rescan the whole page for
  // every unclosed one.
  let body = stripElements(html, ["script", "style", "noscript", "svg", "template", "iframe", "form"]);
  const container = elementSpans(body, ["main"])[0] ?? elementSpans(body, ["article"])[0];
  const main = container ? body.slice(container.contentStart, container.contentEnd) : undefined;
  if (main && stripTags(main).length > 200) body = main;
  else body = stripElements(body, ["nav", "footer", "header", "aside"]);

  const text = flattenBlocks(body)
    // Leftover markers for elements whose end tags were omitted.
    .replace(/<t[hd]\b[^>]{0,500}>/gi, " | ")
    .replace(/<(br|\/p|\/div|\/section|\/dd|\/dt|\/li|\/tr|\/h[1-6])\b[^>]{0,500}>/gi, "\n")
    .replace(/<[^>]{0,4000}>/g, " ");

  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .map((line) => (line.startsWith("|") && !line.endsWith("|") ? `${line} |` : line))
    .filter((line) => line && line !== "|" && line !== "-")
    .join("\n")
    .slice(0, maxChars);
}

/**
 * Puts each heading, list item, and table row on one line ("## Title",
 * "- item", "| a | b |"), whatever markup is inside it. Elements that are
 * never closed (end tags are optional for <li> and <tr>) or that contain
 * another of their kind get a line marker instead, so work stays linear.
 */
function flattenBlocks(html: string): string {
  const spans = elementSpans(html, ["h1", "h2", "h3", "h4", "h5", "h6", "li", "tr"]).sort((a, b) => a.start - b.start);
  let output = "";
  let position = 0;
  for (const span of spans) {
    if (span.start < position) continue;
    output += html.slice(position, span.start);
    const heading = span.tag.startsWith("h") ? "#".repeat(Number(span.tag[1])) : null;
    const closed = span.contentEnd < html.length;
    const inner = closed ? html.slice(span.contentStart, span.contentEnd) : "";
    const nested = closed && (heading ? /<h[1-6]\b/i : span.tag === "li" ? /<li\b/i : /<tr\b/i).test(inner);
    if (!closed || nested) {
      output += heading ? `\n${heading} ` : span.tag === "li" ? "\n- " : "\n";
      position = span.contentStart;
      continue;
    }
    if (heading) output += `\n${heading} ${stripTags(inner)}\n`;
    else if (span.tag === "li") output += `\n- ${stripTags(inner)}\n`;
    else {
      const cells = inner.split(/<t[hd]\b[^>]{0,500}>/i).slice(1).map(stripTags);
      output += cells.length ? `\n| ${cells.join(" | ")} |\n` : `\n${stripTags(inner)}\n`;
    }
    position = span.end;
  }
  return output + html.slice(position);
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

  const anchors = elementSpans(html, ["a"]).flatMap((anchor) => {
    const href = anchor.attrs.match(/href=["']([^"'#]+)["']/i)?.[1];
    const url = href ? sameSite(href) : null;
    const text = html.slice(anchor.contentStart, Math.min(anchor.contentEnd, anchor.contentStart + 500));
    return url ? [{ url, attrs: anchor.attrs, text: text.replace(/<[^>]{0,500}>/g, " ").trim() }] : [];
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
