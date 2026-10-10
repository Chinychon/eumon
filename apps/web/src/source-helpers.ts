import { dataForSeoLocation } from "@organic-growth/agents";
import { countryNumeric, type SiteRecord } from "@organic-growth/core";
import { defaultPageSettings, getPageSettings, listSiteMarkets, type D1Like } from "@organic-growth/db";
import type { SyncContext } from "./results-sync.ts";

/* What several sync sources share: where Eumon's pages live, DataForSEO's market locations, freshness, and note wording. */

/** Where Eumon's pages are served. */
export async function eumonOrigin(db: D1Like, site: SiteRecord): Promise<{ origin: string; mountPath: string }> {
  const settings = (await getPageSettings(db, site.id)) ?? defaultPageSettings(site.id, site.name, site.baseUrl);
  return { origin: new URL(settings.publicOrigin).origin, mountPath: settings.mountPath };
}

/** DataForSEO's location for a target market, or null for a country it doesn't cover. */
export const marketLocation = (market: string): number | null => {
  const numeric = countryNumeric(market);
  return numeric === null ? null : dataForSeoLocation(numeric);
};

export const noMarkets = (name: string) => async ({ db, site }: SyncContext) => ((await listSiteMarkets(db, site.id)).length ? null : `${name}: set target markets in Setup`);

/** A keyword list is refreshed when it is missing or this many days old, so a new competitor or market is fetched on the next sync and nothing fresh is paid for twice. */
export const FRESH_DAYS = 28;
export const dollars = (cost: number) => `$${cost.toFixed(2)}`;
export const said = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Slices of at most `size`, never mixing markets, so a step's subrequests stay fixed whatever the market count. */
export function sliceByMarket<T extends { market: string }>(targets: T[], size: number): T[][] {
  const out: T[][] = [];
  for (const target of targets) {
    const last = out[out.length - 1];
    if (last && last.length < size && last[0]!.market === target.market) last.push(target);
    else out.push([target]);
  }
  return out;
}
