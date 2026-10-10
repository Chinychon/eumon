/*
 * Search Console's Page indexing report has no API, but it exports. These
 * read the three export shapes, name Google's reasons the same way every
 * time, say what a URL is today from a crawl or live fetch, and pair a dead
 * URL with the live page it should redirect to.
 */

export type GscReason =
  | "indexed" | "discovered" | "crawled" | "noindex" | "duplicate_canonical" | "alternate_canonical" | "duplicate_no_canonical"
  | "redirect" | "not_found" | "soft_404" | "server_error" | "blocked_robots" | "blocked_access" | "other";

/** Display order, labelled as Search Console writes them. */
export const GSC_REASONS: Array<{ reason: GscReason; label: string }> = [
  { reason: "indexed", label: "Indexed" },
  { reason: "discovered", label: "Discovered – currently not indexed" },
  { reason: "crawled", label: "Crawled – currently not indexed" },
  { reason: "noindex", label: "Excluded by 'noindex' tag" },
  { reason: "duplicate_canonical", label: "Duplicate, Google chose different canonical than user" },
  { reason: "alternate_canonical", label: "Alternate page with proper canonical tag" },
  { reason: "duplicate_no_canonical", label: "Duplicate without user-selected canonical" },
  { reason: "redirect", label: "Page with redirect" },
  { reason: "not_found", label: "Not found (404)" },
  { reason: "soft_404", label: "Soft 404" },
  { reason: "server_error", label: "Server error (5xx)" },
  { reason: "blocked_robots", label: "Blocked by robots.txt" },
  { reason: "blocked_access", label: "Blocked due to access forbidden (403) or unauthorized request (401)" },
  { reason: "other", label: "Other" },
];

/** The id for a reason as exported (any language's punctuation; "not indexed" is checked before "indexed"). */
export function gscReason(text: string): GscReason {
  const t = text.toLowerCase();
  if (/discovered/.test(t)) return "discovered";
  if (/crawled/.test(t)) return "crawled";
  if (/noindex/.test(t)) return "noindex";
  if (/duplicate.*(different canonical|google chose)/.test(t)) return "duplicate_canonical";
  if (/alternat.*canonical/.test(t)) return "alternate_canonical";
  if (/duplicate.*without.*canonical/.test(t)) return "duplicate_no_canonical";
  if (/redirect/.test(t)) return "redirect";
  if (/soft 404/.test(t)) return "soft_404";
  if (/not found|\(404\)/.test(t)) return "not_found";
  if (/server error|5xx/.test(t)) return "server_error";
  if (/blocked by robots/.test(t)) return "blocked_robots";
  if (/forbidden|unauthori[sz]ed|\(40[13]\)/.test(t)) return "blocked_access";
  if (/\bindexed\b/.test(t) && !/not indexed/.test(t)) return "indexed";
  return "other";
}

/** The reason an export's file name carries ("…Drilldown-2026-10-09 Excluded by 'noindex' tag.zip"), if any. */
export function reasonFromFileName(name: string): GscReason | null {
  // "shop.example-Coverage-Drilldown-2026-10-09 Excluded by 'noindex' tag.zip": only the words after the date, so the property's own name can't name a reason.
  const stem = name.replace(/\.(zip|csv)$/i, "").replace(/^.*?\d{4}-\d{2}-\d{2}/, "");
  const reason = gscReason(stem);
  return reason === "other" ? null : reason;
}

export type GscSummaryRow = { reason: GscReason; reasonText: string; source: string | null; validation: string | null; pages: number };

export type ParsedExport =
  | { kind: "urls"; urls: Array<{ url: string; lastCrawled: string | null }>; otherHost: number }
  | { kind: "table"; rows: GscSummaryRow[] }
  | { kind: "chart"; points: Array<{ day: string; indexed: number; notIndexed: number }> }
  | { kind: "unknown"; why: string };

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and line breaks; a BOM and CRLF are tolerated. `complete` is false when a quote never closed. */
export function csvRows(text: string): { rows: string[][]; complete: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^﻿/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell !== "")) rows.push(row);
  return { rows, complete: !quoted };
}

const sameHost = (host: string, site: string) => host === site || host === `www.${site}` || site === `www.${host}`;
const asNumber = (cell: string) => { const n = Number(cell.replace(/[^\d.-]/g, "")); return Number.isFinite(n) && cell.trim() !== "" ? n : null; };
/** The order of a slashed date: month first (a US account) or day first (most others). */
export type DateOrder = "mdy" | "dmy";

