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
  /** Semrush's own spam score; 70 and up is its "toxic" band. */
  SPAM_SCORE_AT_LEAST: 70,
  /** "New" and "lost" mean the last 30 days (applied where the rows are loaded). */
  RECENT_DAYS: 30,
};

const SALES = /\b(back ?links?|pbn|do ?follow|da ?\d+|dr ?\d+|seo authority|link ?building|guest ?posts?|fiverr|rank(ed)? (higher|first)|first page|buy (back)?links?)\b/i;

const squash = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

const pathOf = (urlFrom: string) => {
  try {
    return new URL(urlFrom).pathname;
  } catch {
    return null;
  }
};

/** Real or spam, by the first rule that applies: network, then sales anchor, then spam score. */
export function classifyReferringDomains(rows: Omit<ReferringDomain, "spam" | "spamReason">[], site: string): ReferringDomain[] {
  const own = bareDomain(site);
  const label = own.split(".")[0];
  const normalise = (anchor: string) => squash(anchor).split(own).join("{site}").trim();
  const anchors = new Map<string, Set<string>>();
  const paths = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, domain: string) => map.set(key, (map.get(key) ?? new Set()).add(domain));
  const keyed = rows.map((row) => {
    const anchor = normalise(row.anchor);
    const anchorKey = anchor === "" || anchor === "{site}" || anchor === label ? null : anchor;
    const path = pathOf(row.urlFrom);
    if (anchorKey) add(anchors, anchorKey, row.domain);
    if (path !== null) add(paths, path, row.domain);
    return { row, anchorKey, path };
  });
  const at = REFERRING_LIMITS.NETWORK_AT_LEAST;
  return keyed.map(({ row, anchorKey, path }) => {
    const sameAnchor = anchorKey ? anchors.get(anchorKey)!.size : 0;
    const samePath = path !== null ? paths.get(path)!.size : 0;
    const spamReason =
      sameAnchor >= at ? `Same anchor on ${sameAnchor} sites`
      : samePath >= at ? `Same page path on ${samePath} sites`
      : SALES.test(row.anchor) ? "Link-selling anchor"
      : row.spamScore !== null && row.spamScore >= REFERRING_LIMITS.SPAM_SCORE_AT_LEAST ? `Spam score ${row.spamScore}`
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
    const kind: SpamNetwork["kind"] = reason.startsWith("Same anchor") ? "anchor" : reason.startsWith("Same page") ? "path" : reason.startsWith("Link-selling") ? "sales" : "score";
    const label = kind === "path" ? pathOf(row.urlFrom) ?? row.urlFrom : kind === "score" ? "High spam score" : row.anchor;
    const key = `${kind}:${kind === "score" ? "" : kind === "path" ? label : squash(label)}`;
    const group = groups.get(key) ?? { kind, label, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, { kind, label, rows: members }]) => {
      const first = members.reduce((a, b) => (b.firstSeen < a.firstSeen ? b : a));
      return { key, kind, label, domains: new Set(members.map((m) => m.domain)).size, since: first.firstSeen, example: first.domain };
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

export function backlinksView(input: { asOf: string | null; counts: ReferringCounts; top: ReferringDomain[]; newReal: ReferringDomain[]; lostReal: ReferringDomain[]; brokenReal: ReferringDomain[]; spamRows: ReferringDomain[] }): BacklinksView {
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
    networks: spamNetworks(input.spamRows),
    newReal: input.newReal.slice(0, LIST_CAP),
    lostReal: input.lostReal.slice(0, LIST_CAP),
    brokenReal: input.brokenReal.slice(0, LIST_CAP),
  };
}
