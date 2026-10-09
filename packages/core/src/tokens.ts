const encoder = new TextEncoder();

export function toBase64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** `data` plus an expiry, HMAC-signed as `payload.signature` (base64url). */
export async function signToken(data: object, ttlMs: number, secret: string): Promise<string> {
  if (secret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters.");
  const payload = toBase64Url(JSON.stringify({ ...data, exp: Date.now() + ttlMs }));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/** The signed data, or null when the token is malformed, tampered with, or expired. */
export async function verifyToken<T extends object>(value: string, secret: string): Promise<T | null> {
  const [payload, signature, extra] = value.split(".");
  if (secret.length < 32 || !payload || !signature || extra !== undefined) return null;
  try {
    // crypto.subtle.verify compares in constant time.
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), fromBase64Url(signature), encoder.encode(payload)))) return null;
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as T & { exp?: unknown };
    return typeof data.exp === "number" && data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

/** A 32-hex-character key derived from the server secret and a label, stable while the secret is: per-site keys with nothing stored. */
export async function derivedKey(secret: string, label: string): Promise<string> {
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(label)));
  return [...signature.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares two strings without stopping at the first difference, for secrets sent by callers. */
export function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}
