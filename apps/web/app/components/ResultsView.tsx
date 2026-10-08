"use client";

import { useCallback, useEffect, useState } from "react";
import { countryName, type Compare, type ResultsView as Results } from "@organic-growth/core";
import { api, errorMessage, formatNumber } from "./api";
import { Funnel, LineChart } from "./charts";
import { Button, Card, Kpi, ViewHeader } from "./ui";

type Payload = { site: { name: string; baseUrl: string; searchConnected: boolean; analytics: "connected" | "reconnect" | "none" }; results: Results };

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
        title={operator ? "Results" : site.name}
        description={<>Is Eumon working for {host}? {results.searchThrough ? `Google data through ${day(results.searchThrough)}.` : "Google data appears after the first sync."}</>}
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
          <Kpi label="Enquiries · 28 days" value={results.numbers.leads.current === null ? "—" : formatNumber(results.numbers.leads.current)} caption={versus(results.numbers.leads)} />
          <Kpi label="Organic sessions · 28 days" value={results.numbers.organicSessions?.current == null ? "—" : formatNumber(results.numbers.organicSessions.current)} caption={results.numbers.organicSessions ? versus(results.numbers.organicSessions) : analyticsState(site.analytics, operator)} />
          <Kpi label="Pages live" value={formatNumber(pages.live)} caption={pages.live ? `${formatNumber(pages.indexed)} indexed · ${formatNumber(pages.notIndexed)} not · ${formatNumber(pages.unchecked)} not checked yet` : "No Eumon pages published yet"} />
        </div>

        <Card title="Are more people finding you on Google?" subtitle={results.search?.scoped ? `Scoped to your target markets: ${results.markets.map(countryName).join(", ")}.` : results.markets.length ? "Every country, until your target markets' history is synced." : operator ? "Every country. Set target markets in Connections to focus this section." : "Every country."}>
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
              <p className="small muted">Search Console leaves out anonymized queries, so query counts are lower than total clicks suggest. Data arrives two to three days late.</p>
            </>
          ) : <ConnectPrompt operator={operator} what="Search Console" onNavigate={onNavigate} />}
          {results.organic && (
            <>
              <div className="section-title">Organic sessions per week, from Google Analytics</div>
              <LineChart series={["organic sessions", "GA4 key events"]} partialFrom={partialFrom} marker={goLive} points={results.organic.map((week) => ({ x: week.week, values: [week.sessions, week.keyEvents] }))} />
            </>
          )}
        </Card>

        <Card title="Is it bringing enquiries?" subtitle="Eumon's pages from a Google search to an enquiry, over the last 28 days of Search Console data.">
          {results.leads.funnel ? <Funnel steps={results.leads.funnel} /> : <p className="empty-state">The funnel appears once Eumon's pages have Google impressions.</p>}
          <div className="section-title">Enquiries per week</div>
          {results.leads.weeks.some((week) => week.other !== null || week.eumon !== null)
            ? <LineChart series={["from eumon pages", "everything else"]} marker={goLive} partialFrom={results.leads.weeks.find((week) => week.partial)?.week} points={results.leads.weeks.map((week) => ({ x: week.week, values: [week.eumon, week.other] }))} />
            : <p className="empty-state">{operator ? "No enquiries tracked yet. Install tracking in Setup to count WhatsApp taps, calls, and forms." : "No enquiries tracked yet."}</p>}
        </Card>

        {operator && (
          <Card title="Is the site healthy?" subtitle="Share of crawled sitemap pages with no error, no empty HTML, and no noindex, from the latest analysis.">
            <div className="big-number">{results.health.value === null ? "—" : `${results.health.value}%`}</div>
            <p className="small muted">{results.health.day ? `Analysis of ${day(results.health.day)}.` : "Run an analysis to measure it."}</p>
          </Card>
        )}
      </div>
    </div>
  );
}

/** Why organic sessions are missing: never connected, needs the Analytics permission, or not synced yet. */
function analyticsState(analytics: Payload["site"]["analytics"], operator: boolean) {
  if (analytics === "reconnect") return operator ? "Reconnect Google in Connections to add Analytics" : "Analytics not connected yet";
  if (analytics === "connected") return "Collecting data";
  return operator ? "Connect Google Analytics" : "Analytics not connected yet";
}

function ConnectPrompt({ operator, what, onNavigate }: { operator: boolean; what: string; onNavigate?: (view: "connections") => void }) {
  return (
    <div className="empty-state">
      {operator ? <>Connect {what} to see 16 months of history. <Button small variant="secondary" onClick={() => onNavigate?.("connections")}>Open Connections</Button></> : `${what} is not connected yet.`}
    </div>
  );
}
