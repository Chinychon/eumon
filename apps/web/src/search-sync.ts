import type { SiteRecord } from "@organic-growth/core";
import { fetchGeneratedPageSearchMetrics } from "@organic-growth/agents";
import {
  defaultPageSettings,
  getPageSettings,
  mapPageIdsByPath,
  replacePageSearchMetrics,
  upsertPageSearchDaily,
  type D1Like,
} from "@organic-growth/db";
import { googleAccessToken } from "./gsc-auth";

type SyncEnv = {
  DB: D1Like;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  OAUTH_ENCRYPTION_KEY: string;
};

/** `https://x.com/guides/a/?utm=1` → `/guides/a` when it belongs to the public origin. */
function pathFor(pageUrl: string, origin: string): string | null {
  try {
    const url = new URL(pageUrl);
    if (url.origin !== origin) return null;
    return url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  } catch {
    return null;
  }
}

/**
 * Imports the last 28 days of Search Console data for the site's generated
 * pages: page × query totals (for insights) and page × day totals (for
 * measuring the effect of each page change).
 */
export async function syncGeneratedPageSearch(env: SyncEnv, site: SiteRecord): Promise<{ queries: number; pageDays: number; periodStart: string; periodEnd: string }> {
  if (!site.gscProperty) throw new Error("Choose a Search Console property first.");
  const settings = (await getPageSettings(env.DB, site.id)) ?? defaultPageSettings(site.id, site.name, site.baseUrl);
  const origin = new URL(settings.publicOrigin).origin;
  const token = await googleAccessToken(env.DB, site.id, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.OAUTH_ENCRYPTION_KEY);
  const data = await fetchGeneratedPageSearchMetrics(token, site.gscProperty, `${origin}${settings.mountPath}/`);

  await replacePageSearchMetrics(env.DB, site.id, data.queries.flatMap((row) => {
    const path = pathFor(row.pageUrl, origin);
    return path ? [{ ...row, pageUrl: `${origin}${path}`, periodStart: data.periodStart, periodEnd: data.periodEnd }] : [];
  }));

  const pageIds = await mapPageIdsByPath(env.DB, site.id);
  const daily = data.daily.flatMap((row) => {
    const path = pathFor(row.pageUrl, origin);
    const pageId = path ? pageIds.get(path) : undefined;
    return pageId ? [{ pageId, day: row.day, clicks: row.clicks, impressions: row.impressions, position: row.position }] : [];
  });
  await upsertPageSearchDaily(env.DB, site.id, daily);
  return { queries: data.queries.length, pageDays: daily.length, periodStart: data.periodStart, periodEnd: data.periodEnd };
}
