"use client";

import { useState } from "react";
import { countryName, SERP_FEATURES, type CompetitorSuggestion } from "@organic-growth/core";
import { api, errorMessage, formatDay, formatNumber } from "../api";
import { BarList, LineChart } from "../charts";
import type { Payload } from "../site-data";
import { Badge, Button, Card, Kpi } from "../ui";

/*
 * The connectors beyond Google: who ranks for the site's searches and what
 * their results pages hold, link profiles and the link gap, Bing, and the
 * crawl log the site's servers send. `operator` decides between a setup
 * prompt and a plain "not measured yet", as in sections.tsx.
 */

type Section = { data: Payload; operator: boolean };

const num = (value: number | null | undefined) => (value === null || value === undefined ? "—" : formatNumber(value));
const featureLabel = (feature: string) => SERP_FEATURES.find((entry) => entry.feature === feature)?.label ?? feature;
const pct = (value: number, total: number) => (total ? `${Math.round((value / total) * 100)}%` : "—");

/** The results pages behind the site's biggest searches: which result types crowd them, who ranks, and where the site sits. */
export function SearchResultsCard({ data, operator }: Section) {
  const { serp, markets } = data.results;
  const empty = !data.site.signals.keywords && !serp.checked
    ? (operator ? "Add DataForSEO credentials to check the results pages of your biggest searches." : "Not measured yet.")
    : !markets.length ? (operator ? "Set target markets in Setup: results pages are per country." : "Not measured yet.")
    : !serp.checked ? "Results pages are checked after the keyword lists sync, ten searches a day."
    : null;
  return (
    <Card title="Search results pages" subtitle={`Google's first page for your biggest searches and the competitors' biggest gaps, from DataForSEO, each checked monthly${serp.asOf ? ` (latest ${formatDay(serp.asOf)})` : ""}.`}>
      {empty ? <p className="empty-state">{empty}</p> : (
        <>
          <div className="metrics-grid c3">
            <Kpi label="Searches checked" value={formatNumber(serp.checked)} caption={markets.length > 1 ? markets.map(countryName).join(", ") : countryName(markets[0]!)} />
            <Kpi label="With an AI Overview" value={formatNumber(serp.aiOverview.searches)} caption={`${pct(serp.aiOverview.searches, serp.checked)} of the searches checked`} />
            <Kpi label="AI Overviews citing you" value={formatNumber(serp.aiOverview.citesYou)} caption={serp.aiOverview.searches ? `of ${formatNumber(serp.aiOverview.searches)}` : "No AI Overviews on these searches"} />
          </div>
          {serp.features.length > 0 && (
            <>
              <div className="section-title">What else is on the page</div>
              <BarList format={(value) => `${formatNumber(value)} of ${formatNumber(serp.checked)}`} rows={serp.features.map((entry) => ({ label: entry.label, value: entry.searches }))} />
            </>
          )}
          <div className="section-title">Who ranks</div>
          <div className="table-wrap">
            <table className="table top-queries">
              <thead><tr><th>Search</th><th className="num">Searches / month</th><th className="num">You</th><th>On the page</th><th>Top three</th></tr></thead>
              <tbody>{serp.rows.map((row) => (
                <tr key={`${row.market}|${row.keyword}`}>
                  <td>{row.keyword}{markets.length > 1 && <span className="was">{countryName(row.market)}</span>}</td>
                  <td className="num">{num(row.volume)}</td>
                  <td className="num">{row.position === null ? <span className="muted">not in top 10</span> : row.position}{row.cited && <span className="was">cited by AI</span>}</td>
                  <td>{row.features.length ? row.features.map((feature) => <Badge key={feature} tone={feature === "ai_overview" ? "amber" : undefined}>{featureLabel(feature)}</Badge>) : <span className="muted">Links only</span>}</td>
                  <td className="small">{row.organic.slice(0, 3).map((entry) => <div key={entry.url}><a href={entry.url} target="_blank" rel="noreferrer">{entry.domain}</a></div>)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="small muted">Desktop results in each target market. An AI Overview, a map pack or a featured snippet above the links takes clicks a top-three position would otherwise get.</p>
        </>
      )}
    </Card>
  );
}

const KIND_LABEL: Record<CompetitorSuggestion["kind"], string> = { competitor: "Search competitor", directory: "Directory", platform: "Platform" };

/** Domains that win the site's searches and aren't listed as competitors yet; adding one brings it into the next analysis and every competitor list. */
export function CompetitorSuggestionsCard({ siteId, data, onAdded }: { siteId: string; data: Payload; onAdded?: () => void }) {
  const [added, setAdded] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const suggestions = data.results.serp.suggestions.filter((entry) => !added.includes(entry.domain));
  if (!suggestions.length && !added.length) return null;
  async function add(domain: string) {
    setBusy(domain); setError("");
    try {
      const current = await api<{ domains: string[] }>(`/api/sites/${siteId}/competitors`);
      await api(`/api/sites/${siteId}/competitors`, { method: "PUT", json: { domains: [...current.domains, domain] } });
      setAdded((list) => [...list, domain]);
      onAdded?.();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }
  return (
    <Card title="Who you're actually up against" subtitle="Domains that rank for your searches in your target markets and aren't on your competitor list, most visible first (DataForSEO, monthly). Social sites and encyclopedias are left out.">
      {error && <div className="callout error" role="alert">{error}</div>}
      {added.length > 0 && <p className="small">Added {added.join(", ")}. The next sync fetches their keywords and links; the next analysis reads their sitemaps.</p>}
      {suggestions.length > 0 && (
        <div className="table-wrap">
          <table className="table top-queries">
            <thead><tr><th>Domain</th><th>Kind</th><th className="num">Searches they rank for</th><th className="num">Best average position</th><th className="num">Est. visits / month</th><th /></tr></thead>
            <tbody>{suggestions.map((entry) => (
              <tr key={entry.domain}>
                <td><a href={`https://${entry.domain}`} target="_blank" rel="noreferrer">{entry.domain}</a>{entry.markets.length > 1 && <span className="was">{entry.markets.map(countryName).join(", ")}</span>}</td>
                <td><Badge tone={entry.kind === "directory" ? "gray" : "green"}>{KIND_LABEL[entry.kind]}</Badge></td>
                <td className="num">{formatNumber(entry.keywords)}</td>
                <td className="num">{entry.avgPosition.toFixed(1)}</td>
                <td className="num">{formatNumber(Math.round(entry.traffic))}</td>
                <td className="num"><Button small variant="secondary" busy={busy === entry.domain} onClick={() => add(entry.domain)}>Add</Button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <p className="small muted">A directory ranks for searches like yours without selling what you sell; it's worth a listing on it more than a page against it.</p>
    </Card>
  );
}

/** Each domain's link profile side by side, the site's referring domains over time, and the sites that link to competitors but not to the site. */
export function BacklinksCard({ data, operator }: Section) {
  const { links } = data.results;
  const host = new URL(data.site.baseUrl).hostname;
  const known = links.domains.filter((entry) => entry.summary);
  const empty = !data.site.signals.keywords && !links.synced
    ? (operator ? "Add DataForSEO credentials (with the Backlinks API active) to compare links with your competitors." : "Not measured yet.")
    : !known.length ? "Link profiles appear after the next sync."
    : null;
  return (
    <Card title="Backlinks" subtitle={`Live links from other sites, from DataForSEO's link index, refreshed monthly${links.asOf ? ` (latest ${formatDay(links.asOf)})` : ""}. Referring domains count each linking site once.`}>
      {empty ? <p className="empty-state">{empty}</p> : (
        <>
          <div className="table-wrap">
            <table className="table top-queries">
              <thead><tr><th>Domain</th><th className="num">Referring domains</th><th className="num">Backlinks</th><th className="num">Rank (0–1,000)</th><th className="num">Broken links to it</th></tr></thead>
              <tbody>{links.domains.map((entry, index) => (
                <tr key={entry.domain}>
                  <td>{index === 0 ? <strong>{host}</strong> : entry.domain}</td>
                  <td className="num">{num(entry.summary?.referringMainDomains)}</td>
                  <td className="num">{num(entry.summary?.backlinks)}</td>
                  <td className="num">{num(entry.summary?.rank)}</td>
                  <td className="num">{num(entry.summary?.brokenBacklinks)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {links.history.length > 1 && (
            <>
              <div className="section-title">{host}: referring domains over time</div>
              <LineChart series={["referring domains"]} partialFrom="9999-12-31" points={links.history.map((point) => ({ x: point.day, values: [point.value] }))} />
            </>
          )}
          <div className="section-title">Link gap</div>
          {links.gap === null
            ? <p className="empty-state">{operator ? "Add competitors in Setup to find the sites that link to them and not to you." : "Not measured yet."}</p>
            : links.gap.length ? (
              <>
                <p className="small muted" style={{ marginTop: 0 }}>{formatNumber(links.gapTotal)} sites link to {links.gap[0]!.linksTo.length > 1 ? "every competitor checked" : links.gap[0]!.linksTo[0]} but not to you; the strongest first. Each already links to businesses like yours.</p>
                <div className="table-wrap">
                  <table className="table top-queries">
                    <thead><tr><th>Linking site</th><th className="num">Rank</th><th>Links to</th></tr></thead>
                    <tbody>{links.gap.map((row) => (
                      <tr key={row.domain}>
                        <td><a href={`https://${row.domain}`} target="_blank" rel="noreferrer">{row.domain}</a></td>
                        <td className="num">{formatNumber(row.rank)}</td>
                        <td className="small">{row.linksTo.join(", ")}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </>
            ) : <p className="empty-state">No site links to your competitors without linking to you.</p>}
        </>
      )}
    </Card>
  );
}

/** Bing's clicks and impressions per week, and how much of the site it has indexed. Bing's index also feeds Copilot and other assistants built on it. */
export function BingCard({ data, operator }: Section) {
  const { bing } = data.results;
  return (
    <Card title="Bing" subtitle="Clicks and impressions from Bing Webmaster Tools, 28 days to yesterday. Bing's index also answers Copilot and the AI assistants that search with it.">
      {bing ? (
        <>
          <div className="metrics-grid">
            <Kpi label="Bing clicks · 28 days" value={num(bing.clicks.current)} caption={bing.clicks.previous === null ? "First 28 days of data" : `${formatNumber(bing.clicks.previous)} in the 28 days before`} />
            <Kpi label="Bing impressions · 28 days" value={num(bing.impressions.current)} caption={bing.impressions.previous === null ? "First 28 days of data" : `${formatNumber(bing.impressions.previous)} in the 28 days before`} />
            <Kpi label="Pages in Bing's index" value={num(bing.inIndex)} caption="Bing's latest count" />
            <Kpi label="Crawl errors" value={num(bing.crawlErrors)} caption="On Bing's latest day" />
          </div>
          {bing.weeks.some((week) => week.clicks !== null) && (
            <>
              <div className="section-title">Clicks per week</div>
              <LineChart series={["clicks", "impressions"]} partialFrom={bing.weeks.find((week) => week.partial)?.week} points={bing.weeks.map((week) => ({ x: week.week, values: [week.clicks, week.impressions] }))} />
            </>
          )}
        </>
      ) : <p className="empty-state">{operator ? (data.site.signals.bing ? "Bing fills in on the next sync." : "Add a Bing Webmaster Tools API key (BING_WEBMASTER_API_KEY) and verify the site in Bing to see Bing's clicks.") : "Not connected yet."}</p>}
    </Card>
  );
}

/** What search engines and AI agents request on the whole site, from its own logs: per crawler, per page type, and where Googlebot's requests go to waste. */
export function CrawlLogCard({ data, onSetup }: { data: Payload; onSetup?: () => void }) {
  const log = data.results.crawlLog;
  const subtitle = "Requests from crawlers in your server or CDN logs, 28 days to yesterday. Only crawler requests are kept; a visitor's never is.";
  if (!log) {
    return (
      <Card title="What crawlers request" subtitle={subtitle}>
        <div className="empty-state">Send your server or CDN logs to Eumon to see which pages Googlebot, Bingbot and AI agents actually fetch, across the whole site. {onSetup && <Button small variant="secondary" onClick={onSetup}>Set up logs</Button>}</div>
      </Card>
    );
  }
  const googlebot = log.totals.googlebot;
  const wasted = log.statuses.redirects + log.statuses.clientErrors + log.statuses.serverErrors;
  return (
    <Card title="What crawlers request" subtitle={subtitle}>
      <div className="metrics-grid">
        <Kpi label="Googlebot · 28 days" value={formatNumber(googlebot)} caption={`logs since ${formatDay(log.since!)}`} />
        <Kpi label="Bingbot · 28 days" value={formatNumber(log.totals.bingbot)} caption="Bing and the assistants built on it" />
        <Kpi label="AI agents · 28 days" value={formatNumber(log.totals.ai)} caption="The whole site, not only Eumon's pages" />
        <Kpi label="Googlebot requests wasted" value={pct(wasted, googlebot)} caption={`${formatNumber(wasted)} redirects and errors`} />
      </div>
      <div className="ruled-grid c11 results-pair">
        <div>
          <div className="section-title">Googlebot by page type</div>
          {log.families.length ? <BarList rows={log.families.slice(0, 10).map((entry) => ({ label: `${entry.family}${entry.errors ? ` · ${pct(entry.errors, entry.hits)} errors` : ""}`, value: entry.hits }))} />
            : <p className="empty-state">No Googlebot requests in these 28 days.</p>}
        </div>
        <div>
          <div className="section-title">What Googlebot got back</div>
          <BarList rows={[
            { label: "Pages (2xx)", value: log.statuses.ok }, { label: "Redirects (3xx)", value: log.statuses.redirects },
            { label: "Not found and other 4xx", value: log.statuses.clientErrors }, { label: "Server errors (5xx)", value: log.statuses.serverErrors },
            { label: "URLs with a query string", value: log.parameterHits },
          ]} />
        </div>
      </div>
      {log.weeks.length > 1 && (
        <>
          <div className="section-title">Requests per week</div>
          <LineChart series={["Googlebot", "Bingbot", "AI agents"]} partialFrom={log.weeks.find((week) => week.partial)?.week} points={log.weeks.map((week) => ({ x: week.week, values: [week.googlebot, week.bingbot, week.ai] }))} />
        </>
      )}
      <p className="small muted">Counted from each request's user agent, which a bot can fake. Redirects, errors and query-string URLs spend crawl requests that could have gone to pages you want indexed.</p>
    </Card>
  );
}
