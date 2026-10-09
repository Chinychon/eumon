/*
 * Google Analytics 4: the properties a Google connection can read, and daily
 * sessions with the Organic Search share, for the Results ledger.
 */

import { AI_ASSISTANTS, aiAssistantFrom, type AiAssistant } from "@organic-growth/core";
import { googleError } from "./google-search-console.js";

export type Ga4Day = { day: string; sessions: number; organicSessions: number; organicEngagedSessions: number; organicKeyEvents: number };

export async function listGa4Properties(accessToken: string, fetchFn: typeof fetch = fetch): Promise<Array<{ property: string; name: string }>> {
  const properties: Array<{ property: string; name: string }> = [];
  let pageToken = "";
  do {
    const response = await fetchFn(`https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw await googleError(response, "Google Analytics properties request");
    const json = await response.json() as { accountSummaries?: Array<{ displayName?: string; propertySummaries?: Array<{ property: string; displayName?: string }> }>; nextPageToken?: string };
    for (const account of json.accountSummaries ?? []) {
      for (const summary of account.propertySummaries ?? []) {
        properties.push({ property: summary.property, name: `${account.displayName ?? "Account"} · ${summary.displayName ?? summary.property}` });
      }
    }
    pageToken = json.nextPageToken ?? "";
  } while (pageToken);
  return properties;
}

/** Folds a `date` × `sessionDefaultChannelGroup` report into one row per day. */
export function ga4Days(json: unknown): Ga4Day[] {
  const rows = (json as { rows?: Array<{ dimensionValues: Array<{ value: string }>; metricValues: Array<{ value: string }> }> })?.rows ?? [];
  const days = new Map<string, Ga4Day>();
  for (const row of rows) {
    const raw = row.dimensionValues[0]?.value ?? "";
    const day = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    const entry = days.get(day) ?? { day, sessions: 0, organicSessions: 0, organicEngagedSessions: 0, organicKeyEvents: 0 };
    const [sessions, engaged, keyEvents] = row.metricValues.map((metric) => Number(metric.value) || 0);
    entry.sessions += sessions ?? 0;
    if (row.dimensionValues[1]?.value === "Organic Search") {
      entry.organicSessions += sessions ?? 0;
      entry.organicEngagedSessions += engaged ?? 0;
      entry.organicKeyEvents += keyEvents ?? 0;
    }
    days.set(day, entry);
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export async function fetchGa4Daily(accessToken: string, property: string, startDate: string, endDate: string, fetchFn: typeof fetch = fetch): Promise<Ga4Day[]> {
  const response = await fetchFn(`https://analyticsdata.googleapis.com/v1beta/${property}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "keyEvents" }],
      limit: 100_000,
    }),
  });
  if (!response.ok) throw await googleError(response, "Google Analytics report request");
  return ga4Days(await response.json());
}

export type Ga4AiDay = { day: string; assistant: AiAssistant; sessions: number; keyEvents: number };

/** Folds a `date` × `sessionSource` report into sessions per day and assistant; sources that name no assistant are dropped. */
export function ga4AiDays(json: unknown): Ga4AiDay[] {
  const rows = (json as { rows?: Array<{ dimensionValues: Array<{ value: string }>; metricValues: Array<{ value: string }> }> })?.rows ?? [];
  const days = new Map<string, Ga4AiDay>();
  for (const row of rows) {
    const assistant = aiAssistantFrom(row.dimensionValues[1]?.value);
    if (!assistant) continue;
    const raw = row.dimensionValues[0]?.value ?? "";
    const day = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    const key = `${day}|${assistant}`;
    const entry = days.get(key) ?? { day, assistant, sessions: 0, keyEvents: 0 };
    entry.sessions += Number(row.metricValues[0]?.value) || 0;
    entry.keyEvents += Number(row.metricValues[1]?.value) || 0;
    days.set(key, entry);
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day) || a.assistant.localeCompare(b.assistant));
}

/** Sessions AI assistants sent to the whole site (any page with the site's GA4 tag), per day and assistant, with their key events. */
export async function fetchGa4AiReferrals(accessToken: string, property: string, startDate: string, endDate: string, fetchFn: typeof fetch = fetch): Promise<Ga4AiDay[]> {
  const hosts = AI_ASSISTANTS.flatMap((entry) => [...entry.hosts, entry.assistant]).map((host) => host.replace(/\./g, "\\."));
  const response = await fetchFn(`https://analyticsdata.googleapis.com/v1beta/${property}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "date" }, { name: "sessionSource" }],
      metrics: [{ name: "sessions" }, { name: "keyEvents" }],
      dimensionFilter: { filter: { fieldName: "sessionSource", stringFilter: { matchType: "PARTIAL_REGEXP", value: hosts.join("|"), caseSensitive: false } } },
      limit: 100_000,
    }),
  });
  if (!response.ok) throw await googleError(response, "Google Analytics AI referrals request");
  return ga4AiDays(await response.json());
}

/** AI referral days as ledger points: the total per day, and per assistant. */
export function ga4AiPoints(days: Ga4AiDay[]): Array<{ metric: string; day: string; value: number }> {
  const totals = new Map<string, { sessions: number; keyEvents: number }>();
  const points: Array<{ metric: string; day: string; value: number }> = [];
  for (const entry of days) {
    const total = totals.get(entry.day) ?? { sessions: 0, keyEvents: 0 };
    total.sessions += entry.sessions;
    total.keyEvents += entry.keyEvents;
    totals.set(entry.day, total);
    points.push({ metric: `ga4_ai_sessions.${entry.assistant}`, day: entry.day, value: entry.sessions });
  }
  for (const [day, total] of totals) points.push({ metric: "ga4_ai_sessions", day, value: total.sessions }, { metric: "ga4_ai_key_events", day, value: total.keyEvents });
  return points;
}
