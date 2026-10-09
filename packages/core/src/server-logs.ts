/*
 * Server and CDN access logs: what search engines and AI agents request on
 * the whole site, not just Eumon's pages. Lines arrive as Cloudflare Logpush
 * records, Vercel log drain records, Eumon's log-forwarding Worker, or
 * nginx/Apache combined log lines; only crawler requests are kept, so no
 * visitor's request is ever stored.
 */

import { classifyUserAgent } from "./ai-agents.js";

/** One request from a log, in the fields every format shares. */
export type LogHit = { time: string; host: string | null; path: string; status: number; userAgent: string };

/** Who made a request: Googlebot, Bingbot, an AI agent by its token, or another bot. A person is null. */
export type LogBot = { bot: string; group: "google" | "bing" | "ai" | "other" };

/** The user agent's claim; logs carry no proof, so a fake Googlebot counts as Googlebot. */
export function logBot(userAgent: string): LogBot | null {
  const visitor = classifyUserAgent(userAgent);
  if (!visitor) return /bingbot|adidxbot|msnbot/i.test(userAgent) ? { bot: "bingbot", group: "bing" } : null;
  if (visitor.kind === "googlebot") return { bot: "googlebot", group: "google" };
  if (visitor.kind === "ai") return { bot: visitor.agent.agent, group: "ai" };
  if (/bingbot|adidxbot|msnbot/i.test(userAgent)) return { bot: "bingbot", group: "bing" };
  return { bot: "other", group: "other" };
}

/** Seconds, milliseconds or nanoseconds since the epoch, or an ISO/RFC 3339 string, as ISO. */
function isoTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e17 ? value / 1e6 : value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value) {
    if (/^\d+$/.test(value)) return isoTime(Number(value));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

const text = (value: unknown) => (typeof value === "string" ? value : Array.isArray(value) && typeof value[0] === "string" ? value[0] : null);
const status = (value: unknown) => (typeof value === "number" ? value : typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : null);

/** A path and query from a path or a full URL. */
function pathOf(value: string): string | null {
  if (value.startsWith("/")) return value;
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/** One JSON record: Cloudflare Logpush, a Vercel drain record with its `proxy` block, or the generic shape Eumon's Worker sends. */
function fromRecord(record: Record<string, unknown>): LogHit | null {
  if ("ClientRequestURI" in record || "ClientRequestUserAgent" in record) {
    const time = isoTime(record.EdgeStartTimestamp);
    const path = text(record.ClientRequestURI);
    const code = status(record.EdgeResponseStatus);
    if (!time || !path || code === null) return null;
    return { time, host: text(record.ClientRequestHost), path, status: code, userAgent: text(record.ClientRequestUserAgent) ?? "" };
  }
  const proxy = record.proxy as Record<string, unknown> | undefined;
  if (proxy && typeof proxy === "object") {
    const time = isoTime(proxy.timestamp ?? record.timestamp);
    const path = text(proxy.path);
    const code = status(proxy.statusCode ?? record.statusCode);
    // -1: Vercel revalidated in the background, so no response went to the requester.
    if (!time || !path || code === null || code < 0) return null;
    return { time, host: text(proxy.host) ?? text(record.host), path, status: code, userAgent: text(proxy.userAgent) ?? "" };
  }
  const time = isoTime(record.time ?? record.timestamp);
  const target = text(record.path) ?? text(record.url);
  const path = target ? pathOf(target) : null;
  const code = status(record.status ?? record.statusCode);
  if (!time || !path || code === null) return null;
  return { time, host: text(record.host), path, status: code, userAgent: text(record.userAgent) ?? text(record.ua) ?? text(record.user_agent) ?? "" };
}

const MONTHS: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
/** nginx and Apache "combined": `ip - - [10/Oct/2026:13:55:36 +0000] "GET /path HTTP/1.1" 200 2326 "referer" "agent"`. */
const COMBINED = /^\S+ \S+ \S+ \[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})\] "(?:[A-Z]+) (\S+)(?: [^"]*)?" (\d{3}) \S+(?: "[^"]*" "([^"]*)")?/;

