"use client";

import { AI_ANSWER_ENGINES, AI_PROMPTS_MAX, bareDomain, countryName, type AiAnswerCheck, type AiAnswerEngine, type AiAnswersView } from "@organic-growth/core";
import { Fragment, useEffect, useState } from "react";
import { api, errorMessage, formatDay } from "../api";
import { BarList, LineChart, Radar } from "../charts";
import { Badge, Button, Card, Kpi } from "../ui";

/** Checks a month: four engines, asked weekly (about 4.3 times a month), but never more than the 40 a day the sync asks. */
const monthlyChecks = (questions: number, markets: number) => Math.min(questions * markets * 4 * 4.3, 40 * 30);
/** At 40 a day, 280 checks fit in a week; more cells than that are each asked less often. */
const cadence = (questions: number, markets: number) => {
  const cells = questions * markets * 4;
  return cells > 280 ? `about every ${Math.ceil(cells / 280)} weeks` : "weekly";
};
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : null);
const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
const names = (text: string) => text.split(",").map((name) => name.trim()).filter(Boolean);

function cellMark(check: AiAnswerCheck | undefined): { mark: string; title: string } {
  if (!check) return { mark: "—", title: "Not checked yet" };
  if (check.cited) return { mark: "●", title: "Cites you" };
  if (check.mentioned) return { mark: "◐", title: "Mentions you" };
  const cited = check.rivals.filter((rival) => rival.cited).map((rival) => rival.domain);
  return { mark: "○", title: cited.length ? `Cites ${cited.join(", ")} instead` : "Doesn't name or cite you" };
}

function Detail({ check }: { check: AiAnswerCheck }) {
  const sources = check.sources.slice(0, 5);
  return (
    <div className="ai-answer-detail">
      <p className="small muted">Asked on {formatDay(check.day)}{check.citedRank ? `; you are source ${check.citedRank}` : ""}.</p>
      {check.excerpt && <blockquote className="small">{check.excerpt}</blockquote>}
      {check.rivals.length > 0 && (
        <p className="small">Competitors in this answer: {check.rivals.map((rival) => `${rival.domain} (${[rival.mentioned && "named", rival.cited && "cited"].filter(Boolean).join(", ")})`).join("; ")}</p>
      )}
      {sources.length > 0 && (
        <p className="small">Sources: {sources.map((source, index) => <Fragment key={`${index}|${source.domain}`}>{index > 0 && " · "}{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.domain}</a> : source.domain}</Fragment>)}</p>
      )}
    </div>
  );
}

/**
 * What ChatGPT, Gemini, Google AI Mode and Perplexity answer to the questions
 * the user tracks, per target market: whether each answer names or cites the
 * site, who else it cites, and how that moves week to week. Users edit the
 * questions and brand names here.
 */
