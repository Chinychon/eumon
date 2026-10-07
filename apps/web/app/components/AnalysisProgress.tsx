"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ApiError, api, formatNumber } from "./api";
import { Button, CheckIcon, Kpi } from "./ui";

/** `GET /api/analyses/:id/progress`. */
export type RunProgress = {
  status: string;
  progress?: { stage: string; message: string; detail?: Record<string, string | number>; history?: Array<{ stage: string; at: string }>; updatedAt?: string };
  error?: string;
  summary?: string;
  stalled: boolean;
  queuedAt: string;
  now: string;
  crawl: {
    total: number; pending: number; crawled: number; failed: number; blocked: number; reused: number;
    ok: number; httpErrors: number; emptyShells: number; noindex: number; challenges: number;
    perMinute?: number; secondsLeft?: number;
    families: Array<{ family: string; total: number; done: number; fetched: number; emptyShells: number; errors: number }>;
    recent: Array<{ url: string; status: number | null; family: string; emptyShell: boolean; failed: boolean; crawledAt: string }>;
  };
};

const STAGES = [
  { key: "sitemap", label: "Sitemap", title: "Reading the sitemap", tab: "Reading sitemap" },
  { key: "crawl", label: "Crawl", title: "Crawling as Googlebot", tab: "Crawling" },
  { key: "competitors", label: "Competitors", title: "Reading competitor sites", tab: "Reading competitors" },
  { key: "analysis", label: "Analysis", title: "Analyzing what Google receives", tab: "Analyzing" },
  { key: "saving", label: "Saving", title: "Saving the report", tab: "Saving" },
];

export const isFinished = (status?: string) => status === "completed" || status === "failed";

export const familyLabel = (family: string) => (family === "home" ? "Homepage" : family === "page" ? "Top-level pages" : `/${family}/`);

const duration = (ms: number) => {
  if (ms < 1000) return "under 1 s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

/*
 * Runs are polled outside React so polling outlasts the Overview: on any
 * view, the tab title keeps counting and the finish still notifies.
 */
type Watch = { siteId: string; siteName: string; data?: RunProgress };
const watches = new Map<string, Watch>();
const listeners = new Set<() => void>();
const subscribe = (onChange: () => void) => { listeners.add(onChange); return () => { listeners.delete(onChange); }; };
let baseTitle = "";

/** What a run is doing in a few words, for the tab title and the top bar. */
export function runLabel(run: RunProgress) {
  if (run.stalled) return "Analysis stopped";
  const stage = STAGES.find((entry) => entry.key === run.progress?.stage);
  const work = run.crawl.crawled + run.crawl.pending;
  return stage?.key === "crawl" && work ? `${Math.floor((run.crawl.crawled / work) * 100)}% crawled` : stage?.tab ?? "Starting";
}

function announce(run: RunProgress, entry: Watch) {
  if (document.hasFocus()) { document.title = baseTitle; return; }
  const text = `${run.status === "completed" ? "Analysis finished" : "Analysis stopped"} · ${entry.siteName}`;
  document.title = text;
  window.addEventListener("focus", () => { document.title = baseTitle; }, { once: true });
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    const note = new Notification(text, { body: run.status === "completed" ? run.summary ?? "The report is ready." : run.error ?? "", tag: entry.siteId });
    note.onclick = () => { window.focus(); note.close(); };
  }
}

function watch(analysisId: string, siteId: string, siteName: string) {
  if (watches.has(analysisId)) return;
  // A new run supersedes the site's older ones (a stalled run that was started again stops polling).
  for (const [id, other] of watches) if (other.siteId === siteId) watches.delete(id);
  const entry: Watch = { siteId, siteName };
  watches.set(analysisId, entry);
  baseTitle ||= document.title;
  const tick = async () => {
    if (watches.get(analysisId) !== entry) return;
    try {
      const run = await api<RunProgress>(`/api/analyses/${analysisId}/progress`);
      entry.data = run;
      for (const listener of listeners) listener();
      if (isFinished(run.status)) return announce(run, entry);
      document.title = run.stalled ? baseTitle : `${runLabel(run)} · ${siteName}`;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return;
    }
    setTimeout(tick, entry.data?.stalled ? 15_000 : 2500);
  };
  void tick();
}

/** Live progress of one analysis, polled every few seconds until it finishes. */
export function useRun(analysisId: string, siteId: string, siteName: string) {
  useEffect(() => { if (analysisId) watch(analysisId, siteId, siteName); }, [analysisId, siteId, siteName]);
  return useSyncExternalStore(subscribe, () => (analysisId ? watches.get(analysisId)?.data : undefined), () => undefined);
}

