"use client";

import { countryName, type ContentGradeRow } from "@organic-growth/core";
import { useState } from "react";
import { formatDay, formatNumber } from "../api";
import { Badge, Card } from "../ui";

const tone = (grade: string) => (grade === "A" || grade === "B" ? "green" : grade === "C" ? "amber" : "red");
const FEATURE = { lists: "Lists or tables", questions: "Question headings", faq: "FAQ" } as const;
const MISSING_SHOWN = 5;
/** Links only for http(s): a stored URL is data from the web. */
const safe = (url: string) => /^https?:\/\//i.test(url);
const path = (url: string) => { try { return new URL(url).pathname; } catch { return url; } };
const Link = ({ url, children }: { url: string; children?: React.ReactNode }) =>
  safe(url) ? <a href={url} target="_blank" rel="noreferrer">{children ?? url}</a> : <span>{children ?? url}</span>;

function Detail({ row }: { row: ContentGradeRow }) {
  return (
    <>
      <div className="section-title">Topics the top results cover</div>
      <ul className="small">{row.topics.map((topic) => (
        <li key={topic.label}>
          <strong>{topic.label}</strong>: {topic.covered ? "covered" : "missing"}{topic.coveredBy.length > 0 && <span className="muted"> · covered by {topic.coveredBy.join(", ")}</span>}
          {topic.covered && topic.evidence && <div className="muted">“{topic.evidence}”</div>}
        </li>
      ))}</ul>
      <div className="section-title">Structure</div>
      <ul className="small">{row.structure.map((item) => (
        <li key={item.feature}>{FEATURE[item.feature] ?? item.feature}: top results {item.competitors ? "use it" : "don't"}, your page {item.page ? "does" : "doesn't"}</li>
      ))}</ul>
      <div className="section-title">Pages that rank</div>
      <ul className="small">{row.competitors.map((rival) => (
        <li key={rival.url}><Link url={rival.url}>{rival.domain}</Link> <span className="muted">· {formatNumber(rival.words)} words</span></li>
      ))}</ul>
    </>
  );
}

/**
 * How each graded page compares with the pages that outrank it: the topics
 * the top results share that the page lacks, length and structure.
 */
export function ContentGradesCard({ grades, operator, hasMarkets, hasCredentials, notes }: {
  grades: ContentGradeRow[]; operator: boolean; hasMarkets: boolean; hasCredentials: boolean; notes?: string[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const empty = grades.length > 0 ? null
    : !hasCredentials && !hasMarkets ? (operator ? "Add DataForSEO credentials or track keywords so Eumon knows who ranks." : "Not measured yet.")
    : "Grades appear after the next analysis, for your tracked keywords and the searches where you rank 4 to 15.";
  return (
    <Card title="Content grades" subtitle="Each page against the pages that outrank it: the topics the top results cover, length and structure.">
      {empty && <p className="empty-state">{empty}</p>}
      {empty && operator && notes && notes.length > 0 && <ul className="small muted">{notes.map((note) => <li key={note}>{note}</li>)}</ul>}
      {!empty && (
        <div className="table-wrap">
          <table className="table top-queries">
            <thead><tr><th>Search</th><th>Page</th><th>Grade</th><th className="num">Topics</th><th className="num">Words</th><th>Missing</th><th>Checked</th></tr></thead>
            <tbody>{grades.map((row) => {
              const id = `${row.query}|${row.market}`;
              const shown = open === id;
              return [
                <tr key={id}>
                  <td><button type="button" className="text-link" aria-expanded={shown} onClick={() => setOpen(shown ? null : id)}>{row.query}</button><span className="was">{countryName(row.market)}</span></td>
                  <td><Link url={row.page}>{path(row.page)}</Link></td>
                  <td><Badge tone={tone(row.grade)}>{row.grade}</Badge></td>
                  <td className="num">{row.covered} of {row.topics.length}</td>
                  <td className="num">{formatNumber(row.ownWords)} vs {formatNumber(row.medianWords)}</td>
                  <td>{row.missing.slice(0, MISSING_SHOWN).map((label) => <Badge key={label} tone="gray">{label}</Badge>)}{row.missing.length > MISSING_SHOWN && <span className="small muted"> +{row.missing.length - MISSING_SHOWN} more</span>}</td>
                  <td>{formatDay(row.checkedAt.slice(0, 10))}</td>
                </tr>,
                shown && <tr key={`${id}|detail`}><td colSpan={7}><Detail row={row} /></td></tr>,
              ];
            })}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