export function AiAnswersCard({ view, siteId, operator, hasCredentials, hasMarkets, onSaved }: {
  view: AiAnswersView; siteId: string; operator: boolean; hasCredentials: boolean; hasMarkets: boolean; onSaved?: () => void;
}) {
  const editing = operator && hasCredentials && hasMarkets;
  const [savedPrompts, setSavedPrompts] = useState(() => [...new Set(view.rows.map((row) => row.prompt))]);
  const [savedBrands, setSavedBrands] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [text, setText] = useState<string | null>(null);
  const [brandText, setBrandText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) return;
    api<{ prompts: string[]; brandNames: string[]; suggestions: string[] }>(`/api/sites/${siteId}/ai-prompts`)
      .then((response) => { setSavedPrompts(response.prompts); setSavedBrands(response.brandNames); setSuggestions(response.suggestions); })
      .catch((caught) => setError(errorMessage(caught)));
  }, [editing, siteId]);

  const draft = text ?? savedPrompts.join("\n");
  const brandDraft = brandText ?? savedBrands.join(", ");
  const changed = lines(draft).join("\n") !== savedPrompts.join("\n") || names(brandDraft).join(",") !== savedBrands.join(",");
  const listed = new Set(lines(draft).map((line) => line.toLowerCase()));
  const offered = suggestions.filter((suggestion) => !listed.has(suggestion.toLowerCase()));

  async function save() {
    setBusy(true); setError(""); setSaved(false);
    try {
      const response = await api<{ prompts: string[]; brandNames: string[] }>(`/api/sites/${siteId}/ai-prompts`, { method: "PUT", json: { prompts: lines(draft), brandNames: names(brandDraft) } });
      setSavedPrompts(response.prompts); setSavedBrands(response.brandNames); setText(null); setBrandText(null); setSaved(true); onSaved?.();
    } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); }
  }

  const empty = !hasCredentials ? (operator ? "Add DataForSEO credentials (DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD) to ask AI assistants about your market." : "Not measured yet.")
    : !hasMarkets ? (operator ? "Set target markets in Setup: answers are checked per country." : "Not measured yet.")
    : !view.prompts ? (operator ? "Add the questions people ask AI assistants about your services." : "No questions are tracked yet.")
    : !view.checked ? "First answers at the next sync." : null;

  // Each engine's share of answers naming or citing the site, and the top three competitors, from the latest answers.
  const rateOf = (engine: AiAnswerEngine, hit: (check: AiAnswerCheck) => boolean) => {
    const checks = view.rows.flatMap((row) => row.cells[engine] ?? []);
    return percent(checks.filter(hit).length, checks.length);
  };
  const rivals = view.shareOfVoice.filter((entry) => !entry.site).slice(0, 3);
  const radar = [
    { name: "you", values: AI_ANSWER_ENGINES.map(({ engine }) => rateOf(engine, (check) => check.mentioned || check.cited)) },
    ...rivals.map((entry) => ({
      name: entry.domain,
      values: AI_ANSWER_ENGINES.map(({ engine }) => rateOf(engine, (check) => check.rivals.some((rival) => rival.domain === bareDomain(entry.domain) && (rival.mentioned || rival.cited)))),
    })),
  ];
  // The client link leaves out questions with no answers yet.
  const rows = operator ? view.rows : view.rows.filter((row) => Object.keys(row.cells).length > 0);
  const firstWeek = view.weeks.findIndex((week) => week.checked > 0);
  const weeks = firstWeek < 0 ? [] : view.weeks.slice(firstWeek);
  const questionCount = lines(draft).length;
  const markets = view.markets.length;

  return (
    <Card title="AI answers" subtitle={`Answers from ChatGPT, Gemini, Google AI Mode and Perplexity to the questions you track, asked weekly in your target markets through DataForSEO${view.asOf ? ` (last on ${formatDay(view.asOf)})` : ""}.`}>
      {empty && <p className="empty-state">{empty}</p>}
      {!empty && (
        <>
          <div className="metrics-grid results-inline">
            <Kpi label="Questions tracked" value={view.prompts} />
            <Kpi label="Answers that mention you" value={`${view.totals.mentioned} of ${view.checked}`} />
            <Kpi label="Answers that cite you" value={`${view.totals.cited} of ${view.checked}`} />
            <Kpi label="Google AI Overviews citing you" value={`${view.overview.citesYou} of ${view.overview.searches}`} caption="from the search results checked" />
          </div>
          <Radar caption="Share of answers naming or citing each site, by engine" axes={AI_ANSWER_ENGINES.map(({ label }) => label)} series={radar} unit="the share of answers, in per cent" />
          <div className="section-title">Share of voice</div>
          <BarList rows={view.shareOfVoice.map((entry) => ({ label: `${entry.site ? `${entry.domain} (you)` : entry.domain}${entry.share === null ? "" : ` · ${Math.round(entry.share * 100)}%`}`, value: entry.answers }))} />
          <p className="small muted">Answers that name or cite each site, of the latest answer to every question, market and engine.</p>
          <div className="section-title">Questions</div>
          <div className="table-wrap">
            <table className="table top-queries ai-answers">
              <thead><tr><th>Question</th><th>Market</th>{AI_ANSWER_ENGINES.map(({ engine, label }) => <th key={engine} className="num">{label}</th>)}</tr></thead>
              <tbody>{rows.map((row) => {
                const key = `${row.prompt}|${row.market}`;
                const openEngine = AI_ANSWER_ENGINES.find(({ engine }) => open === `${key}|${engine}`);
                const openCheck = openEngine && row.cells[openEngine.engine];
                return (
                  <Fragment key={key}>
                    <tr>
                      <td>{row.prompt}</td>
                      <td>{countryName(row.market)}</td>
                      {AI_ANSWER_ENGINES.map(({ engine, label }) => {
                        const check = row.cells[engine];
                        const { mark, title } = cellMark(check);
                        const cellKey = `${key}|${engine}`;
                        return (
                          <td key={engine} className="num">
                            {check ? (
                              <button type="button" className={`ai-cell${check.cited ? " cited" : check.mentioned ? " mentioned" : ""}`} title={title} aria-label={`${label}, ${row.prompt}: ${title}`}
                                aria-expanded={open === cellKey} onClick={() => setOpen(open === cellKey ? null : cellKey)}>{mark}</button>
                            ) : <span className="muted" title={title}>{mark}</span>}
                          </td>
                        );
                      })}
                    </tr>
                    {openCheck && <tr><td colSpan={2 + AI_ANSWER_ENGINES.length}><Detail check={openCheck} /></td></tr>}
                  </Fragment>
                );
              })}</tbody>
            </table>
          </div>
          <p className="small muted">● cites you · ◐ mentions you · ○ neither · — not checked yet. Select an answer to read it.</p>
          {view.topDomains.length > 0 && (
            <>
              <div className="section-title">Sites AI cites for these questions</div>
              <div className="table-wrap">
                <table className="table top-queries">
                  <thead><tr><th>Site</th><th className="num">Answers citing it</th></tr></thead>
                  <tbody>{view.topDomains.map((entry) => (
                    <tr key={entry.domain}>
                      <td>{entry.domain} {entry.kind === "site" && <Badge tone="green">you</Badge>}{entry.kind === "competitor" && <Badge tone="amber">competitor</Badge>}</td>
                      <td className="num">{entry.answers}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </>
          )}
          {weeks.length >= 2 && (
            <>
              <div className="section-title">Weekly</div>
              <LineChart series={["% mentioning you", "% citing you"]} partialFrom={weeks.at(-1)!.week}
                points={weeks.map((week) => ({ x: week.week, values: [percent(week.mentioned, week.checked), percent(week.cited, week.checked)] }))} />
            </>
          )}
        </>
      )}
      {editing && (
        <>
          <div className="section-title">Questions to track</div>
          <textarea className="textarea" aria-label="Questions to track, one per line" style={{ minHeight: 96 }} placeholder={"best dentist near me\nhow much do braces cost"} value={draft} onChange={(event) => setText(event.target.value)} />
          <input className="input" aria-label="Names your brand goes by" placeholder="Brand names, comma-separated" value={brandDraft} onChange={(event) => setBrandText(event.target.value)} style={{ marginTop: 8 }} />
          {offered.length > 0 && (
            <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              <span className="small muted">From your question searches:</span>
              {offered.map((suggestion) => (
                <Button key={suggestion} small variant="ghost" onClick={() => setText(`${draft.trimEnd()}${draft.trim() ? "\n" : ""}${suggestion}`)}>+ {suggestion}</Button>
              ))}
            </div>
          )}
          <div className="row" style={{ gap: 12, alignItems: "center", marginTop: 8 }}>
            <Button small variant="secondary" disabled={!changed} busy={busy} onClick={save}>Save questions</Button>
            <span className="small muted">
              Up to {AI_PROMPTS_MAX}, one per line. {plural(questionCount, "question")} × {plural(markets, "market")} × 4 engines ≈ ${(monthlyChecks(questionCount, markets) * 0.0048).toFixed(2)} a month at DataForSEO. Answers are checked {cadence(questionCount, markets)}; the first ones arrive at the next sync.
            </span>
            {saved && !changed && <span className="small muted">Saved</span>}
          </div>
          {error && <p className="error">{error}</p>}
        </>
      )}
    </Card>
  );
}
