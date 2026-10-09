"use client";

import { useCallback, useEffect, useState } from "react";
import type { ResultsView as Results } from "@organic-growth/core";
import { api, errorMessage } from "./api";
import type { Report } from "./report-model";

/*
 * The three reads several pages share: the synced numbers, the latest
 * finished analysis, and the landing pages' leads. Each page that shows a
 * card loads what the card needs; no endpoint knows about pages.
 */

export type Payload = { site: { name: string; baseUrl: string; searchConnected: boolean; analytics: "connected" | "reconnect" | "none"; signals: { speed: boolean; authority: boolean; keywords: boolean; bing: boolean } }; results: Results };

/** The synced numbers (Search Console, GA4, speed, authority, keywords). `reload` refetches after a sync. */
export function useResults(endpoint: string) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => api<Payload>(endpoint).then((payload) => { setData(payload); setError(""); }).catch((cause) => setError(errorMessage(cause))), [endpoint]);
  useEffect(() => { setData(null); setError(""); void reload(); }, [reload]);
  return { data, error, reload };
}

/** The latest finished analysis report: `undefined` while loading, `null` when no analysis has finished. `error` is set when it couldn't be read, so a failure isn't mistaken for "no analysis". */
export function useLatestReport(siteId: string) {
  const [state, setState] = useState<{ report: Report | null | undefined; error: string }>({ report: undefined, error: "" });
  useEffect(() => {
    setState({ report: undefined, error: "" });
    api<{ analysis: { status: string; report?: Report } | null; previous: { report: Report } | null }>(`/api/sites/${siteId}/analyses`)
      .then((latest) => setState({ report: latest.analysis?.status === "completed" && latest.analysis.report ? latest.analysis.report : latest.previous?.report ?? null, error: "" }))
      .catch((cause) => setState({ report: null, error: errorMessage(cause) }));
  }, [siteId]);
  return state;
}

export type Leads = { pages: number; views: number; ctaClicks: number; conversions: number; events28: number } | null;

/** Views, CTA clicks and leads on the landing pages over 28 days, and every conversion event tracked on the site. */
export function useLeads(siteId: string): Leads {
  const [leads, setLeads] = useState<Leads>(null);
  useEffect(() => {
    setLeads(null);
    void Promise.all([
      api<{ report: { totals: { pages: number; views: number; ctaClicks: number; conversions: number } } }>(`/api/sites/${siteId}/performance?days=28`).catch(() => null),
      api<{ last28Days: number }>(`/api/sites/${siteId}/events/summary`).catch(() => null),
    ]).then(([performance, summary]) => {
      const totals = performance?.report.totals;
      setLeads({ pages: totals?.pages ?? 0, views: totals?.views ?? 0, ctaClicks: totals?.ctaClicks ?? 0, conversions: totals?.conversions ?? 0, events28: summary?.last28Days ?? 0 });
    });
  }, [siteId]);
  return leads;
}
