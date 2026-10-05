import { createId } from "@organic-growth/core";
import { getOAuthCredential, upsertOAuthCredential, type D1Like } from "@organic-growth/db";

const encoder = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function signGscState(siteId: string, secret: string): Promise<string> {
  const payload = b64url(encoder.encode(JSON.stringify({ siteId, exp: Date.now() + 10 * 60_000, nonce: createId("oauth") })));
  return `${payload}.${b64url(await hmac(secret, payload))}`;
}

export async function verifyGscState(state: string, secret: string): Promise<string | null> {
  const [payload, signature, extra] = state.split(".");
  if (!payload || !signature || extra) return null;
  let expected: Uint8Array;
  let actual: Uint8Array;
  try {
    expected = await hmac(secret, payload);
    actual = unb64url(signature);
  } catch { return null; }
  let mismatch = expected.length ^ actual.length;
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) mismatch |= (expected[i] ?? 0) ^ (actual[i] ?? 0);
  if (mismatch) return null;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(unb64url(payload))) as { siteId?: string; exp?: number };
    return typeof decoded.siteId === "string" && Number(decoded.exp) > Date.now() ? decoded.siteId : null;
  } catch { return null; }
}

export async function encryptSecret(value: string, secret: string): Promise<string> {
  const rawKey = unb64url(secret);
  if (rawKey.length !== 32) throw new Error("OAUTH_ENCRYPTION_KEY must be a base64url-encoded 32-byte key.");
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value)));
  return `${b64url(iv)}.${b64url(cipher)}`;
}

export async function decryptSecret(value: string, secret: string): Promise<string> {
  const [ivValue, cipherValue] = value.split(".");
  const key = await crypto.subtle.importKey("raw", unb64url(secret), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(ivValue) }, key, unb64url(cipherValue));
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
