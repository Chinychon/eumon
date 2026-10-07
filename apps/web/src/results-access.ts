import type { D1Like } from "@organic-growth/db";
import { googleAccessToken, googleScopes } from "./gsc-auth";
import type { GoogleAccess } from "./results-sync";

type GoogleEnv = { DB: D1Like; GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string; OAUTH_ENCRYPTION_KEY: string };

/** The site's Google token (fetched only when a Google step needs it) and its granted scopes. */
export function googleAccess(env: GoogleEnv, siteId: string): GoogleAccess {
  const scopes: string[] = [];
  return {
    token: async () => {
      scopes.push(...await googleScopes(env.DB, siteId));
      return googleAccessToken(env.DB, siteId, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.OAUTH_ENCRYPTION_KEY);
    },
    get scopes() { return scopes; },
  };
}
