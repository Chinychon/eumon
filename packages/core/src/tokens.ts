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