function fromCombined(line: string): LogHit | null {
  const match = COMBINED.exec(line);
  if (!match) return null;
  const [, day, month, year, clock, zoneHours, zoneMinutes, target, code, agent] = match;
  if (!MONTHS[month!]) return null;
  const time = isoTime(`${year}-${MONTHS[month!]}-${day}T${clock}${zoneHours}:${zoneMinutes}`);
  const path = pathOf(target!);
  return time && path ? { time, host: null, path, status: Number(code), userAgent: agent ?? "" } : null;
}

/** Every request in a delivery: a JSON array, newline-delimited JSON, or combined log lines. Lines that are none of these are skipped. */
export function parseLogBody(body: string): LogHit[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const records = JSON.parse(trimmed) as unknown[];
      return records.flatMap((record) => (record && typeof record === "object" ? [fromRecord(record as Record<string, unknown>)].filter((hit): hit is LogHit => hit !== null) : []));
    } catch {
      // Not one JSON array: read it line by line below.
    }
  }
  const hits: LogHit[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry) continue;
    let hit: LogHit | null = null;
    if (entry.startsWith("{")) {
      try {
        hit = fromRecord(JSON.parse(entry) as Record<string, unknown>);
      } catch {
        hit = null;
      }
    } else hit = fromCombined(entry);
    if (hit) hits.push(hit);
  }
  return hits;
}

export const statusClass = (code: number) => (code >= 500 ? "5xx" : code >= 400 ? "4xx" : code >= 300 ? "3xx" : "2xx");

/** `query`: the requested URL had a query string, which is where crawl budget usually leaks. */
export type CrawlDayRow = { day: string; bot: string; family: string; statusClass: string; query: boolean; hits: number };
export type CrawlPathRow = { group: "google" | "bing"; path: string; lastSeen: string; lastStatus: number; hits: number };

/** Longest stored path: longer ones are almost always tracking or session parameters. */
const MAX_PATH = 300;

/**
 * Crawler requests from a delivery, summed per day, bot, page type and status
 * class, plus the latest Googlebot and Bingbot request per path. Requests for
 * another host (a preview deployment, an API subdomain) are left out, and so
 * is every request a person made.
 */
export function aggregateHits(hits: LogHit[], input: { host: string; familyOf: (path: string) => string }): { days: CrawlDayRow[]; paths: CrawlPathRow[]; crawler: number; skipped: number } {
  const site = input.host.toLowerCase().replace(/^www\./, "");
  const days = new Map<string, CrawlDayRow>();
  const paths = new Map<string, CrawlPathRow>();
  let crawler = 0;
  let skipped = 0;
  for (const hit of hits) {
    const host = hit.host?.toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");
    if (host && host !== site) { skipped++; continue; }
    const who = logBot(hit.userAgent);
    if (!who) { skipped++; continue; }
    crawler++;
    const day = hit.time.slice(0, 10);
    const family = input.familyOf(hit.path);
    const cls = statusClass(hit.status);
    const query = hit.path.includes("?");
    const key = `${day}|${who.bot}|${family}|${cls}|${query}`;
    const row = days.get(key) ?? { day, bot: who.bot, family, statusClass: cls, query, hits: 0 };
    row.hits++;
    days.set(key, row);
    if (who.group === "google" || who.group === "bing") {
      const path = hit.path.slice(0, MAX_PATH);
      const pathKey = `${who.group}|${path}`;
      const seen = paths.get(pathKey);
      if (!seen) paths.set(pathKey, { group: who.group, path, lastSeen: hit.time, lastStatus: hit.status, hits: 1 });
      else {
        seen.hits++;
        if (hit.time > seen.lastSeen) { seen.lastSeen = hit.time; seen.lastStatus = hit.status; }
      }
    }
  }
  return { days: [...days.values()], paths: [...paths.values()], crawler, skipped };
}

