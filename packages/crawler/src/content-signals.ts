import { elementSpans, findTags, innerText, mainMarkup, parseAttributes, visibleText } from "./html.js";

/*
 * What the AI-visibility and on-page checks read from one page, in the
 * languages the sites write in: question headings, numbers with units, quotes,
 * freshness dates, authorship, entity markup, landmarks, images and links.
 * Heuristics, so the checks built on them are warnings and notices.
 */

// `\b` only after Latin words: Chinese characters are not word characters, so a boundary never follows them.
const QUESTION = /[?？]\s*$|^\s*(?:(?:how|what|why|when|which|who|can|should|is|are|do|does|apa|bagaimana|mengapa|kenapa|bila|bilakah|berapa|siapa|adakah)\b|如何|什么|为什么|怎么|哪)/i;
export const isQuestionHeading = (text: string) => QUESTION.test(text.trim());

/** Han, kana and Hangul: scripts written without spaces between words, and about twice as wide as Latin letters. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;
/** Words in a text: spaced words, plus two CJK characters to a word. */
export const countWords = (text: string) => text.replace(CJK, " ").split(/\s+/).filter(Boolean).length + Math.round((text.match(CJK) ?? []).length / 2);
/** A title's width with CJK characters counted twice, or undefined when it has none (its width is its length). */
export const titleWidth = (title: string | undefined) => {
  const cjk = title?.match(CJK)?.length ?? 0;
  return cjk ? title!.trim().length + cjk : undefined;
};

// A currency before the number, or a unit after it. `(?![a-z])` instead of `\b`: there is no word boundary after `%`.
const STAT = /(?:RM|USD|SGD|IDR|Rp|S?\$)\s?\d[\d,.]*|\d[\d,.]*\s?(?:%|percent|peratus|persen|million|juta|billion|bilion|km|kg|mm|cm|years?|tahun|months?|bulan|minutes?|minit|hours?|jam|days?|hari|patients?|pesakit|pasien)(?![a-z])/gi;
export const countStatistics = (text: string) => (text.match(STAT) ?? []).length;

const QUOTE = /<blockquote[\s>]|[“"]([^”"<]{40,})[”"]/gi;
export const countQuotes = (html: string) => (html.match(QUOTE) ?? []).length;

/** Links to these are sharing, not sources. */
export const SOCIAL_HOSTS = /(^|\.)(facebook|instagram|x|twitter|tiktok|youtube|linkedin|whatsapp|threads|pinterest)\.com$|^wa\.me$|^t\.me$/i;

const day = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
};

/** The page's last-modified day: JSON-LD dateModified, else datePublished, else Open Graph article times, else the first <time datetime> in the main content. */
export function parseModified(input: { jsonLd: Array<Record<string, unknown>>; metas: Record<string, string>; html: string }): string | undefined {
  for (const key of ["dateModified", "datePublished"]) for (const block of input.jsonLd) { const found = day(block[key]); if (found) return found; }
  for (const key of ["article:modified_time", "article:published_time"]) { const found = day(input.metas[key]); if (found) return found; }
  return day(findTags(input.html, "time").find((tag) => tag.datetime)?.datetime);
}

const ARTICLE_TYPES = /^(Article|BlogPosting|NewsArticle|MedicalWebPage|ScholarlyArticle|TechArticle|Report)$/i;
const ARTICLE_PATH = /\/(blog|news|artikel|berita|articles?|posts?|guides?|panduan|insights?)\//i;
const ENTITY_TYPES = /^(Organization|LocalBusiness|Person|Corporation|MedicalOrganization|MedicalBusiness|MedicalClinic|Dentist|Physician|Hospital|Store|Restaurant|ProfessionalService|LegalService|FinancialService|HomeAndConstructionBusiness|\w+Business)$/i;
const BYLINE = /\b(?:by|oleh|ditulis oleh|written by)\s*[:：]?\s+(?:dr\.?\s+)?[A-Z][a-z]+/;

export type ContentSignals = {
  lang?: string; viewport: boolean; images: number; imagesNoAlt: number; mixedContent: number; httpLinks: number; externalLinks: number;
  h1?: string; words: number; questionHeadings: number; listsOrTables: boolean; leadWords: number; statistics: number; quotes: number;
  modified?: string; articleLike: boolean; author: boolean; snippetBlocked: boolean; landmarks: number; headingSkips: boolean; entitySchema: boolean;
};

const types = (block: Record<string, unknown>) => (Array.isArray(block["@type"]) ? block["@type"] : [block["@type"]]).map(String);

