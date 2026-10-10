"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isProblemNote, type SiteRecord } from "@organic-growth/core";
import { api, errorMessage, formatDay, formatNumber } from "./api";
import { AnalysisProgress, isFinished, useRun, type RunDelta, type RunProgress } from "./AnalysisProgress";
import { Heatmap, PairedBars, Scatter } from "./charts";
import { LeadFunnel, TechnicalTab, searchPoints, type Change } from "./ReportTabs";
import { AREA_PLACE, doFirst, gapsFirst, HEALTH_COLUMNS, pageTypeHealth, type Navigate, type Place, type Report } from "./report-model";
import { KeyNumbers, ProofHeadline } from "./results/sections";
import { AiPanel, CompetitorsPanel, EnquiriesPanel, KeywordsPanel, SearchPanel } from "./SitePanels";
import { HistoryPanel } from "./HistoryPanel";
import { ExportContext, ExportMenu } from "./export/ExportMenu";
import { backlogSheets, pageTypeSheets } from "./export/report-sheets";
import { useLeads, useResults, type Leads } from "./site-data";
import { Button, Card, ViewHeader } from "./ui";

export type Repository = { id: number; name: string; fullName: string; owner: string; defaultBranch: string; isPrivate: boolean };

type Tab = "overview" | "technical" | "search" | "enquiries" | "keywords" | "competitors" | "ai" | "history";
/** The first tab has no `?tab=`; the others' keys are what links carry. */
export const OVERVIEW_TABS: Array<{ tab: Tab; label: string }> = [
  { tab: "overview", label: "Overview" },
  { tab: "technical", label: "Technical" },
  { tab: "search", label: "Search" },
  { tab: "enquiries", label: "Enquiries" },
  { tab: "keywords", label: "Keywords" },
  { tab: "competitors", label: "Competitors" },
  { tab: "ai", label: "AI visibility" },
  { tab: "history", label: "History" },
];
const TABS = OVERVIEW_TABS;

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
 * The run a Sync now started, once it is recorded: every four seconds for up to
 * fifteen minutes (a site's 2,000 inspections can take twenty). Only a manual
 * run counts; a failed poll waits for the next tick; an instance that errored
 * ends the wait; `alive` ends it when the view is gone.
 */
async function waitForSyncRun(siteId: string, id: string, startedAt: string, alive: () => boolean): Promise<{ notes: string[] } | { failed: string } | null> {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline && alive()) {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    if (!alive()) return null;
    try {
      const { runs } = await api<{ runs: Array<{ trigger: string; startedAt: string; notes: string[] }> }>(`/api/sites/${siteId}/sync-runs`);
      const run = runs.find((entry) => entry.trigger === "manual" && entry.startedAt >= startedAt);
      if (run) return run;
      const instance = await api<{ status: string; error: string | null }>(`/api/sites/${siteId}/results/sync?id=${encodeURIComponent(id)}`);
      if (instance.status === "errored" || instance.status === "terminated") return { failed: instance.error ?? instance.status };
    } catch {
      // A failed poll is not a failed sync; the next tick asks again.
    }
  }
  return null;
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
  /** Whether the latest analysis has been read: until then the tabs say "Loading…", not "Run an analysis". */
  const [loaded, setLoaded] = useState(false);
  /** Null until the competitor list has loaded, so "Add competitors" shows only when there really are none. */
  const [competitorCount, setCompetitorCount] = useState<number | null>(null);
  const [markets, setMarkets] = useState(0);
  const leads = useLeads(site.id);
  const results = useResults(`/api/sites/${site.id}/results`);
  const reloadResults = results.reload;
  const current: Tab = TABS.find((entry) => entry.tab === tab && entry.tab !== "overview")?.tab ?? "overview";
  const [syncing, setSyncing] = useState(false);
  // The sync poll ends when this view (or this site's view) goes away.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, [site.id]);
  const [shared, setShared] = useState(false);

  const loadChanges = useCallback(async (analysisId: string) => {
    const data = await api<{ changes: Change[] }>(`/api/analyses/${analysisId}/changes`).catch(() => ({ changes: [] }));
    setChanges(data.changes);
  }, []);

  useEffect(() => {
    // Switching sites while these requests are in flight must not let the old site's answers land on the new one.
    let active = true;
    const loadChanges = async (analysisId: string) => {
      const data = await api<{ changes: Change[] }>(`/api/analyses/${analysisId}/changes`).catch(() => ({ changes: [] }));
      if (active) setChanges(data.changes);
    };
    setReport(null); setPendingId(""); setFinished(null); setNote(""); setError(""); setFailure(""); setChanges([]); setLoaded(false); setCompetitorCount(null);
    void (async () => {
      try {
        const latest = await api<{
          analysis: { analysisId: string; status: string; report?: Report; error?: string } | null;
          previous: { analysisId: string; report: Report } | null;
          pace: { perMinute: number } | null;
        }>(`/api/sites/${site.id}/analyses`);
        if (!active) return;
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
      } catch (cause) { if (active) setError(errorMessage(cause)); } finally { if (active) setLoaded(true); }
    })();
    api<{ domains: string[] }>(`/api/sites/${site.id}/competitors`).then((data) => { if (active) setCompetitorCount(data.domains.length); }).catch(() => { if (active) setCompetitorCount(0); });
    api<{ countries: string[] }>(`/api/sites/${site.id}/markets`).then((data) => { if (active) setMarkets(data.countries.length); }).catch(() => undefined);
    return () => { active = false; };
  }, [site.id]);

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
        // Site health on the Technical tab is written by the analysis.
        void reloadResults();
      } else if (job?.status === "cancelled") setNote(reportBefore.current ? "Analysis cancelled. The last report is still shown below." : "Analysis cancelled.");
      else setFailure(job?.error ?? run.error ?? "No error was recorded.");
      setPendingId("");
    })();
  }, [pendingId, run, loadChanges, reloadResults]);

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
  /** Opens the tab, or the page, that explains something. */
  const go = (place: Place) => (place.view === "overview" ? onTab(place.tab) : onNavigate(place.view, place.tab ?? undefined));

  /** Starts the sync workflow for this site (Search Console, Analytics, speed, authority, keywords, URL inspections) and waits for its run to be recorded. */
  async function syncNow() {
    setSyncing(true); setError("");
    try {
      const { id, startedAt } = await api<{ id: string; startedAt: string }>(`/api/sites/${site.id}/results/sync`, { method: "POST" });
      const run = await waitForSyncRun(site.id, id, startedAt, () => alive.current);
      if (!alive.current) return;
      if (!run) {
        setError("The sync is still running. Setup → Sync history shows its result when it finishes; the numbers refresh on the next load.");
        return;
      }
      if ("failed" in run) {
        setError(`Sync failed: ${run.failed}. Setup → Sync history keeps the details.`);
        return;
      }
      await reloadResults();
      // Say which sources failed, instead of numbers quietly not moving.
      const problems = run.notes.filter(isProblemNote);
      if (problems.length) setError(`Sync finished, but ${problems.length === 1 ? "one source" : `${problems.length} sources`} didn't update: ${problems.join("; ")}. Setup → Sync history keeps the details.`);
    } catch (cause) { setError(errorMessage(cause)); } finally { setSyncing(false); }
  }

  async function shareLink() {
    setError("");
    try {
      const { url } = await api<{ url: string }>(`/api/sites/${site.id}/share`, { method: "POST" });
      await navigator.clipboard.writeText(url);
      setShared(true);
    } catch (cause) { setError(errorMessage(cause)); }
  }

  return (
    <ExportContext.Provider value={{ siteId: site.id, siteName: site.name }}>
    <div>
      <ViewHeader
        title={site.name}
        description={<>Whether organic search is working for <a href={site.baseUrl} target="_blank" rel="noreferrer">{new URL(site.baseUrl).hostname}</a>, and what to do first.{results.data?.results.searchThrough ? ` Google data through ${formatDay(results.data.results.searchThrough)}.` : ""}</>}
        actions={(
          <div className="view-actions">
            <div className="row">
              <Button variant="ghost" onClick={shareLink}>{shared ? "Link copied" : "Copy client link"}</Button>
              <Button variant="secondary" busy={syncing} onClick={syncNow}>Sync now</Button>
              {!running && <Button busy={busy === "analysis"} onClick={() => runAnalysis()}>{run?.stalled ? "Start a new run" : report ? "Update analysis" : "Run analysis"}</Button>}
            </div>
            {!running && report && !run?.stalled && (
              <p className="view-note">
                Update reuses pages that haven't changed, or{" "}
                <button className="text-link" disabled={busy === "analysis"} onClick={() => runAnalysis(true)}>re-crawl all {formatNumber(report.sitemap.totalUrls)}</button>
                {pace ? ` (about ${Math.max(1, Math.round(report.sitemap.totalUrls / pace.perMinute))} min)` : ""}.
              </p>
            )}
          </div>
        )}
      />
      {error && <div className="callout error" role="alert" style={{ marginBottom: 14 }}>{error}</div>}
      {failure && <div className="callout error" role="alert" style={{ marginBottom: 14 }}>The last analysis stopped before it finished. Run it again; if it stops the same way, this is what failed:<div className="mono small" style={{ marginTop: 6, overflowWrap: "anywhere" }}>{failure}</div></div>}
      {note && <div className="callout" role="status" style={{ marginBottom: 14 }}>{note}</div>}
      {pendingId ? <AnalysisProgress run={run} analysisId={pendingId} />
        : finished && <AnalysisProgress run={finished.run} analysisId={finished.analysisId} finish={finished} onDismiss={() => setFinished(null)} />}
      <div className="tabs-bar">
        <div className="tabs report-tabs" role="tablist" aria-label="Report">
          {TABS.map((entry) => (
            <button key={entry.tab} role="tab" aria-selected={current === entry.tab} className={current === entry.tab ? "active" : undefined} onClick={() => openTab(entry.tab)}>{entry.label}</button>
          ))}
        </div>
      </div>
      <div key={current} className="view-enter" role="tabpanel">
        {!loaded || (current !== "overview" && current !== "technical" && current !== "history" && !results.data) ? <div className={results.error && loaded ? "callout error" : "empty"}>{loaded && results.error ? results.error : "Loading…"}</div> : (
          <>
            {current === "overview" && (
              <>
              <div className="results overview-proof">
                {results.data ? (
                  <>
                    <ProofHeadline data={results.data} operator onNavigate={onNavigate} />
                    <KeyNumbers data={results.data} operator />
                  </>
                ) : <Card title="Google clicks per week"><p className="empty-state">{results.error || "Loading…"}</p></Card>}
              </div>
              <button className="connections-strip" onClick={() => onNavigate("setup")}>
                <span className="connections-label">Connections</span>
                <span className="on">Website</span>
                <span className={hasRepo ? "on" : ""}>{hasRepo ? "GitHub" : "GitHub not connected"}</span>
                <span className={site.gscProperty ? "on" : ""}>{site.gscProperty ? "Search Console" : "Search Console missing"}</span>
                <span className={markets ? "on" : ""}>{markets ? `${markets} ${markets === 1 ? "market" : "markets"}` : "No markets"}</span>
                <span className={competitorCount ? "on" : ""}>{competitorCount ? `${competitorCount} ${competitorCount === 1 ? "competitor" : "competitors"}` : competitorCount === 0 ? "No competitors" : "Competitors"}</span>
                <span className="connections-open">Open Setup →</span>
              </button>
              <Briefing report={report} running={Boolean(pendingId)} leads={leads} hasSearch={Boolean(site.gscProperty)} competitorCount={competitorCount} onOpen={go} onNavigate={onNavigate} />
              </>
            )}
            {current === "technical" && <TechnicalTab siteId={site.id} report={report} results={results.data} running={Boolean(pendingId)} changes={changes} busy={busy} hasRepo={hasRepo} onGenerateChange={generateChange} onOpenPullRequest={openPullRequest} onRecrawl={() => runAnalysis(true)} onSetup={() => onNavigate("setup")} />}
            {results.data && current === "search" && <SearchPanel site={site} data={results.data} report={report} onNavigate={onNavigate} />}
            {results.data && current === "enquiries" && <EnquiriesPanel site={site} data={results.data} report={report} leads={leads} onNavigate={onNavigate} onLeadsChanged={() => void reloadResults()} />}
            {results.data && current === "keywords" && <KeywordsPanel site={site} data={results.data} onSaved={() => void reloadResults()} />}
            {results.data && current === "competitors" && <CompetitorsPanel site={site} data={results.data} report={report} onNavigate={onNavigate} onCompetitorsChanged={() => setCompetitorCount((count) => (count ?? 0) + 1)} />}
            {results.data && current === "ai" && <AiPanel site={site} data={results.data} report={report} onNavigate={onNavigate} onSaved={() => void reloadResults()} />}
            {current === "history" && <HistoryPanel siteId={site.id} onNavigate={onNavigate} />}
          </>
        )}
      </div>
    </div>
    </ExportContext.Provider>
  );
}

