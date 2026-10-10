import { aggregateHits, derivedKey, parseLogBody, sameSecret, type SiteRecord } from "@organic-growth/core";
import { classifyUrlType } from "@organic-growth/crawler";
import { recordCrawlLog, type D1Like } from "@organic-growth/db";

/*
 * Receiving the site's server and CDN logs. Each site has one secret ingest
 * address; a log shipper posts batches to it (Cloudflare Logpush, a Vercel log
 * drain, Eumon's log-forwarding Worker, or an uploaded access log), and only
 * crawler requests are kept.
 */

/** A site's original log token, derived from the server secret; used until the site rotates to a stored one. */
export const logToken = (secret: string, siteId: string) => derivedKey(secret, `logs:${siteId}`);

/** The token a delivery carries: `Authorization: Bearer …` (Vercel's custom headers, Logpush's `header_Authorization`) or `?token=` (anything else). */
export function presentedToken(request: Request): string | null {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  return bearer ?? new URL(request.url).searchParams.get("token");
}

export async function tokenMatches(request: Request, secret: string, siteId: string, stored: string | null): Promise<boolean> {
  const presented = presentedToken(request);
  return Boolean(presented) && sameSecret(presented!, stored ?? await logToken(secret, siteId));
}

/** Largest delivery read, uncompressed: Logpush batches start at 5 MB, Vercel's at 1 MB, uploads are split client-side. */
export const MAX_LOG_BYTES = 24 * 1024 * 1024;

/** The body as text, gunzipped when it is gzip (Logpush compresses without always saying so); null when it is too large. */
export async function readLogBody(request: Request, maxBytes = MAX_LOG_BYTES): Promise<string | null> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const stream = gzip ? new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")) : new Blob([bytes]).stream();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(part.value, { stream: true });
  }
  return text + decoder.decode();
}

/** Parses, keeps crawler requests for the site's host, and adds them to the store. */
export async function ingestLog(db: D1Like, site: Pick<SiteRecord, "id" | "baseUrl">, body: string): Promise<{ received: number; crawler: number; skipped: number }> {
  const hits = parseLogBody(body);
  const host = new URL(site.baseUrl).host;
  const { days, paths, crawler, skipped } = aggregateHits(hits, { host, familyOf: (path) => classifyUrlType(`https://${host}${path}`) });
  if (days.length) await recordCrawlLog(db, site.id, { days, paths });
  return { received: hits.length, crawler, skipped };
}
