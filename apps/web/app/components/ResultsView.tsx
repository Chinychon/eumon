"use client";

import { useState } from "react";
import type { SiteRecord } from "@organic-growth/core";
import { api, errorMessage, formatDay } from "./api";
import { ConversionSections, IndexCoverageCard, SearchAnalysis } from "./ReportTabs";
import type { Navigate } from "./report-model";
import { ConnectPrompt, EnquiriesCard, GoogleSearchCard, OrganicSessions } from "./results/sections";
import { useLatestReport, useLeads, useResults } from "./site-data";
import { Button, Card, ViewHeader } from "./ui";

const TABS = [
  { tab: "search", label: "Search" },
  { tab: "enquiries", label: "Enquiries" },
] as const;

/**
 * How search and enquiries are going, each on one tab: the daily sync's
 * trends first, then what the latest analysis found. The proof (clicks
 * since go-live, the key numbers) leads the Overview; the client link
 * stacks every section into one report (`ClientReport`).
 */
export function ResultsView({ site, tab, onTab, onNavigate }: { site: SiteRecord; tab: string | null; onTab: (tab: string | null) => void; onNavigate: Navigate }) {
  const endpoint = `/api/sites/${site.id}/results`;
  const { data, error, reload } = useResults(endpoint);
  const { report, error: reportError } = useLatestReport(site.id);
  const analysisError = reportError && <div className="callout error" role="alert">The latest analysis couldn't be loaded: {reportError}</div>;
  const leads = useLeads(site.id);
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [shared, setShared] = useState(false);
  const current = tab === "enquiries" ? "enquiries" : "search";

  async function syncNow() {
    setSyncing(true); setActionError("");
    try {
      await api(`${endpoint}/sync`, { method: "POST" });
      await reload();
    } catch (cause) { setActionError(errorMessage(cause)); } finally { setSyncing(false); }
  }

  async function shareLink() {
    setActionError("");
    try {
      const { url } = await api<{ url: string }>(`/api/sites/${site.id}/share`, { method: "POST" });
      await navigator.clipboard.writeText(url);
      setShared(true);
    } catch (cause) { setActionError(errorMessage(cause)); }
  }

  if (error) return <div className="callout error" role="alert">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;
  const { results } = data;

  return (
    <div>
      <ViewHeader
        title="Performance"
        description={<>Google search and enquiries for {new URL(site.baseUrl).hostname}. {results.searchThrough ? `Google data through ${formatDay(results.searchThrough)}.` : "Google data appears after the first sync."}</>}
        actions={(
          <div className="row">
            <Button variant="ghost" onClick={shareLink}>{shared ? "Link copied" : "Copy client link"}</Button>
            <Button variant="secondary" busy={syncing} onClick={syncNow}>Sync now</Button>
          </div>
        )}
      />
      {actionError && <div className="callout error" role="alert" style={{ marginBottom: 14 }}>{actionError}</div>}
      <div className="tabs report-tabs" role="tablist" aria-label="Performance">
        {TABS.map((entry) => (
          <button key={entry.tab} role="tab" aria-selected={current === entry.tab} className={current === entry.tab ? "active" : undefined} onClick={() => onTab(entry.tab === "search" ? null : entry.tab)}>{entry.label}</button>
        ))}
      </div>
      <div key={current} className="view-enter" role="tabpanel">
        {current === "search" ? (
          <div className="results">
            {!data.site.searchConnected ? (
              <>
                {/* One prompt, not a page of empty cards. */}
                <Card title="Google search" subtitle="Clicks, impressions, positions, top queries, the queries closest to page one, and which sitemap URLs Google has indexed.">
                  <ConnectPrompt operator what="Search Console" onNavigate={onNavigate} />
                </Card>
                {results.organic && <Card title="Organic sessions"><OrganicSessions data={data} operator /></Card>}
              </>
            ) : (
              <>
                <GoogleSearchCard data={data} operator onNavigate={onNavigate} />
                {analysisError || (report && report.search ? <SearchAnalysis report={report} /> : report !== undefined && (
                  <Card title="Queries near page one">
                    <p className="empty-state">Run an analysis on the Overview to see the queries closest to page one, where searchers are, and the pages searchers skip.</p>
                    <Button small variant="secondary" onClick={() => onNavigate("overview")}>Open Overview</Button>
                  </Card>
                ))}
                <IndexCoverageCard siteId={site.id} onNavigate={onNavigate} />
              </>
            )}
          </div>
        ) : (
          <div className="results">
            <EnquiriesCard data={data} operator />
            {analysisError}
            <ConversionSections report={report ?? null} leads={leads} onNavigate={onNavigate} />
          </div>
        )}
      </div>
    </div>
  );
}
