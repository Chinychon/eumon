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

/** One `<tag …>…</tag>` element; `end` is the document length when the element is never closed. */
export type ElementSpan = { tag: string; start: number; attrs: string; contentStart: number; contentEnd: number; end: number };

/**
 * Locates elements in linear time, even in malformed HTML. Regex pairs like
 * `<li>[\s\S]*?</li>` rescan to the end of the document for every opener
 * without a closer (and `</li>`, `</tr>`, `</p>` are optional in HTML), which
 * turns a large list page into minutes of CPU.
 */
export function elementSpans(html: string, tags: string[]): ElementSpan[] {
  const names = tags.map((tag) => tag.toLowerCase()).join("|");
  const closers = new Map<string, number[]>();
  for (const match of html.matchAll(new RegExp(`</(${names})\\s*>`, "gi"))) {
    const tag = match[1]!.toLowerCase();
    const list = closers.get(tag);
    if (list) list.push(match.index!);
    else closers.set(tag, [match.index!]);
  }
  const cursor = new Map<string, number>();
  const spans: ElementSpan[] = [];
  // Attributes are bounded so an opener without ">" can't scan the rest of the document.
  for (const match of html.matchAll(new RegExp(`<(${names})\\b([^>]{0,4000})>`, "gi"))) {
    const tag = match[1]!.toLowerCase();
    const contentStart = match.index! + match[0].length;
    const list = closers.get(tag) ?? [];
    let index = cursor.get(tag) ?? 0;
    while (index < list.length && list[index]! < contentStart) index++;
    cursor.set(tag, index);
    const contentEnd = list[index] ?? html.length;
    const end = index < list.length ? html.indexOf(">", contentEnd) + 1 : html.length;
    spans.push({ tag, start: match.index!, attrs: match[2] ?? "", contentStart, contentEnd, end });
  }
  return spans;
}

/** Removes comments and the given elements (with their content) in linear time; unclosed ones run to the end, as in browsers. */
export function stripElements(html: string, tags: string[], replacement = " "): string {
  const cuts = [...commentSpans(html), ...elementSpans(html, tags)].sort((a, b) => a.start - b.start);
  let output = "";
  let position = 0;
  for (const cut of cuts) {
    if (cut.start < position) continue;
    output += html.slice(position, cut.start) + replacement;
    position = cut.end;
  }
  return output + html.slice(position);
}

function commentSpans(html: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let index = html.indexOf("<!--");
  while (index >= 0) {
    const close = html.indexOf("-->", index + 4);
    const end = close < 0 ? html.length : close + 3;
    spans.push({ start: index, end });
    if (close < 0) break;
    index = html.indexOf("<!--", end);
  }
  return spans;
}

/**
 * Markup with comments and non-content elements removed: scripts (including
 * JSON-LD and framework payloads), styles, templates, `<noscript>` fallbacks,
 * and inline SVG. What remains is what a reader — or a non-rendering crawler —
 * actually sees.
 */
export function contentMarkup(html: string): string {
  return stripElements(html, ["script", "style", "noscript", "template", "svg"]);
}

/** The page's main content: the first `<main>` or `<article>`, else the page without nav, header, footer, aside and forms. */
export function mainMarkup(html: string): string {
  const main = elementSpans(html, ["main", "article"])[0];
  return main ? html.slice(main.contentStart, main.contentEnd) : stripElements(html, ["nav", "header", "footer", "aside", "form"]);
}

/** Visible text of an HTML document or fragment, whitespace-collapsed. */
export function visibleText(html: string): string {
  return decodeEntities(contentMarkup(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Text of an element fragment with tags removed and entities decoded. */
export function innerText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