/** What the Crawl log card shows: requests per crawler and page type over 28 days, Googlebot per week, and where its requests go to waste. */
export type CrawlLogView = {
  /** The first day a log delivery was recorded; null before any. */
  since: string | null;
  lastDay: string | null;
  totals: { googlebot: number; bingbot: number; ai: number; other: number };
  weeks: Array<{ week: string; googlebot: number | null; bingbot: number | null; ai: number | null; partial: boolean }>;
  /** Googlebot requests per page type over 28 days, with the share that failed. */
  families: Array<{ family: string; hits: number; errors: number; redirects: number }>;
  /** Googlebot requests over 28 days by what they got back. */
  statuses: { ok: number; redirects: number; clientErrors: number; serverErrors: number };
  /** Googlebot requests over 28 days for URLs with a query string. */
  parameterHits: number;
};

const groupOf = (bot: string): LogBot["group"] => (bot === "googlebot" ? "google" : bot === "bingbot" ? "bing" : bot === "other" ? "other" : "ai");

const DAY_MS = 86_400_000;
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const monday = (day: string) => shift(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

/** The Crawl log card from stored day rows. The 28 days end yesterday: today's deliveries are still arriving. */
export function crawlLogView(rows: CrawlDayRow[], today: string): CrawlLogView {
  const days = rows.map((row) => row.day).sort();
  const since = days[0] ?? null;
  const end = shift(today, -1);
  const start = shift(end, -27);
  const recent = rows.filter((row) => row.day >= start && row.day <= end);
  const totals = { googlebot: 0, bingbot: 0, ai: 0, other: 0 };
  for (const row of recent) {
    const group = groupOf(row.bot);
    totals[group === "google" ? "googlebot" : group === "bing" ? "bingbot" : group] += row.hits;
  }
  const google = recent.filter((row) => row.bot === "googlebot");
  const families = new Map<string, { family: string; hits: number; errors: number; redirects: number }>();
  for (const row of google) {
    const entry = families.get(row.family) ?? { family: row.family, hits: 0, errors: 0, redirects: 0 };
    entry.hits += row.hits;
    if (row.statusClass === "4xx" || row.statusClass === "5xx") entry.errors += row.hits;
    if (row.statusClass === "3xx") entry.redirects += row.hits;
    families.set(row.family, entry);
  }
  const by = (cls: string) => google.filter((row) => row.statusClass === cls).reduce((sum, row) => sum + row.hits, 0);
  const weeks: CrawlLogView["weeks"] = [];
  if (since) {
    const sums = new Map<string, { googlebot: number; bingbot: number; ai: number }>();
    for (const row of rows) {
      const group = groupOf(row.bot);
      if (group === "other") continue;
      const week = monday(row.day);
      const sum = sums.get(week) ?? { googlebot: 0, bingbot: 0, ai: 0 };
      sum[group === "google" ? "googlebot" : group === "bing" ? "bingbot" : "ai"] += row.hits;
      sums.set(week, sum);
    }
    // From the first full week of data: the week logs started in is partial by construction.
    for (let week = monday(since) === since ? since : shift(monday(since), 7); week <= today; week = shift(week, 7)) {
      const sum = sums.get(week);
      weeks.push({ week, googlebot: sum?.googlebot ?? 0, bingbot: sum?.bingbot ?? 0, ai: sum?.ai ?? 0, partial: shift(week, 6) > end });
    }
  }
  return {
    since,
    lastDay: days.at(-1) ?? null,
    totals,
    weeks,
    families: [...families.values()].sort((a, b) => b.hits - a.hits),
    statuses: { ok: by("2xx"), redirects: by("3xx"), clientErrors: by("4xx"), serverErrors: by("5xx") },
    parameterHits: google.filter((row) => row.query).reduce((sum, row) => sum + row.hits, 0),
  };
}
