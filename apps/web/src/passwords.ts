import { sameSecret } from "@organic-growth/core";

/*
 * Password hashing with WebCrypto PBKDF2-SHA256 at 100,000 iterations (the most Workers
 * allows). Better Auth's default scrypt runs in JavaScript and is far slower on Workers.
 * Even this exceeds the Free plan's 10 ms CPU limit, which is why password sign-in ships
 * off (PASSWORD_SIGNIN) until the paid plan.
 */
const ITERATIONS = 100_000;
const encoder = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${b64(salt)}$${b64(await derive(password, salt, ITERATIONS))}`;
}

export async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  const [scheme, iterations, salt, expected] = hash.split("$");
  if (scheme !== "pbkdf2-sha256" || !iterations || !salt || !expected) return false;
  try {
    return sameSecret(b64(await derive(password, unb64(salt), Number(iterations))), expected);
  } catch {
    return false;
  }
}
