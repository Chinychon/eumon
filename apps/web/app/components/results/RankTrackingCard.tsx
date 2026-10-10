"use client";

import { countryName, SERP_FEATURES, TRACKED_KEYWORDS_MAX, type RankChange, type RanksView } from "@organic-growth/core";
import { useState } from "react";
import { api, errorMessage, formatDay } from "../api";
import { LineChart } from "../charts";
import { Badge, Button, Card, Kpi } from "../ui";

const FEATURE_LABEL = Object.fromEntries(SERP_FEATURES.map(({ feature, label }) => [feature, label]));
const positionTone = (position: number) => (position <= 3 ? "green" : "amber");
/** A page costs about $0.004 at DataForSEO; thirty days a month. */
const monthlyCost = (keywords: number, markets: number) => keywords * markets * 0.004 * 30;

function Change({ change }: { change: RankChange }) {
  if (change.kind === "none") return <span className="muted">—</span>;
  if (change.kind === "same") return <span className="muted">0</span>;
  if (change.kind === "entered") return <span className="rank-up">entered</span>;
  if (change.kind === "left") return <span className="rank-down">left</span>;
  return <span className={change.kind === "up" ? "rank-up" : "rank-down"}>{change.kind === "up" ? "▲" : "▼"} {change.places}</span>;
}

/** Up to eight keywords' positions over time; drawn as places from 11 so the top of the chart is position 1. */
function Series({ ranks }: { ranks: RanksView }) {
  const shown = ranks.rows.filter((row) => row.series.length > 1).slice(0, 8);
  if (!shown.length) return null;
  const days = [...new Set(shown.flatMap((row) => row.series.map((point) => point.day)))].sort();
  return (
    <>
      <div className="section-title">Positions over time</div>
      <LineChart series={shown.map((row) => `${row.keyword} · ${countryName(row.market)}`)} partialFrom="9999-12-31"
        points={days.map((day) => ({ x: day, values: shown.map((row) => { const point = row.series.find((entry) => entry.day === day); return point ? 11 - (point.position ?? 11) : null; }) }))} />
      <p className="small muted">Higher is better: 10 means position 1, 0 means not in the top 10.</p>
    </>
  );
}

/**
 * The searches the user names, checked daily per target market: today's
 * position, the change over 7 and 30 days, the best position, the landing
 * page and the result types on the page. Users edit the list here.
 */
export function RankTrackingCard({ ranks, siteId, operator, hasCredentials, hasMarkets, markets, onSaved }: {
  ranks: RanksView; siteId: string; operator: boolean; hasCredentials: boolean; hasMarkets: boolean; markets: string[]; onSaved?: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [savedKeywords, setSavedKeywords] = useState(() => [...new Set(ranks.rows.map((row) => row.keyword))]);
  const current = savedKeywords;
  const draft = text ?? current.join("\n");
  const changed = draft.trim() !== current.join("\n").trim();

  async function save() {
    setBusy(true); setError(""); setSaved(false);
    try {
      const response = await api<{ keywords: string[] }>(`/api/sites/${siteId}/keywords`, { method: "PUT", json: { keywords: draft.split("\n").map((line) => line.trim()).filter(Boolean) } });
      setSavedKeywords(response.keywords); setText(null); setSaved(true); onSaved?.();
    } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); }
  }

  const empty = !hasCredentials ? (operator ? "Add DataForSEO credentials (DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD) to track positions." : "Not measured yet.")
    : !hasMarkets ? (operator ? "Set target markets in Setup: positions are checked per country." : "Not measured yet.")
    : !ranks.tracked ? (operator ? "Add the searches you want to watch." : "No keywords are tracked yet.")
    : !ranks.checked ? "First check at the next sync." : null;
  const keywordCount = draft.split("\n").filter((line) => line.trim()).length;
  // A pair not checked yet (just added, an uncovered market, a failed check) has no position to report; the client link leaves it out.
  const rows = operator ? ranks.rows : ranks.rows.filter((row) => row.checked);
  return (
    <Card title="Rank tracking" subtitle={`Google's position for each keyword, checked daily in your target markets by DataForSEO${ranks.asOf ? ` (last on ${formatDay(ranks.asOf)})` : ""}.`}>
      {empty && <p className="empty-state">{empty}</p>}
      {!empty && ranks.checked > 0 && (
        <>
          <div className="metrics-grid results-inline">
            <Kpi label="Tracked searches" value={ranks.checked} caption={`${ranks.tracked} keyword${ranks.tracked === 1 ? "" : "s"} × ${markets.length} market${markets.length === 1 ? "" : "s"}`} />
            <Kpi label="In the top 3" value={ranks.top3} />
            <Kpi label="In the top 10" value={ranks.top10} />
            <Kpi label="Not in the top 10" value={ranks.unranked} />
            <Kpi label="Average position" value={ranks.averagePosition ?? "—"} caption="Of the keywords in the top 10" />
          </div>
          <div className="table-wrap">
            <table className="table top-queries">
              <thead><tr><th>Keyword</th><th>Market</th><th className="num">Position</th><th className="num">7 days</th><th className="num">30 days</th><th className="num">Best</th><th>Page</th><th>On the page</th></tr></thead>
              <tbody>{rows.map((row) => (
                <tr key={`${row.keyword}|${row.market}`}>
                  <td>{row.keyword}</td>
                  <td>{countryName(row.market)}</td>
                  {row.checked ? (
                    <>
                      <td className="num">{row.position === null ? <Badge tone="gray">not in top 10</Badge> : <Badge tone={positionTone(row.position)}>{row.position}</Badge>}</td>
                      <td className="num"><Change change={row.change7} /></td>
                      <td className="num"><Change change={row.change30} /></td>
                      <td className="num">{row.best ?? "—"}</td>
                      <td>{row.url ? <a href={row.url} target="_blank" rel="noreferrer">{new URL(row.url).pathname}</a> : "—"}</td>
                      <td>{row.features.map((feature) => <Badge key={feature} tone="gray">{FEATURE_LABEL[feature] ?? feature}</Badge>)}</td>
                    </>
                  ) : (
                    <>
                      <td className="num muted">not checked yet</td>
                      <td className="num muted">—</td>
                      <td className="num muted">—</td>
                      <td className="num muted">—</td>
                      <td className="muted">—</td>
                      <td className="muted">—</td>
                    </>
                  )}
                </tr>
              ))}</tbody>
            </table>
          </div>
          <Series ranks={ranks} />
        </>
      )}
      {operator && hasCredentials && hasMarkets && (
        <>
          <div className="section-title">Keywords to track</div>
          <textarea className="textarea" aria-label="Keywords to track, one per line" style={{ minHeight: 96 }} placeholder={"dental implants\nbraces price kuala lumpur"} value={draft} onChange={(event) => setText(event.target.value)} />
          <div className="row" style={{ gap: 12, alignItems: "center", marginTop: 8 }}>
            <Button small variant="secondary" disabled={!changed} busy={busy} onClick={save}>Save keywords</Button>
            <span className="small muted">
              Up to {TRACKED_KEYWORDS_MAX}, one per line. {keywordCount} keyword{keywordCount === 1 ? "" : "s"} × {markets.length} market{markets.length === 1 ? "" : "s"} ≈ ${monthlyCost(keywordCount, markets.length).toFixed(2)} a month at DataForSEO. The first check runs at the next sync.
            </span>
            {saved && !changed && <span className="small muted">Saved</span>}
          </div>
          {error && <p className="error">{error}</p>}
        </>
      )}
    </Card>
  );
}
