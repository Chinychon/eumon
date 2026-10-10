import { env } from "cloudflare:workers";
import { indexNowKey } from "@organic-growth/agents";
import { firstCrawlLogDay, lastMetricDay, listCrawlLogDays } from "@organic-growth/db";
import { bingSiteUrl } from "../../../../../src/connector-sources";
import { logToken } from "../../../../../src/crawl-logs";
import { signalKeys } from "../../../../../src/results-access";
import { requireSite } from "../../../../../src/guard";
import { fail, json, settingsFor } from "../../../../../src/server";

/**
 * What Setup needs for the connections beyond Google: which keys are set, the
 * site's log address and token, its IndexNow key file, and when each last
 * delivered. The token is a secret: this is an operator route, like the rest
 * of the console.
 */
export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const { site } = access;
  const keys = signalKeys(env);
  const settings = await settingsFor(site);
  const origin = new URL(request.url).origin;
  const today = new Date().toISOString().slice(0, 10);
  const [firstLog, recent, indexNowDay, bingDay] = await Promise.all([
    firstCrawlLogDay(env.DB, siteId),
    listCrawlLogDays(env.DB, siteId, new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)),
    lastMetricDay(env.DB, siteId, "indexnow_submitted"),
    lastMetricDay(env.DB, siteId, "sync.bing"),
  ]);
  const key = keys.indexNowSecret ? await indexNowKey(keys.indexNowSecret, siteId) : null;
  return json({
    dataForSeo: Boolean(keys.dataForSeo),
    bing: { configured: Boolean(keys.bingApiKey), siteUrl: bingSiteUrl(site.baseUrl), lastSync: bingDay },
    indexNow: {
      available: Boolean(key),
      keyUrl: key ? `${new URL(settings.publicOrigin).origin}${settings.mountPath}/${key}.txt` : null,
      verified: Boolean(settings.verifiedAt),
      lastSubmitted: indexNowDay,
    },
    logs: keys.indexNowSecret ? {
      endpoint: `${origin}/api/logs/${siteId}`,
      token: await logToken(keys.indexNowSecret, siteId),
      host: new URL(site.baseUrl).host,
      firstDay: firstLog,
      lastDay: recent.at(-1)?.day ?? null,
      lastWeek: recent.filter((row) => row.day < today).reduce((sum, row) => sum + row.hits, 0),
    } : null,
  });
}
