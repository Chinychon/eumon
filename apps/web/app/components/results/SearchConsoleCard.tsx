"use client";

import { useEffect, useState } from "react";
import type { TodayStatus } from "@organic-growth/core";
import type { SearchConsoleView } from "../../../src/search-console-import";
import { api, errorMessage, formatDay, formatNumber } from "../api";
import { LineChart } from "../charts";
import { ExportMenu } from "../export/ExportMenu";
import { searchConsoleSheets } from "../export/report-sheets";
import type { Navigate } from "../report-model";
import { Button, Card } from "../ui";

/*
 * Search Console's Page indexing exports, imported in Setup, reconciled with
 * today's crawl: what each URL Google listed under a reason is now, which
 * dead URLs should redirect where, and Google's own indexed counts over time.
 */

export const TODAY_LABEL: Array<{ status: TodayStatus; label: string }> = [
  { status: "indexable", label: "Indexable now" },
  { status: "noindex", label: "Still noindex" },
  { status: "redirect", label: "Redirects" },
  { status: "gone", label: "Gone (404/410)" },
  { status: "error", label: "Erroring" },
  { status: "unchecked", label: "Not checked yet" },
];

const SHOWN_SUGGESTIONS = 25;

/** A stacked bar of what a reason's URLs are today. */
function TodayBar({ today, total }: { today: Record<TodayStatus, number>; total: number }) {
  return (
    <span className="coverage-bar" role="img" aria-label={TODAY_LABEL.map(({ status, label }) => `${label} ${today[status]}`).join(", ")}>
      {total > 0 && TODAY_LABEL.map(({ status, label }) => today[status] > 0 && <i key={status} className={`today-${status}`} style={{ width: `${(today[status] / total) * 100}%` }} title={`${label}: ${formatNumber(today[status])}`} />)}
    </span>
  );
}

export function SearchConsoleCard({ siteId, onNavigate }: { siteId: string; onNavigate: Navigate }) {
  const [view, setView] = useState<SearchConsoleView | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setView(null);
    setError("");
    api<SearchConsoleView>(`/api/sites/${siteId}/search-console`).then(setView).catch((cause) => setError(errorMessage(cause)));
  }, [siteId]);
  const title = "Search Console: what Google says about each URL";
  if (error) return <Card title={title}><p className="empty-state">{error}</p></Card>;
  if (!view) return null;
  const empty = !view.reasons.length && !view.summary && !view.history.length;
  if (empty) {
    return (
      <Card title={title} subtitle="Google's Page indexing report has no API, but it exports. Import those exports and Eumon checks every URL against today's site.">
        <p className="empty-state">Nothing imported yet. In Setup → More sources, drop the report's exports: a reason's URL list, the overview table, or the chart.</p>
        <Button small variant="secondary" onClick={() => onNavigate("setup")}>Open Setup</Button>
      </Card>
    );
  }
  const indexed = view.summary?.rows.find((row) => row.reason === "indexed")?.pages ?? null;
  const known = view.summary ? view.summary.rows.reduce((total, row) => total + row.pages, 0) : null;
  const latest = view.history.at(-1);
  return (
    <Card title={title} actions={<ExportMenu title="Search Console import" sheets={() => searchConsoleSheets(view)} />}
      subtitle={`From exports of the Page indexing report${view.importedAt ? `, last imported ${formatDay(view.importedAt.slice(0, 10))}` : ""}. Each listed URL is checked against today's crawl; URLs no longer in the sitemap are fetched.`}>
      {(known !== null || latest) && (
        <p>
          {latest ? <>On {formatDay(latest.day)} Google had indexed <strong>{formatNumber(latest.indexed)}</strong> of the {formatNumber(latest.indexed + latest.notIndexed)} URLs it knows ({Math.round((latest.indexed / Math.max(1, latest.indexed + latest.notIndexed)) * 100)}%).</>
            : <>Google knows <strong>{formatNumber(known!)}</strong> URLs{indexed !== null ? <>, {formatNumber(indexed)} of them indexed ({Math.round((indexed / Math.max(1, known!)) * 100)}%)</> : null}.</>}
        </p>
      )}
      {view.history.length >= 2 && (
        <LineChart points={view.history.map((point) => ({ x: point.day, values: [point.indexed, point.notIndexed] }))} series={["Indexed", "Not indexed"]} />
      )}
      {view.reasons.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Why Google left it out</th><th className="num">URLs</th><th>What those URLs are today</th></tr></thead>
            <tbody>{view.reasons.map((entry) => (
              <tr key={entry.reason}>
                <td>{entry.reasonText}</td>
                <td className="num">{formatNumber(entry.urls)}</td>
                <td>
                  <TodayBar today={entry.today} total={entry.urls} />
                  <div className="chart-legend coverage-legend">
                    {TODAY_LABEL.filter(({ status }) => entry.today[status] > 0).map(({ status, label }) => <span key={status} className={`today-${status}`}>{label} {formatNumber(entry.today[status])}</span>)}
                  </div>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {view.summary && !view.reasons.length && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Reason</th><th className="num">Pages</th><th>Validation</th></tr></thead>
            <tbody>{view.summary.rows.map((row) => <tr key={row.reasonText}><td>{row.reasonText}</td><td className="num">{formatNumber(row.pages)}</td><td>{row.validation ?? "—"}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {view.remainingChecks > 0 && <p className="small muted">{formatNumber(view.remainingChecks)} imported URLs are outside today's sitemap and not fetched yet. Setup → More sources runs the checks.</p>}
      {view.suggestions.length > 0 && (
        <>
          <h4 style={{ margin: "16px 0 6px" }}>Redirect suggestions</h4>
          <p className="small muted">Gone URLs paired with the live page whose address contains every word of theirs. Export has them all.</p>
          <ul className="sync-notes">
            {view.suggestions.slice(0, SHOWN_SUGGESTIONS).map((entry) => <li key={entry.url}><span className="mono">{new URL(entry.url).pathname}</span> → <span className="mono">{new URL(entry.suggestedUrl).pathname}</span></li>)}
            {view.suggestions.length > SHOWN_SUGGESTIONS && <li>…and {formatNumber(view.suggestions.length - SHOWN_SUGGESTIONS)} more.</li>}
          </ul>
        </>
      )}
    </Card>
  );
}