/** The unfinished run of a site that is being watched, for the top bar on other views. */
export function useSiteRun(siteId: string) {
  return useSyncExternalStore(subscribe, () => {
    for (const entry of watches.values()) if (entry.siteId === siteId && entry.data && !isFinished(entry.data.status)) return entry.data;
    return undefined;
  }, () => undefined);
}

function NotifyWhenDone() {
  const [permission, setPermission] = useState(() => (typeof Notification === "undefined" ? "unsupported" : Notification.permission));
  if (permission === "unsupported") return null;
  if (permission === "granted") return <span className="run-note">You'll get a notification when it finishes</span>;
  if (permission === "denied") return <span className="run-note">Notifications are blocked for this site in your browser settings</span>;
  return <Button small variant="ghost" onClick={async () => setPermission(await Notification.requestPermission())}>Notify me when it finishes</Button>;
}

/** Progress in two parts: what this run fetched (green) after what it carried over from the last analysis or skipped (gray). */
function SplitBar({ carried, fetched, total, label }: { carried: number; fetched: number; total: number; label: string }) {
  const share = (count: number) => (total > 0 ? Math.min(100, (count / total) * 100) : 0);
  return (
    <div className="progress run-split" role="progressbar" aria-label={label} aria-valuenow={Math.floor(share(carried + fetched))} aria-valuemin={0} aria-valuemax={100}>
      <b style={{ transform: `scaleX(${share(carried) / 100})` }} />
      <i style={{ transform: `translateX(${share(carried)}%) scaleX(${share(fetched) / 100})` }} />
    </div>
  );
}

/** A URL path with its last segment kept whole: the folder gives way first when space runs out. */
function PagePath({ url }: { url: string }) {
  const path = new URL(url).pathname;
  const cut = path.replace(/\/$/, "").lastIndexOf("/") + 1;
  return <code className="run-path-text"><span>{path.slice(0, cut)}</span><span>{path.slice(cut) || "/"}</span></code>;
}