/** One screen: where pages break and what to do first, over one chart per area, each opening the page that explains it. */
function Briefing({ report, running, leads, hasSearch, competitorCount, onOpen, onNavigate }: {
  report: Report | null;
  running: boolean;
  leads: Leads;
  hasSearch: boolean;
  competitorCount: number | null;
  onOpen: (place: Place) => void;
  onNavigate: Navigate;
}) {
  const families = report?.coverage?.families ?? [];
  const actions = report ? doFirst(report, 10) : [];
  const open = (place: Place & { label: string }) => <Button small variant="ghost" onClick={() => onOpen(place)}>{place.label} →</Button>;
  const competition = report?.competition;
  const domains = competition?.competitors.filter((competitor) => competitor.analyzed).slice(0, 2) ?? [];
  const runFirst = running ? "Fills in when the analysis finishes." : "Run an analysis to fill this in.";
  return (
    <div className="results">
      <div className="ruled-grid c21">
        <Card title="Where pages break" subtitle="Page types by problem; darker means a larger share is affected." actions={<>{open(AREA_PLACE.technical)}{families.length > 0 && <ExportMenu title="Where pages break" sheets={() => pageTypeSheets(report)} />}</>}>
          {families.length
            ? <Heatmap caption="Problems per page type" columns={HEALTH_COLUMNS.map((column) => column.label)} rows={pageTypeHealth(families, 6)} />
            : <p className="empty-state">{report ? "Run a full analysis to check every page type." : runFirst}</p>}
        </Card>
        <Card title="Do first" subtitle={actions.length ? "The top of the growth plan, in priority order." : undefined} actions={actions.length > 0 && <ExportMenu title="Growth plan" sheets={() => backlogSheets(report)} />}>
          {actions.length ? (
            // Scrolls inside the card, so the list never makes the row taller than the heatmap beside it.
            <div className="do-first-scroll"><ol className="do-first">
              {actions.map((action, index) => (
                <li key={action.title}>
                  <button onClick={() => onOpen(AREA_PLACE[action.area])}>
                    <span className="do-first-rank">0{index + 1}</span>
                    <span className="do-first-title">{action.title}</span>
                    <span className="do-first-place">{AREA_PLACE[action.area].label} →</span>
                  </button>
                </li>
              ))}
            </ol></div>
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
            : competitorCount === null ? <p className="empty-state">Loading…</p>
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
