"use client";

import type { KeywordsView } from "@organic-growth/core";
import { formatDay, formatNumber } from "../api";
import { BarList } from "../charts";
import { Badge, Card } from "../ui";

const num = (value: number | null) => (value === null ? "—" : formatNumber(value));
const difficultyTone = (value: number) => (value <= 30 ? "green" : value <= 60 ? "amber" : "red");

function Difficulty({ value }: { value: number | null }) {
  return value === null ? <>—</> : <Badge tone={difficultyTone(value)}>{value}</Badge>;
}

/**
 * What the site's searches are worth and which ones competitors win: the
 * site's queries priced by DataForSEO, keyword gaps, and share of visibility.
 */
export function KeywordsCard({ keywords, host, operator, hasCredentials, hasMarkets, searchTop10 }: {
  keywords: KeywordsView; host: string; operator: boolean; hasCredentials: boolean; hasMarkets: boolean; searchTop10: number | null;
}) {
  const empty = !hasCredentials && !keywords.synced
    ? (operator ? "Add DataForSEO credentials (DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD) to price keywords and see competitor gaps." : "Not measured yet.")
    : !hasMarkets ? (operator ? "Set target markets in Setup: keyword data is per country." : "Not measured yet.")
    : !keywords.synced ? "Keywords appear after the next sync."
    : !keywords.top.length && !keywords.gaps.length && keywords.visibility.every((row) => !row.traffic) ? "DataForSEO has no keywords for these domains in your target markets."
    : null;
  const you = keywords.visibility[0];
  return (
    <Card title="Keywords" subtitle={`Searches per month and difficulty from DataForSEO, updated monthly${keywords.asOf ? ` (last on ${formatDay(keywords.asOf)})` : ""}. Positions from Search Console.`}>
      {empty ? <p className="empty-state">{empty}</p> : (
        <>
          <div className="section-title">Your top keywords</div>
          {keywords.top.length ? (
            <div className="table-wrap">
              <table className="table top-queries">
                <thead><tr><th>Keyword</th><th className="num">Searches / month</th><th className="num">Difficulty</th><th className="num">Position</th><th className="num">Clicks</th></tr></thead>
                <tbody>{keywords.top.map((row) => (
                  <tr key={row.keyword}>
                    <td>{row.keyword}{row.intent && <span className="was">{row.intent}</span>}</td>
                    <td className="num">{num(row.volume)}</td>
                    <td className="num"><Difficulty value={row.difficulty} /></td>
                    <td className="num">{row.position.toFixed(1)}</td>
                    <td className="num">{formatNumber(row.clicks)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <p className="empty-state">{operator ? "Connect Search Console so your queries can be priced." : "No priced keywords yet."}</p>}

          <div className="section-title">Keyword gaps</div>
          {keywords.gaps.length ? (
            <div className="table-wrap">
              <table className="table top-queries">
                <thead><tr><th>Keyword</th><th className="num">Searches / month</th><th className="num">Difficulty</th><th>Who ranks</th></tr></thead>
                <tbody>{keywords.gaps.map((gap) => (
                  <tr key={gap.keyword}>
                    <td>{gap.keyword}{gap.intent && <span className="was">{gap.intent}</span>}</td>
                    <td className="num">{num(gap.volume)}</td>
                    <td className="num"><Difficulty value={gap.difficulty} /></td>
                    <td><a href={`https://${gap.domain}${gap.url}`} target="_blank" rel="noreferrer">{gap.domain}</a><span className="was">position {gap.position}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <p className="empty-state">No gaps found: you appear for every keyword your competitors rank for.</p>}

          <div className="section-title">Share of visibility</div>
          <BarList format={(value) => `${formatNumber(value)} visits/mo`} rows={keywords.visibility.map((row, index) => ({ label: index === 0 ? host : row.domain, value: row.traffic }))} />
          <p className="small muted">
            Estimated monthly visits from Google, in DataForSEO's index, which knows fewer of your keywords than Search Console does
            {you?.top10 !== null && you?.top10 !== undefined ? `: it sees you in the top 10 for ${formatNumber(you.top10)} searches${searchTop10 !== null ? `, Search Console counts ${formatNumber(searchTop10)}` : ""}` : ""}.
          </p>
        </>
      )}
    </Card>
  );
}