/** What a running analysis is doing: stage timeline, crawl progress with pace and time left, and what the crawl has found so far. */
export function AnalysisProgress({ run }: { run?: RunProgress }) {
  if (!run) {
    return <section className="run" aria-busy="true"><div className="panel run-head"><div className="panel-heading"><h3>Starting the analysis</h3></div></div></section>;
  }
  const now = Date.parse(run.now);
  const { crawl, progress } = run;
  const history = progress?.history ?? [];
  const current = STAGES.findIndex((stage) => stage.key === progress?.stage);
  const stage = STAGES[current];
  const timeIn = (key: string) => {
    const index = history.findIndex((entry) => entry.stage === key);
    if (index < 0) return undefined;
    const end = history[index + 1]?.at ?? (key === stage?.key ? run.now : undefined);
    return end ? duration(Date.parse(end) - Date.parse(history[index]!.at)) : undefined;
  };

  const detail = progress?.detail;
  const activity = detail?.competitor ? `${progress?.message} (${Number(detail.done) + 1} of ${detail.of})` : progress?.message;
  const quiet = now - Date.parse(progress?.updatedAt ?? run.queuedAt);
  const title = run.stalled ? "Analysis stopped" : stage?.title ?? "Starting the analysis";
  const subtitle = run.stalled ? (activity ? `Last step: ${activity}` : undefined)
    : !stage ? "Waiting for the run to start."
    : stage.key === "crawl" ? "Every sitemap URL, fetched the way Google fetches it."
    : activity;

  const done = crawl.total - crawl.pending;
  const crawlDone = crawl.total > 0 && crawl.pending === 0;
  const swatches = crawl.reused > 0;
  const fetchedLabel = `${formatNumber(crawl.crawled)} fetched${crawlDone && timeIn("crawl") ? ` in ${timeIn("crawl")}` : ""}`;
  const pace: ReactNode[] = [swatches ? <span key="fetched" className="run-key fetched">{fetchedLabel}</span> : fetchedLabel];
  if (swatches) pace.push(<span key="reused" className="run-key reused">{formatNumber(crawl.reused)} reused from the last analysis</span>);
  if (!crawlDone && !run.stalled) {
    if (crawl.perMinute && crawl.secondsLeft !== undefined) {
      pace.push(`${formatNumber(crawl.perMinute)} pages a minute`, crawl.secondsLeft < 60 ? "under a minute left" : `about ${duration(crawl.secondsLeft * 1000)} left`);
    } else if (crawl.crawled + crawl.pending > 0) pace.push("measuring the pace");
  }
  // Crawl batches report every few seconds, so a quiet crawl is worth saying; other stages can be quiet for minutes.
  if (stage?.key === "crawl" && !run.stalled && quiet > 3 * 60_000) pace.push(`last update ${duration(quiet)} ago`);
  const errors = crawl.failed + crawl.httpErrors + crawl.challenges;

  return (
    <section className={`run${run.stalled ? " stalled" : ""}`} aria-label="Analysis progress">
      <div className="panel run-head">
        <div className="panel-heading">
          <div>
            <h3 aria-live="polite">{title}</h3>
            {subtitle && <p className="run-sub">{subtitle}</p>}
          </div>
          <div className="row">
            {!run.stalled && <NotifyWhenDone />}
            <span className="count-pill">{duration(now - Date.parse(run.queuedAt))} elapsed</span>
          </div>
        </div>
        {run.stalled && (
          <div className="callout warn" role="alert">
            Nothing has moved for {duration(quiet)}, so this run has most likely stopped, for example because the server restarted. Start a new run to continue.
          </div>
        )}
      </div>

      <ol className="run-stages">
        {STAGES.map((entry, index) => {
          const state = index < current ? "done" : index === current ? "active" : "next";
          return (
            <li key={entry.key} className={state} aria-current={state === "active" ? "step" : undefined}>
              <span className="run-stage-name"><i>{state === "done" && <CheckIcon />}</i>{entry.label}</span>
              <span className="run-stage-time">{state === "active" && run.stalled ? "Stopped" : state === "next" ? "" : timeIn(entry.key) ?? (state === "done" ? "Done" : "")}</span>
            </li>
          );
        })}
      </ol>

      {crawl.total > 0 && (
        <>
          <div className="panel run-crawl">
            <div className="run-crawl-head">
              <span><strong className="run-count">{formatNumber(done)}</strong> of {formatNumber(crawl.total)} sitemap URLs</span>
              <span className="run-percent">{Math.floor((done / crawl.total) * 100)}%</span>
            </div>
            <SplitBar carried={done - crawl.crawled} fetched={crawl.crawled} total={crawl.total} label="Crawl progress" />
            <p className="run-pace">{pace.map((item, index) => <span key={index}>{index > 0 && " · "}{item}</span>)}</p>
          </div>

          <div className="kpi-grid run-tallies">
            <Kpi label="Served" value={formatNumber(crawl.ok)} caption="Answered with a page" />
            <Kpi label="Empty HTML" value={formatNumber(crawl.emptyShells)} caption="No content without JavaScript" />
            <Kpi label="Errors" value={formatNumber(errors)} caption={crawl.challenges ? `Includes ${formatNumber(crawl.challenges)} bot challenges` : "4xx, 5xx, or no answer"} />
            <Kpi label="Noindex" value={formatNumber(crawl.noindex)} caption="Asks Google not to index" />
            <Kpi label="Blocked" value={formatNumber(crawl.blocked)} caption="By robots.txt, not fetched" />
          </div>

          <div className="run-columns">
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Page type</th><th>Progress</th><th className="num">Done</th><th className="num run-wide">Empty HTML</th><th className="num run-wide">Errors</th></tr></thead>
                <tbody>{crawl.families.slice(0, 8).map((family) => (
                  <tr key={family.family}>
                    <td><code>{familyLabel(family.family)}</code></td>
                    <td className="run-bar"><SplitBar carried={family.done - family.fetched} fetched={family.fetched} total={family.total} label={`${familyLabel(family.family)} progress`} /></td>
                    <td className="num">{formatNumber(family.done)} / {formatNumber(family.total)}</td>
                    <td className="num run-wide">{family.emptyShells ? <span className="bad-count">{formatNumber(family.emptyShells)}</span> : <span className="muted">0</span>}</td>
                    <td className="num run-wide">{family.errors ? <span className="bad-count">{formatNumber(family.errors)}</span> : <span className="muted">0</span>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Latest pages</th><th className="num">Fetched</th></tr></thead>
                <tbody>{crawl.recent.length ? crawl.recent.map((page) => {
                  const age = now - Date.parse(page.crawledAt);
                  return (
                    <tr key={page.url} className="run-arrive">
                      <td className="run-path-cell" title={page.url}>
                        <div className="run-path">
                          <PagePath url={page.url} />
                          {page.failed ? <span className="badge badge-red">Failed</span>
                            : page.status !== null && page.status >= 400 ? <span className="badge badge-red">{page.status}</span>
                            : page.emptyShell ? <span className="badge badge-red">Empty HTML</span> : null}
                        </div>
                      </td>
                      <td className="num">{age < 5000 ? "just now" : `${duration(age)} ago`}</td>
                    </tr>
                  );
                }) : <tr><td colSpan={2} className="muted">Nothing fetched yet in this run</td></tr>}</tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
