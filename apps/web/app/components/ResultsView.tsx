"use client";

import { useCallback, useEffect, useState } from "react";
import { countryName, type Compare, type ResultsView as Results, type SpeedMetric, type SpeedRating, type TopQuery } from "@organic-growth/core";
import { api, errorMessage, formatNumber } from "./api";
import { BarList, Funnel, LineChart } from "./charts";
import { Badge, Button, Card, Kpi, ViewHeader } from "./ui";

type Payload = { site: { name: string; baseUrl: string; searchConnected: boolean; analytics: "connected" | "reconnect" | "none"; signals: { speed: boolean; authority: boolean } }; results: Results };

const SPEED_LABEL: Record<SpeedMetric, string> = { lcp: "Loading", inp: "Responding to taps", cls: "Staying still while loading" };
const SPEED_HINT: Record<SpeedMetric, string> = { lcp: "Main content on screen", inp: "Reaction to a tap or click", cls: "Layout shift while loading" };
const RATING_LABEL: Record<SpeedRating, string> = { good: "Good", "needs-work": "Needs work", poor: "Poor" };
const RATING_TONE: Record<SpeedRating, string> = { good: "green", "needs-work": "amber", poor: "red" };
const formatSpeed = (metric: SpeedMetric, value: number) => (metric === "cls" ? value.toFixed(2) : value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`);

const day = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" });
const pct = (value: number | null, digits = 1) => (value === null ? "—" : `${(value * 100).toFixed(digits)}%`);

/** "was 120 before Eumon", or the previous 28 days without a go-live, or "collecting". */
function versus(compare: Compare, format: (value: number) => string = formatNumber) {
  if (compare.current === null) return "Collecting data";
  if (compare.before !== null) return `was ${format(compare.before)} before Eumon`;
  if (compare.previous !== null) return `${format(compare.previous)} in the 28 days before`;
  return "First 28 days of data";
}

/**
 * Is it working? Google clicks over 16 months with the go-live marked, the
 * key numbers against before Eumon, then one section per question.
 */
export function ResultsView({ endpoint, operator, onNavigate }: { endpoint: string; operator: boolean; onNavigate?: (view: "connections" | "overview") => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const load = useCallback(() => api<Payload>(endpoint).then(setData).catch((cause) => setError(errorMessage(cause))), [endpoint]);
  useEffect(() => { setData(null); setError(""); void load(); }, [load]);

  async function syncNow() {
    setSyncing(true); setError("");
    try {
      await api(endpoint.replace(/\/results$/, "/results/sync"), { method: "POST" });
      await load();
    } catch (cause) { setError(errorMessage(cause)); } finally { setSyncing(false); }
  }

  const [shared, setShared] = useState(false);
  async function shareLink() {
    try {
      const { url } = await api<{ url: string }>(endpoint.replace(/\/results$/, "/share"), { method: "POST" });
      await navigator.clipboard.writeText(url);
      setShared(true);
    } catch (cause) { setError(errorMessage(cause)); }
  }

  if (error) return <div className="callout error" role="alert">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;
  const { site, results } = data;
  const host = new URL(site.baseUrl).hostname;
  const goLive = results.goLive ? { x: results.goLive, label: `Eumon live ${day(results.goLive)}` } : undefined;
  const partialFrom = results.headline.find((week) => week.partial)?.week;
  const pages = results.numbers.pages;

  return (
    <div>
      <ViewHeader
        title={operator ? "Performance" : site.name}
        description={<>Google search, enquiries, speed, and authority for {host}. {results.searchThrough ? `Google data through ${day(results.searchThrough)}.` : "Google data appears after the first sync."}</>}
        actions={operator && (
          <div className="row">
            <Button variant="ghost" onClick={shareLink}>{shared ? "Link copied" : "Copy client link"}</Button>
            <Button variant="secondary" busy={syncing} onClick={syncNow}>Sync now</Button>
          </div>
        )}
      />
      <div className="results">
        <Card title="Google clicks per week" subtitle={results.goLive ? "The whole site, and Eumon's pages since they went live." : "The whole site. Eumon's pages appear once the first one is published."}>
          {site.searchConnected && results.headline.some((week) => week.site !== null)
            ? <LineChart series={results.goLive ? ["whole site", "eumon pages"] : ["whole site"]} marker={goLive} partialFrom={partialFrom}
                points={results.headline.map((week) => ({ x: week.week, values: results.goLive ? [week.site, week.eumon] : [week.site] }))} />
            : <ConnectPrompt operator={operator} what="Search Console" onNavigate={onNavigate} />}
        </Card>
        <div className="metrics-grid">
          <Kpi label="Google clicks · 28 days" value={results.numbers.clicks.current === null ? "—" : formatNumber(results.numbers.clicks.current)} caption={versus(results.numbers.clicks)} />
          <Kpi label="Enquiries · 28 days" value={results.numbers.leads.current === null ? "—" : formatNumber(results.numbers.leads.current)}
            caption={results.numbers.leads.before === null && results.numbers.leadsSince ? `tracked since ${day(results.numbers.leadsSince)}` : versus(results.numbers.leads)} />
          <Kpi label="Organic sessions · 28 days" value={results.numbers.organicSessions?.current == null ? "—" : formatNumber(results.numbers.organicSessions.current)} caption={results.numbers.organicSessions ? versus(results.numbers.organicSessions) : analyticsState(site.analytics, operator)} />
          <Kpi label="Pages live" value={formatNumber(pages.live)} caption={pages.live ? `${formatNumber(pages.indexed)} indexed · ${formatNumber(pages.notIndexed)} not · ${formatNumber(pages.unchecked)} not checked yet` : "No Eumon pages published yet"} />
        </div>

        <Card title="Google search" subtitle={results.search?.scoped ? `Scoped to your target markets: ${results.markets.map(countryName).join(", ")}.` : results.markets.length ? "Every country, until your target markets' history is synced." : operator ? "Every country. Set target markets in Setup to focus this section." : "Every country."}>
          {results.search ? (
            <>
              <div className="ruled-grid c11 results-pair">
                <div><div className="section-title">Clicks per week</div><LineChart series={["clicks"]} partialFrom={partialFrom} points={results.search.weeks.map((week) => ({ x: week.week, values: [week.clicks] }))} /></div>
                <div><div className="section-title">Impressions per week</div><LineChart series={["impressions"]} partialFrom={partialFrom} points={results.search.weeks.map((week) => ({ x: week.week, values: [week.impressions] }))} /></div>
              </div>
              <div className="metrics-grid results-inline">
                <Kpi label="Click-through rate" value={pct(results.search.ctr.current)} caption={versus(results.search.ctr, (value) => pct(value))} />
                <Kpi label="Average position" value={results.search.position.current === null ? "—" : results.search.position.current.toFixed(1)} caption={versus(results.search.position, (value) => value.toFixed(1))} />
                {results.search.clicksAllCountries && <Kpi label="Clicks · every country" value={results.search.clicksAllCountries.current === null ? "—" : formatNumber(results.search.clicksAllCountries.current)} caption="Beside the target-market figure above" />}
                {pages.live > 0 && <Kpi label="Googlebot visits to Eumon pages · 28 days" value={results.numbers.googlebot.current === null ? "—" : formatNumber(results.numbers.googlebot.current)} caption={versus(results.numbers.googlebot)} />}
              </div>
              <div className="section-title">Queries by position, this week</div>
              <ol className="rank-buckets">
                {results.search.buckets.map((bucket) => (
                  <li key={bucket.top}>
                    <span className="rank-label">Top {bucket.top}</span>
                    <strong>{bucket.queries === null ? "—" : formatNumber(bucket.queries)}</strong>
                    <span className="rank-change">{bucket.added === null ? "" : `+${formatNumber(bucket.added)} new · ${bucket.lost ? `−${formatNumber(bucket.lost)}` : "0"} lost`}</span>
                  </li>
                ))}
              </ol>
              <div className="section-title">{results.search.topQueries ? `Top queries, 28 days to ${day(results.search.topQueries.periodEnd)}` : "Top queries"}</div>
              {results.search.topQueries?.rows.length ? <TopQueries rows={results.search.topQueries.rows} /> : <p className="empty-state">{results.search.topQueries ? "No query earned a click in these 28 days." : "Top queries appear after the next sync."}</p>}
              <p className="small muted">Search Console leaves out anonymized queries, so query counts are lower than total clicks suggest. Data arrives two to three days late. "Was" is the 28 days before.</p>
            </>
          ) : <ConnectPrompt operator={operator} what="Search Console" onNavigate={onNavigate} />}
          {results.organic && (
            <>
              <div className="section-title">Organic sessions per week, from Google Analytics</div>
              <LineChart series={["organic sessions", "GA4 key events"]} partialFrom={partialFrom} marker={goLive} points={results.organic.map((week) => ({ x: week.week, values: [week.sessions, week.keyEvents] }))} />
            </>
          )}
        </Card>

        <Card title="Enquiries" subtitle="Eumon's pages from a Google search to an enquiry, over the last 28 days of Search Console data.">
          {results.leads.funnel ? <Funnel steps={results.leads.funnel} /> : <p className="empty-state">The funnel appears once Eumon's pages have Google impressions.</p>}
          <div className="section-title">Enquiries per week</div>
          {results.leads.weeks.some((week) => week.other !== null || week.eumon !== null)
            ? <LineChart series={["from eumon pages", "everything else"]} marker={goLive} partialFrom={results.leads.weeks.find((week) => week.partial)?.week} points={results.leads.weeks.map((week) => ({ x: week.week, values: [week.eumon, week.other] }))} />
            : <p className="empty-state">{operator ? "No enquiries tracked yet. Install tracking in Setup to count WhatsApp taps, calls, and forms." : "No enquiries tracked yet."}</p>}
        </Card>

        <Card title="Speed and authority" subtitle="Speed for real Chrome visitors over 28 days (Google's 75th percentile), Lighthouse lab scores, and an authority estimate.">
          {!site.signals.speed && !results.speed.measured
            ? <p className="empty-state">{operator ? "Add a Google API key (GOOGLE_API_KEY) with the Chrome UX Report and PageSpeed Insights APIs to measure speed." : "Not measured yet."}</p>
            : (
              <div className="ruled-grid c3 speed-tiles">
                {results.speed.metrics.map((entry) => (
                  <div key={entry.metric} className="speed-tile">
                    <div className="section-title">{SPEED_LABEL[entry.metric]}</div>
                    <p className="small muted speed-hint">{SPEED_HINT[entry.metric]}</p>
                    {(["phone", "desktop"] as const).map((form) => (
                      <div key={form} className="speed-row">
                        <span className="speed-form">{form === "phone" ? "Phones" : "Desktops"}</span>
                        {entry[form].p75 === null
                          ? <span className="small muted">{results.speed.measured ? "Too few Chrome visits for Google to report" : "Measured after the next sync"}</span>
                          : <><strong>{formatSpeed(entry.metric, entry[form].p75!)}</strong><Badge tone={RATING_TONE[entry[form].rating!]}>{RATING_LABEL[entry[form].rating!]}</Badge></>}
                      </div>
                    ))}
                    {entry.history.length > 1 && (
                      <LineChart series={["phones", "desktops"]} points={entry.history.map((week) => ({ x: week.day, values: [week.phone, week.desktop] }))} />
                    )}
                  </div>
                ))}
              </div>
            )}
          {(results.lab.phone.home !== null || results.lab.desktop.home !== null) && (
            <div className="metrics-grid results-inline lab-scores">
              {(["phone", "desktop"] as const).map((form) => (
                <Kpi key={form} label={`Lighthouse score · ${form}`}
                  value={results.lab[form].eumon ?? results.lab[form].home ?? "—"}
                  caption={results.lab[form].eumon !== null ? `Eumon page · homepage ${results.lab[form].home ?? "—"}` : "Homepage"} />
              ))}
            </div>
          )}
          <div className="section-title">Authority</div>
          {results.authority.site === null && !results.authority.competitors.some((entry) => entry.score !== null)
            ? <p className="empty-state">{operator && !site.signals.authority ? "Add an Open PageRank key (OPEN_PAGERANK_KEY) to compare authority with your competitors." : "Not measured yet."}</p>
            : (
              <>
                <BarList format={(value) => value.toFixed(2)} rows={[{ label: host, value: results.authority.site ?? 0 }, ...results.authority.competitors.map((entry) => ({ label: entry.domain, value: entry.score ?? 0 }))]} />
                {results.authority.history.length > 1 && (
                  <>
                    {/* A snapshot, not a daily total: today's value is final, so nothing draws dashed. */}
                    <div className="section-title">{host} over time</div>
                    <LineChart series={["authority"]} partialFrom="9999-12-31" points={results.authority.history.map((point) => ({ x: point.day, values: [point.value] }))} />
                  </>
                )}
              </>
            )}
          <p className="small muted">Open PageRank: a free 0–10 estimate from public link data, updated about monthly. Not Google's own measure.</p>
        </Card>

        {operator && (
          <Card title="Site health" subtitle="Share of crawled sitemap pages with no error, no empty HTML, and no noindex, from the latest analysis.">
            <div className="big-number">{results.health.value === null ? "—" : `${results.health.value}%`}</div>
            <p className="small muted">{results.health.day ? `Analysis of ${day(results.health.day)}.` : "Run an analysis to measure it."}</p>
          </Card>
        )}
      </div>
    </div>
  );
}

/** The queries with the most clicks, each figure beside its value in the 28 days before. */
function TopQueries({ rows }: { rows: TopQuery[] }) {
  const ctr = (clicks: number, impressions: number) => (impressions ? pct(clicks / impressions) : "—");
  return (
    <div className="table-wrap">
      <table className="table top-queries">
        <thead><tr><th>Query</th><th className="num">Clicks</th><th className="num">Impressions</th><th className="num">CTR</th><th className="num">Position</th></tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.query}>
            <td>{row.query}{!row.before && <span className="was">new</span>}</td>
            <td className="num">{formatNumber(row.clicks)}{row.before && <span className="was">was {formatNumber(row.before.clicks)}</span>}</td>
            <td className="num">{formatNumber(row.impressions)}{row.before && <span className="was">was {formatNumber(row.before.impressions)}</span>}</td>
            <td className="num">{ctr(row.clicks, row.impressions)}{row.before && <span className="was">was {ctr(row.before.clicks, row.before.impressions)}</span>}</td>
            <td className="num">{row.position.toFixed(1)}{row.before && <span className="was">was {row.before.position.toFixed(1)}</span>}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

/** Why organic sessions are missing: never connected, needs the Analytics permission, or not synced yet. */
function analyticsState(analytics: Payload["site"]["analytics"], operator: boolean) {
  if (analytics === "reconnect") return operator ? "Reconnect Google in Setup to add Analytics" : "Analytics not connected yet";
  if (analytics === "connected") return "Collecting data";
  return operator ? "Connect Google Analytics" : "Analytics not connected yet";
}

function ConnectPrompt({ operator, what, onNavigate }: { operator: boolean; what: string; onNavigate?: (view: "connections") => void }) {
  return (
    <div className="empty-state">
      {operator ? <>Connect {what} to see 16 months of history. <Button small variant="secondary" onClick={() => onNavigate?.("connections")}>Open Setup</Button></> : `${what} is not connected yet.`}
    </div>
  );
}
