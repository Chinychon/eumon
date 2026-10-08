/*
 * Google Analytics 4: the properties a Google connection can read, and daily
 * sessions with the Organic Search share, for the Results ledger.
 */

export type Ga4Day = { day: string; sessions: number; organicSessions: number; organicEngagedSessions: number; organicKeyEvents: number };

export async function listGa4Properties(accessToken: string, fetchFn: typeof fetch = fetch): Promise<Array<{ property: string; name: string }>> {
  const properties: Array<{ property: string; name: string }> = [];
  let pageToken = "";
  do {
    const response = await fetchFn(`https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`Google Analytics properties request failed (${response.status}).`);
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
  if (!response.ok) throw new Error(`Google Analytics report request failed (${response.status}).`);
  return ga4Days(await response.json());
}
