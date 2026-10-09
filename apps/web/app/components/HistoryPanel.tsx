"use client";

import { useEffect, useState } from "react";
import type { History, HistoryRow } from "../../src/history";
import { api, errorMessage, formatDay } from "./api";
import { ExportMenu } from "./export/ExportMenu";
import { AREA_PLACE, findingArea, type Navigate } from "./report-model";
import { Badge, Card, Kpi } from "./ui";

/*
 * The Dashboard's History tab: what was wrong and is gone, who fixed it, and
 * every change made through Eumon, newest first.
 */

const LABEL: Record<HistoryRow["kind"], { text: string; tone: string }> = {
  fixed: { text: "Fixed with Eumon", tone: "green" },
  resolved: { text: "Resolved", tone: "green" },
  vanished: { text: "No longer applies", tone: "gray" },
  change: { text: "Pull request", tone: "amber" },
  edit: { text: "Page edit", tone: "amber" },
  cta: { text: "CTA test", tone: "amber" },
  publish: { text: "Published", tone: "amber" },
};
const day = (iso: string) => formatDay(iso.slice(0, 10));

export function HistoryPanel({ siteId, onNavigate }: { siteId: string; onNavigate: Navigate }) {
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setHistory(null);
    setError("");
    api<History>(`/api/sites/${siteId}/history`).then(setHistory).catch((cause) => setError(errorMessage(cause)));
  }, [siteId]);
  const sheets = () => [{
    name: "History", columns: ["Date", "Kind", "Title", "Detail", "Since"],
    rows: (history?.rows ?? []).map((row) => [row.at.slice(0, 10), LABEL[row.kind].text, row.title, row.detail, row.since?.slice(0, 10) ?? null]),
  }];
  return (
    <div className="results">
      <Card title="History" subtitle="Every problem the analysis once reported that is now gone, who or what fixed it, and every change made through Eumon." actions={history?.rows.length ? <ExportMenu title="History" sheets={sheets} /> : undefined}>
        {error ? <p className="empty-state">{error}</p>
          : !history ? <p className="empty-state">Loading…</p>
          : history.runs === 0 ? <p className="empty-state">Run an analysis first.</p>
          : history.runs < 2 && !history.rows.length ? <p className="empty-state">History starts with your second analysis: fix something, run it again.</p>
          : (
            <>
              <div className="kpi-grid">
                <Kpi label="Resolved" value={history.numbers.resolved} caption={`${history.open} still open`} />
                <Kpi label="Fixed with Eumon" value={history.numbers.fixedWithEumon} />
                <Kpi label="No longer apply" value={history.numbers.noLongerApplies} />
                <Kpi label="Actions" value={history.numbers.actions} />
              </div>
              {history.rows.map((row, index) => <Row key={index} row={row} onNavigate={onNavigate} />)}
            </>
          )}
      </Card>
    </div>
  );
}

function Row({ row, onNavigate }: { row: HistoryRow; onNavigate: Navigate }) {
  const label = LABEL[row.kind];
  const open = row.category
    ? () => { const place = AREA_PLACE[findingArea(row.category!)]; onNavigate(place.view, place.tab ?? undefined); }
    : row.view ? () => onNavigate(row.view!) : undefined;
  const title = row.href ? <a href={row.href} target="_blank" rel="noreferrer">{row.title}</a>
    : open ? <a href="#" onClick={(event) => { event.preventDefault(); open(); }}>{row.title}</a>
    : row.title;
  return (
    <div className="list-row">
      <Badge tone={label.tone}>{label.text}</Badge>
      <div className="grow">
        <h4>{title}</h4>
        <p>{row.detail}{row.since && <> · since {day(row.since)}</>}{row.reopenedAt && <> · reopened {day(row.reopenedAt)}</>}</p>
      </div>
      <span className="small muted" style={{ flex: "none" }}>{day(row.at)}</span>
    </div>
  );
}