const validDay = (year: number, month: number, day: number) => month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2000 && year <= 2100
  ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` : null;

/** "2026-10-06", "Oct 6, 2026" or "9/19/2026" → "2026-10-06"; a bare number, an impossible date or anything else → null. */
export function asDay(cell: string, order: DateOrder = "mdy"): string | null {
  const text = cell.trim();
  if (!text || /^-?[\d,.]+$/.test(text)) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return validDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const slashed = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashed) {
    const [first, second, year] = [Number(slashed[1]), Number(slashed[2]), Number(slashed[3])];
    return order === "dmy" ? validDay(year, second, first) : validDay(year, first, second);
  }
  const parsed = Date.parse(`${text} UTC`);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

/** Day-first when any slashed date in the file can only be read that way ("19/9/2026"); month-first otherwise. */
export function dateOrder(cells: string[]): DateOrder {
  return cells.some((cell) => { const m = cell.trim().match(/^(\d{1,2})\/(\d{1,2})\/\d{4}$/); return m && Number(m[1]) > 12; }) ? "dmy" : "mdy";
}
const urlOf = (cell: string) => { try { const url = new URL(cell.trim()); return /^https?:$/.test(url.protocol) ? url : null; } catch { return null; } };

/** Reads one export; `host` is the site's host, with or without www. */
export function parseSearchConsoleExport(text: string, host: string): ParsedExport {
  const { rows, complete } = csvRows(text);
  if (!complete) return { kind: "unknown", why: "A quote in the file never closes, so its rows can't be told apart." };
  if (rows.length < 2) return { kind: "unknown", why: "The file has no rows under its header." };
  const header = rows[0]!.map((cell) => cell.trim().toLowerCase());
  const body = rows.slice(1);
  const site = host.toLowerCase().replace(/^www\./, "");
  const column = (test: (name: string) => boolean) => header.findIndex(test);
  const order = dateOrder(body.flat());
  const isDate = (index: number) => body.some((row) => asDay(row[index] ?? "", order) !== null);
  // Overview table: a reason column and a pages column.
  const reasonCol = column((name) => /reason|grund|motivo|raison/.test(name));
  const pagesCol = column((name) => /^pages?$|seiten|páginas|pagine/.test(name));
  if (reasonCol >= 0 && pagesCol >= 0) {
    const sourceCol = column((name) => /source/.test(name));
    const validationCol = column((name) => /validation/.test(name));
    return { kind: "table", rows: body.map((row) => ({
      reason: gscReason(row[reasonCol] ?? ""), reasonText: (row[reasonCol] ?? "").trim(),
      source: sourceCol >= 0 ? (row[sourceCol] ?? "").trim() || null : null, validation: validationCol >= 0 ? (row[validationCol] ?? "").trim() || null : null,
      pages: asNumber(row[pagesCol] ?? "") ?? 0,
    })) };
  }
  // Chart: a date column beside indexed and not-indexed counts.
  const notIndexedCol = column((name) => /not indexed|nicht indexiert|no indexad/.test(name));
  const indexedCol = header.findIndex((name, index) => index !== notIndexedCol && /indexed|indexiert|indexad/.test(name));
  if (notIndexedCol >= 0 && indexedCol >= 0) {
    const dateCol = header.findIndex((_, index) => index !== indexedCol && index !== notIndexedCol && isDate(index));
    if (dateCol >= 0) {
      return { kind: "chart", points: body.flatMap((row) => {
        const day = asDay(row[dateCol] ?? "", order);
        return day ? [{ day, indexed: asNumber(row[indexedCol] ?? "") ?? 0, notIndexed: asNumber(row[notIndexedCol] ?? "") ?? 0 }] : [];
      }) };
    }
  }
  // URL list: the column whose values are URLs, and a date column if there is one.
  const urlCol = header.findIndex((_, index) => body.some((row) => urlOf(row[index] ?? "") !== null));
  if (urlCol < 0) return { kind: "unknown", why: "No column holds URLs. Export a reason's URL list, the overview table, or the chart from Search Console's Page indexing report." };
  const dateCol = header.findIndex((_, index) => index !== urlCol && isDate(index));
  let otherHost = 0;
  const urls: Array<{ url: string; lastCrawled: string | null }> = [];
  for (const row of body) {
    const url = urlOf(row[urlCol] ?? "");
    if (!url) continue;
    if (!sameHost(url.hostname.toLowerCase(), site)) { otherHost++; continue; }
    urls.push({ url: url.toString(), lastCrawled: dateCol >= 0 ? asDay(row[dateCol] ?? "", order) : null });
  }
  return { kind: "urls", urls, otherHost };
}

export type TodayStatus = "indexable" | "noindex" | "redirect" | "gone" | "error" | "unchecked";

const samePage = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/** What a URL is today, from its crawl row or live fetch; null or a null status is not checked yet. */
export function todayStatus(input: { url: string; status: number | null; finalUrl?: string | null; noindex?: boolean | null } | null): TodayStatus {
  if (!input || input.status === null) return "unchecked";
  if (input.status === 404 || input.status === 410) return "gone";
  if (input.status >= 400) return "error";
  if (input.finalUrl && !samePage(input.finalUrl, input.url)) return "redirect";
  if (input.noindex) return "noindex";
  return "indexable";
}

const STOPWORDS = new Set(["dr", "dato", "datuk", "prof", "mr", "mrs", "ms", "the", "and"]);
const LOCALE = /^[a-z]{2}([-_][a-z]{2})?$/i;

/** The language a URL's path starts with ("ms", "en-us"), or "" for the default. */
const localeOf = (url: string) => { const first = new URL(url).pathname.split("/").filter(Boolean)[0] ?? ""; return LOCALE.test(first) ? first.toLowerCase() : ""; };

const slugTokens = (url: string) => (new URL(url).pathname.split("/").filter(Boolean).pop() ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1 && !STOPWORDS.has(token));

/**
 * The live URL, in the same language, whose slug contains every word of the
 * dead URL's slug, the closest first; the caller passes candidates of the same
 * page type. One word only counts alone when it is six characters or more, so
 * "lee" never pairs two people, and two equally close pages are no answer.
 */
export function suggestRedirect(deadUrl: string, liveUrls: string[]): string | null {
  const tokens = slugTokens(deadUrl);
  if (!tokens.length || (tokens.length === 1 && tokens[0]!.length < 6)) return null;
  const locale = localeOf(deadUrl);
  let best: { url: string; extra: number; tied: boolean } | null = null;
  for (const url of liveUrls) {
    if (samePage(url, deadUrl) || localeOf(url) !== locale) continue;
    const candidate = slugTokens(url);
    if (!tokens.every((token) => candidate.includes(token))) continue;
    const extra = candidate.length - tokens.length;
    if (!best || extra < best.extra) best = { url, extra, tied: false };
    else if (extra === best.extra) best.tied = true;
  }
  return best && !best.tied ? best.url : null;
}
