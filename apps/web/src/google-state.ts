import { sameSecret } from "@organic-growth/core";

export type GoogleState = { siteId: string; nonce: string; userId: string };
export const GOOGLE_NONCE_COOKIE = "og_google_nonce";

/**
 * The OAuth state is signed, but a signature only proves Eumon made it. The nonce cookie
 * proves this browser started the flow, and the user id that the same person is finishing it,
 * so nobody can send a victim a link that stores the victim's Google account on their site.
 */
export function googleStateProblem(state: Partial<GoogleState> | null, cookieNonce: string | null, viewerId: string | null): string | null {
  if (!state?.siteId || !state.nonce || !state.userId) return "The Google connection link is invalid or expired.";
  if (!cookieNonce || !sameSecret(cookieNonce, state.nonce)) return "Start the Google connection again from Eumon in this browser.";
  if (!viewerId || viewerId !== state.userId) return "Sign in as the person who started the Google connection.";
  return null;
}
