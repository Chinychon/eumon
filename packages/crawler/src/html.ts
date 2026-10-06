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

/**
 * Parses the attribute text of a start tag into a lower-cased name → decoded
 * value map. Attribute order, quoting style, and bare attributes don't matter.
 */
export function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const name = match[1]!.toLowerCase();
    if (name in attributes) continue;
    attributes[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

/** Attributes of every `<name …>` start tag, in document order. */
export function findTags(html: string, name: string): Array<Record<string, string>> {
  const re = new RegExp(`<${name}\\b((?:[^>"']|"[^"]*"|'[^']*')*)>`, "gi");
  return [...html.matchAll(re)].map((match) => parseAttributes(match[1] ?? ""));
}

/** True when a space-separated attribute such as `rel` contains `token`. */
export function hasToken(value: string | undefined, token: string): boolean {
  return Boolean(value && value.toLowerCase().split(/\s+/).includes(token));
}

/**
 * Markup with comments and non-content elements removed: scripts (including
 * JSON-LD and framework payloads), styles, templates, `<noscript>` fallbacks,
 * and inline SVG. What remains is what a reader — or a non-rendering crawler —
 * actually sees.
 */
export function contentMarkup(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ");
}

/** Visible text of an HTML document or fragment, whitespace-collapsed. */
export function visibleText(html: string): string {
  return decodeEntities(contentMarkup(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Text of an element fragment with tags removed and entities decoded. */
export function innerText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
