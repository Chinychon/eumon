import { addDays, type BacklinksInput, type ReferringCounts, type ReferringDomain, type SpamNetwork } from "@organic-growth/core";
import { runStatements, type D1Like } from "./d1.js";
import { getSnapshot } from "./snapshots.js";

/*
 * The site's referring domains, replaced whole on each refresh in two
 * statements whatever the count (the Free plan allows 50 queries a request).
 */

export async function replaceReferringDomains(db: D1Like, siteId: string, rows: ReferringDomain[]): Promise<void> {
  const json = JSON.stringify(rows.map((row) => [row.domain, row.urlFrom, row.urlTo, row.anchor, row.dofollow ? 1 : 0, row.firstSeen, row.lastSeen, row.lost ? 1 : 0, row.broken ? 1 : 0, row.rank, row.spamScore, row.spam ? 1 : 0, row.spamReason]));
  await runStatements(db, [
    db.prepare("DELETE FROM referring_domains WHERE site_id = ?").bind(siteId),
    db.prepare(
      `INSERT INTO referring_domains (site_id, domain, url_from, url_to, anchor, dofollow, first_seen, last_seen, lost, broken, rank, spam_score, spam, spam_reason)
       SELECT ?, value->>0, value->>1, value->>2, value->>3, value->>4, value->>5, value->>6, value->>7, value->>8, value->>9, value->>10, value->>11, value->>12
       FROM json_each(?) WHERE true ON CONFLICT(site_id, domain) DO NOTHING`,
    ).bind(siteId, json),
  ]);
}

type Row = { domain: string; url_from: string; url_to: string; anchor: string; dofollow: number; first_seen: string; last_seen: string; lost: number; broken: number; rank: number; spam_score: number | null; spam: number; spam_reason: string | null };
const fromRow = (row: Row): ReferringDomain => ({
  domain: row.domain, urlFrom: row.url_from, urlTo: row.url_to, anchor: row.anchor, dofollow: Boolean(row.dofollow), firstSeen: row.first_seen, lastSeen: row.last_seen,
  lost: Boolean(row.lost), broken: Boolean(row.broken), rank: Number(row.rank), spamScore: row.spam_score === null ? null : Number(row.spam_score), spam: Boolean(row.spam), spamReason: row.spam_reason,
});

export async function listReferringDomains(db: D1Like, siteId: string, filter: { spam?: boolean; newSince?: string; lostSince?: string; broken?: boolean; limit: number }): Promise<ReferringDomain[]> {
  const where = ["site_id = ?1"];
  if (filter.spam !== undefined) where.push(`spam = ${filter.spam ? 1 : 0}`);
  if (filter.newSince) where.push("first_seen >= ?2");
  if (filter.lostSince) where.push("lost = 1 AND last_seen >= ?3");
  if (filter.broken) where.push("broken = 1 AND lost = 0");
  const { results } = await db.prepare(`SELECT * FROM referring_domains WHERE ${where.join(" AND ")} ORDER BY rank DESC, domain LIMIT ?4`)
    .bind(siteId, filter.newSince ?? "", filter.lostSince ?? "", filter.limit).all<Row>();
  return results.map(fromRow);
}

export async function referringDomainCounts(db: D1Like, siteId: string, since: string): Promise<ReferringCounts> {
  const row = await db.prepare(
    `SELECT SUM(spam = 0) AS real, SUM(spam = 1) AS spam,
            SUM(spam = 0 AND first_seen >= ?2) AS new_real, SUM(spam = 0 AND lost = 1 AND last_seen >= ?2) AS lost_real,
            SUM(spam = 0 AND broken = 1 AND lost = 0) AS broken_real, SUM(spam = 0 AND dofollow = 1) AS dofollow_real,
            SUM(spam = 1 AND first_seen >= ?2) AS new_spam
     FROM referring_domains WHERE site_id = ?1`,
  ).bind(siteId, since).first<Record<string, number | null>>();
  const n = (key: string) => Number(row?.[key] ?? 0);
  return { real: n("real"), spam: n("spam"), newReal: n("new_real"), lostReal: n("lost_real"), brokenReal: n("broken_real"), dofollowReal: n("dofollow_real"), newSpam: n("new_spam") };
}

/** What the card and findings read: counts, short real lists (never the whole table) and the networks grouped at refresh; null when the site has no rows. */
export async function loadReferringLists(db: D1Like, siteId: string, domain: string, today: string): Promise<BacklinksInput | null> {
  const month = addDays(today, -30);
  const [counts, top, newReal, lostReal, brokenReal, networks] = await Promise.all([
    referringDomainCounts(db, siteId, month),
    listReferringDomains(db, siteId, { spam: false, limit: 25 }),
    listReferringDomains(db, siteId, { spam: false, newSince: month, limit: 10 }),
    listReferringDomains(db, siteId, { spam: false, lostSince: month, limit: 10 }),
    listReferringDomains(db, siteId, { spam: false, broken: true, limit: 25 }),
    getSnapshot<SpamNetwork>(db, siteId, "spam_networks", domain),
  ]);
  return counts.real + counts.spam === 0 ? null : { asOf: networks?.periodEnd ?? null, counts, top, newReal, lostReal, brokenReal, networks: networks?.rows ?? [] };
}
