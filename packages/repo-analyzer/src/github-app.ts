export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  default_branch: string;
  owner: { login: string };
  private: boolean;
}

function encodeBase64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const parts: number[] = [];
  for (let n = length; n > 0; n >>= 8) parts.unshift(n & 0xff);
  return Uint8Array.of(0x80 | parts.length, ...parts);
}

function der(tag: number, value: Uint8Array): Uint8Array {
  return Uint8Array.of(tag, ...derLength(value.length), ...value);
}

function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const algorithm = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const body = Uint8Array.of(...version, ...algorithm, ...der(0x04, pkcs1));
  return der(0x30, body);
}

function pemBytes(pem: string): Uint8Array {
  const content = pem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g, "");
  const binary = atob(content);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function createAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = encodeBase64Url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId }));
  const data = `${header}.${claims}`;
  const keyBytes = pemBytes(privateKeyPem);
  const pkcs8 = privateKeyPem.includes("BEGIN RSA PRIVATE KEY") ? pkcs1ToPkcs8(keyBytes) : keyBytes;
  const keyData = new Uint8Array(new ArrayBuffer(pkcs8.byteLength));
  keyData.set(pkcs8);
  const key = await crypto.subtle.importKey(
    "pkcs8", keyData.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  return `${data}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function github<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "organic-growth-engine",
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status}).`);
  return response.json() as Promise<T>;
}

export async function createInstallationToken(
  appId: string,
  privateKeyPem: string,
  installationId: string,
): Promise<string> {
  const jwt = await createAppJwt(appId, privateKeyPem);
  const result = await github<{ token: string }>(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    jwt,
    { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } },
  );
  return result.token;
}

export async function listInstallationRepositories(token: string): Promise<GitHubRepository[]> {
  const repositories: GitHubRepository[] = [];
  for (let page = 1; page <= 5; page++) {
    const result = await github<{ repositories: GitHubRepository[] }>(
      `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      token,
    );
    repositories.push(...result.repositories);
    if (result.repositories.length < 100) break;
  }
  return repositories;
}

export async function createSignedInstallationCookie(
  installationId: string,
  secret: string,
): Promise<string> {
  if (secret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters.");
  const payload = encodeBase64Url(JSON.stringify({ id: installationId, exp: Date.now() + 7 * 86400_000 }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifySignedInstallationCookie(value: string, secret: string): Promise<string | null> {
  if (secret.length < 32) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const padded = signature.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - signature.length % 4) % 4);
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  if (!(await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(payload)))) return null;
  const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - payload.length % 4) % 4))) as { id?: unknown; exp?: unknown };
  return typeof decoded.id === "string" && typeof decoded.exp === "number" && decoded.exp > Date.now() ? decoded.id : null;
}
