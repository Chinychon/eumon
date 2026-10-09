export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type ApiInit = Omit<RequestInit, "body"> & { json?: unknown; body?: BodyInit };

/** Fetches a JSON API route, throwing `ApiError` with the server's message on failure. */
export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const response = await fetch(path, {
    cache: "no-store",
    ...rest,
    headers: json !== undefined ? { "Content-Type": "application/json", ...headers } : headers,
    body: json !== undefined ? JSON.stringify(json) : init.body,
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const message = (data as { error?: unknown } | null)?.error;
    throw new ApiError(typeof message === "string" ? message : `Request failed (${response.status}).`, response.status);
  }
  return data as T;
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const formatNumber = (value: number) => value.toLocaleString("en", { maximumFractionDigits: 1 });

/** "9 Oct" from "2026-10-09". */
export const formatDay = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" });

export const percent = (value: number) => `${(value * 100).toFixed(value > 0 && value < 0.01 ? 2 : 1)}%`;
