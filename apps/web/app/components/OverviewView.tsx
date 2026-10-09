"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SiteRecord } from "@organic-growth/core";
import { api, errorMessage, formatNumber } from "./api";
import { AnalysisProgress, isFinished, useRun, type RunDelta, type RunProgress } from "./AnalysisProgress";
import { Heatmap, PairedBars, Scatter } from "./charts";
import { LeadFunnel, TechnicalTab, searchPoints, type Change } from "./ReportTabs";
import { AREA_PLACE, doFirst, gapsFirst, HEALTH_COLUMNS, pageTypeHealth, type Navigate, type Place, type Report } from "./report-model";
import { KeyNumbers, ProofHeadline } from "./results/sections";
import { useLeads, useResults, type Leads } from "./site-data";
import { Button, Card, ViewHeader } from "./ui";

export type Repository = { id: number; name: string; fullName: string; owner: string; defaultBranch: string; isPrivate: boolean };

type Tab = "overview" | "technical";
const TABS: Array<{ tab: Tab; label: string }> = [
  { tab: "overview", label: "Overview" },
  { tab: "technical", label: "Technical" },
];

/** The figures a finished run compares with the report it replaced. */
function deltasBetween(before: Report | null, after: Report): RunDelta[] {
  return [
    { label: "Findings", before: before?.findings.length, after: after.findings.length, lowerIsBetter: true },
    { label: "Empty HTML", before: before?.coverage?.emptyShellUrls, after: after.coverage?.emptyShellUrls ?? 0, lowerIsBetter: true },
    { label: "HTTP errors", before: before?.coverage?.httpErrorUrls, after: after.coverage?.httpErrorUrls ?? 0, lowerIsBetter: true },
    { label: "Sitemap URLs", before: before?.sitemap.totalUrls, after: after.sitemap.totalUrls },
  ];
}

/**
 * Is it working, and what to do first: weekly Google clicks with the go-live
 * marked and the four key numbers, then the analysis run, the connections,
 * and two tabs: a one-screen briefing and the technical report. The open tab
 * lives in the address (`?tab=`), kept by the shell.
 */