export function contentSignals(html: string, pageUrl: string, ld: { jsonLdTypes: string[]; jsonLd: Array<Record<string, unknown>> }): ContentSignals {
  const url = new URL(pageUrl);
  const metas = findTags(html, "meta");
  const meta = (key: string) => metas.find((tag) => (tag.name ?? tag.property)?.toLowerCase() === key)?.content;
  const robots = [meta("robots"), meta("googlebot")].filter(Boolean).join(",");
  const mainHtml = mainMarkup(html);
  const mainText = visibleText(mainHtml);
  const words = countWords(mainText);
  const headings = elementSpans(html, ["h1", "h2", "h3", "h4", "h5", "h6"]).sort((a, b) => a.start - b.start);
  const text = (span: { contentStart: number; contentEnd: number }, source = html) => innerText(source.slice(span.contentStart, Math.min(span.contentEnd, span.contentStart + 2000)));
  const h1Span = headings.find((heading) => heading.tag.toLowerCase() === "h1");
  let headingSkips = false;
  let previous = 0;
  for (const heading of headings) {
    const level = Number(heading.tag[1]);
    if (previous && level > previous + 1) headingSkips = true;
    previous = level;
  }
  const questionHeadings = headings.filter((heading) => /^h[23]$/i.test(heading.tag) && isQuestionHeading(text(heading))).length;
  const afterH1 = h1Span ? html.slice(h1Span.end) : mainHtml;
  const lead = elementSpans(afterH1, ["p"])[0];
  const leadWords = lead ? innerText(afterH1.slice(lead.contentStart, lead.contentEnd)).split(/\s+/).filter(Boolean).length : 0;
  const listsOrTables = /<table[\s>]/i.test(mainHtml) || (mainHtml.match(/<li[\s>]/gi) ?? []).length >= 3;
  const images = findTags(html, "img");
  const https = url.protocol === "https:";
  const insecure = (src?: string) => Boolean(https && src && /^http:\/\//i.test(src.trim()));
  const embedded = [...images, ...findTags(html, "script"), ...findTags(html, "iframe"), ...findTags(html, "video"), ...findTags(html, "source"), ...findTags(html, "link").filter((tag) => /stylesheet/i.test(tag.rel ?? ""))];
  const host = (value: string) => value.replace(/^www\./, "");
  let httpLinks = 0;
  let externalLinks = 0;
  for (const anchor of findTags(mainHtml, "a")) {
    const href = anchor.href?.trim();
    if (!href) continue;
    let target: URL;
    try { target = new URL(href, pageUrl); } catch { continue; }
    if (!/^https?:$/.test(target.protocol)) continue;
    const sameSite = host(target.hostname) === host(url.hostname);
    if (sameSite && https && target.protocol === "http:") httpLinks++;
    if (!sameSite && !SOCIAL_HOSTS.test(target.hostname)) externalLinks++;
  }
  const articleLike = ld.jsonLdTypes.some((type) => ARTICLE_TYPES.test(type)) || /article/i.test(meta("og:type") ?? "") || ARTICLE_PATH.test(url.pathname);
  const author = ld.jsonLd.some((block) => Boolean(block.author)) || Boolean(meta("author")) || findTags(html, "a").some((tag) => /\bauthor\b/i.test(tag.rel ?? "")) || BYLINE.test(mainText);
  const entitySchema = ld.jsonLd.some((block) => types(block).some((type) => ENTITY_TYPES.test(type)) && (Boolean(block.sameAs) || Boolean(block.url)));
  const htmlTag = html.match(/<html\b([^>]*)>/i);
  const propertyMetas = Object.fromEntries(metas.filter((tag) => tag.property && tag.content).map((tag) => [tag.property!.toLowerCase(), tag.content!]));
  return {
    lang: (htmlTag ? parseAttributes(htmlTag[1]!).lang?.trim() : undefined) || undefined,
    viewport: Boolean(meta("viewport")),
    images: images.length,
    imagesNoAlt: images.filter((image) => image.alt === undefined).length,
    mixedContent: embedded.filter((tag) => insecure(tag.src ?? tag.href)).length,
    httpLinks,
    externalLinks,
    h1: h1Span ? text(h1Span).slice(0, 200) : undefined,
    words,
    questionHeadings,
    listsOrTables,
    leadWords,
    statistics: countStatistics(mainText),
    quotes: countQuotes(mainHtml),
    modified: parseModified({ jsonLd: ld.jsonLd, metas: propertyMetas, html: mainHtml }),
    articleLike,
    author,
    snippetBlocked: /\bnosnippet\b|max-snippet\s*:\s*0\b/i.test(robots),
    landmarks: ["main", "article", "nav", "header", "footer"].filter((tag) => new RegExp(`<${tag}[\\s>]`, "i").test(html)).length,
    headingSkips,
    entitySchema,
  };
}
