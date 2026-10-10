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
