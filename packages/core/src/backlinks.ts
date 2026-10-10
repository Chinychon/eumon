import { bareDomain } from "./serp.js";

/*
 * Backlink details: the site's referring domains, one strongest link per domain,
 * live and lost. Dates are YYYY-MM-DD.
 */

export type ReferringDomain = {
  domain: string;
  urlFrom: string;
  urlTo: string;
  anchor: string;
  dofollow: boolean;
  firstSeen: string;
  lastSeen: string;
  lost: boolean;
  broken: boolean;
  rank: number;
  spamScore: number | null;
  spam: boolean;
  spamReason: string | null;
};

export type ReferringCounts = {
  real: number;
  spam: number;
  newReal: number;
  lostReal: number;
  brokenReal: number;
  dofollowReal: number;
  newSpam: number;
};

export const REFERRING_LIMITS = {
  /** One anchor or page path on this many referring domains is a link network; organic links don't repeat that exactly. */
  NETWORK_AT_LEAST: 10,
  /** DataForSEO's backlink_spam_score; 70 and up is treated as spam. */
  SPAM_SCORE_AT_LEAST: 70,
  /** "New" and "lost" mean the last 30 days (applied where the rows are loaded). */
  RECENT_DAYS: 30,
};

const SALES = /\b(back ?links?|pbn|do ?follow|seo authority|link ?building|guest ?posts?|fiverr|buy (back)?links?)\b/i;
// Case-sensitive so "Dr 5 Tan" and Italian "da 30" aren't caught.
const SALES_METRIC = /\b(DA|DR|PA) ?\d{1,2}\b/;
const isSales = (anchor: string) => SALES.test(anchor) || SALES_METRIC.test(anchor);

const REASON = { anchor: "Same anchor on", path: "Same page path on", sales: "Link-selling anchor", score: "Spam score" };
const alnum = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

const squash = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/** The path key, only for page paths that look generated (a digit, or the site's domain); "/", "/about", "/blog" are shared by honest sites. */
const networkPath = (urlFrom: string, own: string) => {
  const path = pathOf(urlFrom);
  if (path === null || path === "") return null;
  const full = path + (urlSearch(urlFrom) ?? "");
  return /\d/.test(full) || full.toLowerCase().includes(own) ? path : null;
};
const urlSearch = (urlFrom: string) => {
  try {
    return new URL(urlFrom).search;
  } catch {
    return null;
  }
};

const pathOf = (urlFrom: string) => {
  try {
    return new URL(urlFrom).pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
};

/** Real or spam, by the first rule that applies: network, then sales anchor, then spam score. */
export function classifyReferringDomains(rows: Omit<ReferringDomain, "spam" | "spamReason">[], site: string): ReferringDomain[] {
  const own = bareDomain(site.includes("://") ? new URL(site).hostname : site);
  const label = alnum(own.split(".")[0]);
  const bare = (anchor: string) => squash(anchor).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
  const anchors = new Map<string, Set<string>>();
  const paths = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, domain: string) => map.set(key, (map.get(key) ?? new Set()).add(domain));
  const keyed = rows.map((row) => {
    const plain = bare(row.anchor);
    const anchor = plain.split(own).join("{site}").trim();
    // Brand-like anchors (the domain, the business name) and short generic ones ("Website") are never a network by anchor.
    const brand = anchor === "" || anchor === "{site}" || (label !== "" && alnum(plain).startsWith(label));
    const anchorKey = brand || anchor.split(" ").length < 4 ? null : anchor;
    const path = networkPath(row.urlFrom, own);
    if (anchorKey) add(anchors, anchorKey, row.domain);
    if (path !== null) add(paths, path, row.domain);
    return { row, anchorKey, path };
  });
  const at = REFERRING_LIMITS.NETWORK_AT_LEAST;
  return keyed.map(({ row, anchorKey, path }) => {
    const sameAnchor = anchorKey ? anchors.get(anchorKey)!.size : 0;
    const samePath = path !== null ? paths.get(path)!.size : 0;
    const spamReason =
      sameAnchor >= at ? `${REASON.anchor} ${sameAnchor} sites`
      : samePath >= at ? `${REASON.path} ${samePath} sites`
      : isSales(row.anchor) ? REASON.sales
      : row.spamScore !== null && row.spamScore >= REFERRING_LIMITS.SPAM_SCORE_AT_LEAST ? `${REASON.score} ${row.spamScore}`
      : null;
    return { ...row, spam: spamReason !== null, spamReason };
  });
}

export type SpamNetwork = { key: string; kind: "anchor" | "path" | "sales" | "score"; label: string; domains: number; since: string; example: string };

/** Spam rows grouped by what they share (anchor, page path, sales anchor, or just a high score), largest first. */
export function spamNetworks(rows: ReferringDomain[]): SpamNetwork[] {
  const groups = new Map<string, { kind: SpamNetwork["kind"]; label: string; rows: ReferringDomain[] }>();
  for (const row of rows) {
    if (!row.spam) continue;
    const reason = row.spamReason ?? "";
    const kind: SpamNetwork["kind"] = reason.startsWith(REASON.anchor) ? "anchor" : reason.startsWith(REASON.path) ? "path" : reason.startsWith(REASON.sales) ? "sales" : "score";
    const grouped = kind === "sales" || kind === "score";
    const label = kind === "path" ? pathOf(row.urlFrom) ?? row.urlFrom : kind === "score" ? "High spam score" : kind === "sales" ? "Link-selling anchors" : row.anchor;
    const key = `${kind}:${grouped ? "" : kind === "path" ? label : squash(label)}`;
    const group = groups.get(key) ?? { kind, label, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, { kind, label, rows: members }]) => {
      const first = members.reduce((a, b) => (b.firstSeen < a.firstSeen ? b : a));
      return { key, kind, label, domains: new Set(members.map((m) => m.domain)).size, since: first.firstSeen, example: first.urlFrom };
    })
    .sort((a, b) => b.domains - a.domains);
}

export type BacklinksView = {
  asOf: string | null;
  counts: ReferringCounts;
  top: ReferringDomain[];
  anchors: Array<{ anchor: string; domains: number }>;
  networks: SpamNetwork[];
  newReal: ReferringDomain[];
  lostReal: ReferringDomain[];
  brokenReal: ReferringDomain[];
};

const LIST_CAP = 25;
const ANCHOR_CAP = 10;

/** What the view reads: the bounded lists, and the networks the last refresh grouped from every spam row. */
export type BacklinksInput = { asOf: string | null; counts: ReferringCounts; top: ReferringDomain[]; newReal: ReferringDomain[]; lostReal: ReferringDomain[]; brokenReal: ReferringDomain[]; networks: SpamNetwork[] };

export function backlinksView(input: BacklinksInput): BacklinksView {
  const mix = new Map<string, { anchor: string; domains: number }>();
  for (const row of input.top) {
    if (row.spam) continue;
    const anchor = row.anchor.trim() || "(no text)";
    const entry = mix.get(squash(anchor)) ?? { anchor, domains: 0 };
    entry.domains++;
    mix.set(squash(anchor), entry);
  }
  return {
    asOf: input.asOf,
    counts: input.counts,
    top: input.top.slice(0, LIST_CAP),
    anchors: [...mix.values()].sort((a, b) => b.domains - a.domains).slice(0, ANCHOR_CAP),
    networks: input.networks.slice(0, 5),
    newReal: input.newReal.slice(0, LIST_CAP),
    lostReal: input.lostReal.slice(0, LIST_CAP),
    brokenReal: input.brokenReal.slice(0, LIST_CAP),
  };
}
