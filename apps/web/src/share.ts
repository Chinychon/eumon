import { signToken, verifyToken, type SiteRecord } from "@organic-growth/core";
import { getSite, type D1Like } from "@organic-growth/db";

const FIVE_YEARS = 5 * 365 * 86_400_000;

/** A read-only Results link; it stops working when the site's share version is bumped. */
export function shareToken(site: SiteRecord, secret: string): Promise<string> {
  return signToken({ siteId: site.id, v: site.reportShareVersion ?? 1 }, FIVE_YEARS, secret);
}

export async function siteForShareToken(db: D1Like, token: string, secret: string): Promise<SiteRecord | null> {
  const data = await verifyToken<{ siteId: string; v: number }>(token, secret);
  if (!data) return null;
  const site = await getSite(db, data.siteId);
  return site && (site.reportShareVersion ?? 1) === data.v ? site : null;
}