export function OverviewView({ site, tab, onTab, onNavigate }: {
  site: SiteRecord;
  tab: string | null;
  onTab: (tab: string | null) => void;
  onNavigate: Navigate;
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [pendingId, setPendingId] = useState("");
  const [finished, setFinished] = useState<{ run: RunProgress; analysisId: string; deltas: RunDelta[]; first: boolean } | null>(null);
  const [note, setNote] = useState("");
  const [pace, setPace] = useState<{ perMinute: number } | null>(null);
  const [error, setError] = useState("");
  const [failure, setFailure] = useState("");
  const [changes, setChanges] = useState<Change[]>([]);
  const [busy, setBusy] = useState("");
  const [competitorCount, setCompetitorCount] = useState(0);
  const [markets, setMarkets] = useState(0);
  const leads = useLeads(site.id);
  const results = useResults(`/api/sites/${site.id}/results`);
  const current: Tab = tab === "technical" ? "technical" : "overview";

  const loadChanges = useCallback(async (analysisId: string) => {
    const data = await api<{ changes: Change[] }>(`/api/analyses/${analysisId}/changes`).catch(() => ({ changes: [] }));
    setChanges(data.changes);
  }, []);

  useEffect(() => {
    setReport(null); setPendingId(""); setFinished(null); setNote(""); setError(""); setChanges([]);
    void (async () => {
      try {
        const latest = await api<{
          analysis: { analysisId: string; status: string; report?: Report; error?: string } | null;
          previous: { analysisId: string; report: Report } | null;
          pace: { perMinute: number } | null;
        }>(`/api/sites/${site.id}/analyses`);
        setPace(latest.pace);
        if (latest.analysis?.status === "completed" && latest.analysis.report) {
          setReport(latest.analysis.report);
          void loadChanges(latest.analysis.analysisId);
        } else if (latest.analysis?.status === "queued" || latest.analysis?.status === "running") {
          setPendingId(latest.analysis.analysisId);
          if (latest.previous) {
            setReport(latest.previous.report);
            void loadChanges(latest.previous.analysisId);
          }
        } else {
          if (latest.analysis?.status === "failed") setFailure(latest.analysis.error ?? "No error was recorded.");
          if (latest.analysis?.status === "cancelled") setNote("The last run was cancelled. This is the report from the run before it.");
          // A cancelled or failed run leaves the last finished report in place.
          if (latest.previous) {
            setReport(latest.previous.report);
            void loadChanges(latest.previous.analysisId);
          }
        }
      } catch (cause) { setError(errorMessage(cause)); }
    })();
    api<{ domains: string[] }>(`/api/sites/${site.id}/competitors`).then((data) => setCompetitorCount(data.domains.length)).catch(() => undefined);
    api<{ countries: string[] }>(`/api/sites/${site.id}/markets`).then((data) => setMarkets(data.countries.length)).catch(() => undefined);
  }, [site.id, loadChanges]);

  const run = useRun(pendingId, site.id, new URL(site.baseUrl).hostname);
  const reportBefore = useRef(report);
  reportBefore.current = report;
  useEffect(() => {
    if (!pendingId || !run || !isFinished(run.status)) return;
    void (async () => {
      const job = await api<{ status: string; report?: Report; error?: string }>(`/api/analyses/${pendingId}`).catch(() => null);
      if (job?.status === "completed" && job.report) {
        // The card stays to say what changed, and the garden blooms; the new report renders below it.
        setFinished({ run, analysisId: pendingId, deltas: deltasBetween(reportBefore.current, job.report), first: !reportBefore.current });
        setReport(job.report);
        void loadChanges(pendingId);
      } else if (job?.status === "cancelled") setNote(reportBefore.current ? "Analysis cancelled. The last report is still shown below." : "Analysis cancelled.");
      else setFailure(job?.error ?? run.error ?? "No error was recorded.");
      setPendingId("");
    })();
  }, [pendingId, run, loadChanges]);

  /** A stalled run no longer blocks the header action, so a new run can replace it. */
  const running = Boolean(pendingId) && !run?.stalled;

  /** `full` fetches every sitemap URL again; otherwise unchanged pages from the last crawl are reused. */
  async function runAnalysis(full = false) {
    setError(""); setFailure(""); setNote(""); setFinished(null); setBusy("analysis");
    try {
      const queued = await api<{ analysisId: string }>(`/api/sites/${site.id}/analyses`, { method: "POST", json: { full } });
      setPendingId(queued.analysisId);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  async function generateChange(findingId: string) {
    if (!report) return;
    setBusy(findingId); setError("");
    try {
      const data = await api<{ change: Change }>(`/api/analyses/${report.analysisId}/changes`, { method: "POST", json: { findingId } });
      setChanges((items) => [...items, data.change]);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  async function openPullRequest(change: Change) {
    setBusy(change.id); setError("");
    try {
      const data = await api<{ pullRequest: { url: string } }>(`/api/changes/${change.id}/pull-request`, { method: "POST" });
      setChanges((items) => items.map((item) => (item.id === change.id ? { ...item, prUrl: data.pullRequest.url } : item)));
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  const hasRepo = Boolean(site.githubRepo);
  const openTab = (next: Tab) => onTab(next === "overview" ? null : next);
  /** Opens the page and tab that explain something; the Technical tab is on this page. */
  const go = (place: Place) => (place.view === "overview" ? openTab(place.tab === "technical" ? "technical" : "overview") : onNavigate(place.view, place.tab ?? undefined));

  return (
    <div>
      <ViewHeader
        title={site.name}
        description={<>Whether organic search is working for <a href={site.baseUrl} target="_blank" rel="noreferrer">{site.baseUrl}</a>, what to do first, and what Google receives from it.</>}
        actions={running ? undefined : (
          <div className="view-actions">
            <div className="row">
              {report && <Button variant="ghost" disabled={busy === "analysis"} onClick={() => runAnalysis(true)}>Re-crawl every page</Button>}
              <Button busy={busy === "analysis"} onClick={() => runAnalysis()}>{run?.stalled ? "Start a new run" : report ? "Update analysis" : "Run analysis"}</Button>
            </div>
            {report && !run?.stalled && (
              <p className="view-note">
                Update reuses pages that haven't changed.{pace ? ` Re-crawling all ${formatNumber(report.sitemap.totalUrls)} takes about ${Math.max(1, Math.round(report.sitemap.totalUrls / pace.perMinute))} min.` : ""}
              </p>
            )}
          </div>
        )}
      />
      {error && <div className="callout error" role="alert" style={{ marginBottom: 14 }}>{error}</div>}
      {failure && <div className="callout error" role="alert" style={{ marginBottom: 14 }}>The last analysis stopped before it finished. Run it again; if it stops the same way, this is what failed:<div className="mono small" style={{ marginTop: 6, overflowWrap: "anywhere" }}>{failure}</div></div>}
      {note && <div className="callout" role="status" style={{ marginBottom: 14 }}>{note}</div>}
      <div className="results overview-proof">
        {results.data ? (
          <>
            <ProofHeadline data={results.data} operator onNavigate={onNavigate} />
            <KeyNumbers data={results.data} operator />
          </>
        ) : <Card title="Google clicks per week"><p className="empty-state">{results.error || "Loading…"}</p></Card>}
      </div>
      {pendingId ? <AnalysisProgress run={run} analysisId={pendingId} />
        : finished && <AnalysisProgress run={finished.run} analysisId={finished.analysisId} finish={finished} onDismiss={() => setFinished(null)} />}
      <button className="connections-strip" onClick={() => onNavigate("setup")}>
        <span className="connections-label">Connections</span>
        <span className="on">Website</span>
        <span className={hasRepo ? "on" : ""}>{hasRepo ? "GitHub" : "GitHub not connected"}</span>
        <span className={site.gscProperty ? "on" : ""}>{site.gscProperty ? "Search Console" : "Search Console missing"}</span>
        <span className={markets ? "on" : ""}>{markets ? `${markets} ${markets === 1 ? "market" : "markets"}` : "No markets"}</span>
        <span className={competitorCount ? "on" : ""}>{competitorCount ? `${competitorCount} ${competitorCount === 1 ? "competitor" : "competitors"}` : "No competitors"}</span>
        <span className="connections-open">Open Setup →</span>
      </button>

      <div className="tabs report-tabs" role="tablist" aria-label="Report">
        {TABS.map((entry) => (
          <button key={entry.tab} role="tab" aria-selected={current === entry.tab} className={current === entry.tab ? "active" : undefined} onClick={() => openTab(entry.tab)}>{entry.label}</button>
        ))}
      </div>
      <div key={current} className="view-enter" role="tabpanel">
        {current === "overview" && <Briefing report={report} running={Boolean(pendingId)} leads={leads} hasSearch={Boolean(site.gscProperty)} competitorCount={competitorCount} onOpen={go} onNavigate={onNavigate} />}
        {current === "technical" && <TechnicalTab siteId={site.id} report={report} results={results.data} changes={changes} busy={busy} hasRepo={hasRepo} onGenerateChange={generateChange} onOpenPullRequest={openPullRequest} onRecrawl={() => runAnalysis(true)} />}
      </div>
    </div>
  );
}

/** One screen: where pages break and what to do first, over one chart per area, each opening the page that explains it. */
function Briefing({ report, running, leads, hasSearch, competitorCount, onOpen, onNavigate }: {
  report: Report | null;
  running: boolean;
  leads: Leads;
  hasSearch: boolean;
  competitorCount: number;
  onOpen: (place: Place) => void;
  onNavigate: Navigate;
}) {
  const families = report?.coverage?.families ?? [];
  const actions = report ? doFirst(report) : [];
  const open = (place: Place & { label: string }) => <Button small variant="ghost" onClick={() => onOpen(place)}>{place.label} →</Button>;
  const competition = report?.competition;
  const domains = competition?.competitors.filter((competitor) => competitor.analyzed).slice(0, 2) ?? [];
  const runFirst = running ? "Fills in when the analysis finishes." : "Run an analysis to fill this in.";
  return (
    <div className="results">
      <div className="ruled-grid c21">
        <Card title="Where pages break" subtitle="Page types by problem; darker means a larger share is affected." actions={open(AREA_PLACE.technical)}>
          {families.length
            ? <Heatmap caption="Problems per page type" columns={HEALTH_COLUMNS.map((column) => column.label)} rows={pageTypeHealth(families, 6)} />
            : <p className="empty-state">{report ? "Run a full analysis to check every page type." : runFirst}</p>}
        </Card>
        <Card title="Do first" subtitle={actions.length ? "The top of the growth plan, in priority order." : undefined}>
          {actions.length ? (
            <ol className="do-first">
              {actions.map((action, index) => (
                <li key={action.title}>
                  <button onClick={() => onOpen(AREA_PLACE[action.area])}>
                    <span className="do-first-rank">0{index + 1}</span>
                    <span className="do-first-title">{action.title}</span>
                    <span className="do-first-place">{AREA_PLACE[action.area].label} →</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : <p className="empty-state">{report ? "Nothing to do first in this analysis." : running ? "The backlog fills in when the analysis finishes." : "Run an analysis to see what to do first."}</p>}
        </Card>
      </div>
      <div className="ruled-grid c3">
        <Card title="Almost on page one" actions={open(AREA_PLACE.search)}>
          {report?.search?.strikingDistance.length
            ? <><Scatter points={searchPoints(report.search)} band={[4, 15]} xLabel="Position" yLabel="impressions" /><p className="small muted brief-note">{report.search.strikingDistance.length} queries at positions 4–15</p></>
            : report?.search ? <p className="empty-state">No queries sit just below page one.</p>
            : !hasSearch ? <><p className="empty-state">Connect Search Console to see the queries closest to page one.</p><Button small variant="secondary" onClick={() => onNavigate("setup")}>Connect</Button></>
            : <p className="empty-state">{report ? "The last analysis ran before Search Console was connected. Run it again to see these." : runFirst}</p>}
        </Card>
        <Card title="You vs competitors" actions={open(AREA_PLACE.competitors)}>
          {competition?.rows.length
            ? <PairedBars series={["You", ...domains.map((competitor) => competitor.domain)]} groups={gapsFirst(competition).slice(0, 3).map((row) => ({
                label: row.label,
                values: [row.you.pages, ...domains.map((competitor) => row.competitors.find((entry) => entry.domain === competitor.domain)?.pages ?? 0)],
              }))} />
            : !competitorCount ? <><p className="empty-state">Add competitor domains to compare what you publish.</p><Button small variant="secondary" onClick={() => onNavigate("setup")}>Add competitors</Button></>
            : <p className="empty-state">{report ? "Run the analysis again to compare with the competitors you added." : runFirst}</p>}
        </Card>
        <Card title="Visit to lead · 28 days" actions={open(AREA_PLACE.leads)}>
          <LeadFunnel leads={leads} onNavigate={onNavigate} />
        </Card>
      </div>
    </div>
  );
}
