import { createId, fromBase64Url, toBase64Url } from "@organic-growth/core";
import { getOAuthCredential, upsertOAuthCredential, type D1Like } from "@organic-growth/db";

async function encryptSecret(value: string, secret: string): Promise<string> {
  const rawKey = fromBase64Url(secret);
  if (rawKey.length !== 32) throw new Error("OAUTH_ENCRYPTION_KEY must be a base64url-encoded 32-byte key.");
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value)));
  return `${toBase64Url(iv)}.${toBase64Url(cipher)}`;
}

async function decryptSecret(value: string, secret: string): Promise<string> {
  const [ivValue, cipherValue] = value.split(".");
  const key = await crypto.subtle.importKey("raw", fromBase64Url(secret), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(ivValue) }, key, fromBase64Url(cipherValue));
  return new TextDecoder().decode(plain);
}

export async function saveGoogleRefreshToken(db: D1Like, siteId: string, refreshToken: string, encryptionKey: string) {
  await upsertOAuthCredential(db, {
    id: createId("oauth"), siteId, provider: "google_search_console",
    encryptedBlob: await encryptSecret(refreshToken, encryptionKey), scopes: "webmasters.readonly",
  });
}

export async function googleAccessToken(db: D1Like, siteId: string, clientId: string, clientSecret: string, encryptionKey: string) {
  const credential = await getOAuthCredential(db, siteId, "google_search_console");
  if (!credential) throw new Error("Connect Google Search Console first.");
  const refreshToken = await decryptSecret(credential.encryptedBlob, encryptionKey);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!response.ok) throw new Error(`Google access token refresh failed (${response.status}).`);
  const json = await response.json() as { access_token: string };
  return json.access_token;
}
