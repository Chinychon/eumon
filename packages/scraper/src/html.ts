import type { JsonObject, JsonValue } from "@organic-growth/core";

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

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
  const attr = (re: RegExp) => {
    const value = html.match(re)?.[1];
    return value ? decodeEntities(value).trim() : undefined;
  };
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  return {
    title: title ? stripTags(title) : undefined,
    h1: h1 ? stripTags(h1) : undefined,
    description: attr(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
      ?? attr(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i),
    image: attr(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i),
    themeColor: attr(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']*)["']/i),
    canonical: attr(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i),
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

/** The next page of a paginated listing, from `rel="next"` when present. */
export function findNextPage(html: string, pageUrl: string): string | null {
  const href = html.match(/<(?:a|link)\b[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<(?:a|link)\b[^>]*href=["']([^"']+)["'][^>]*rel=["']next["']/i)?.[1];
  if (!href) return null;
  try {
    const next = new URL(decodeEntities(href), pageUrl);
    return next.origin === new URL(pageUrl).origin ? next.toString() : null;
  } catch {
    return null;
  }
}
