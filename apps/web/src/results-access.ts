import type { D1Like } from "@organic-growth/db";
import { googleAccessToken, googleScopes } from "./gsc-auth.ts";
import type { GoogleAccess, SignalKeys } from "./results-sync.ts";

type GoogleEnv = { DB: D1Like; GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string; OAUTH_ENCRYPTION_KEY: string };
type KeyEnv = { GOOGLE_API_KEY?: string; OPEN_PAGERANK_KEY?: string; DATAFORSEO_LOGIN?: string; DATAFORSEO_PASSWORD?: string; BING_WEBMASTER_API_KEY?: string; SESSION_SECRET?: string };

/** The keyed signals the environment provides; a blank secret is no key. */
export function signalKeys(env: KeyEnv): SignalKeys {
  return {
    googleApiKey: env.GOOGLE_API_KEY || undefined,
    openPageRankKey: env.OPEN_PAGERANK_KEY || undefined,
    dataForSeo: env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD ? { login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD } : undefined,
    bingApiKey: env.BING_WEBMASTER_API_KEY || undefined,
    // IndexNow keys are derived from the session secret, which signs sessions too: too short a secret is no key.
    indexNowSecret: env.SESSION_SECRET && env.SESSION_SECRET.length >= 32 ? env.SESSION_SECRET : undefined,
  };
}

/** The site's Google token and its granted scopes, fetched only when a Google step needs them. */
export function googleAccess(env: GoogleEnv, siteId: string): GoogleAccess {
  return {
    connect: async () => ({
      scopes: await googleScopes(env.DB, siteId),
      token: await googleAccessToken(env.DB, siteId, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.OAUTH_ENCRYPTION_KEY),
    }),
  };
}
