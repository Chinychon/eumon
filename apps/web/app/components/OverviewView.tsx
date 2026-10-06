"use client";

import { useCallback, useEffect, useState } from "react";
import { COUNTRIES, countryName, type SiteRecord } from "@organic-growth/core";
import { api, errorMessage, formatNumber } from "./api";
import { Badge, Button, Card, Kpi, usePolling, ViewHeader } from "./ui";

export type Repository = { id: number; name: string; fullName: string; owner: string; defaultBranch: string; isPrivate: boolean };

type Finding = { id: string; category: string; severity: string; title: string; summary: string; recommendation?: string; organicImpactScore: number };

type Report = {
  analysisId: string;
  site: { name: string; baseUrl: string; fingerprint?: { framework: string; rendering?: string; deployment?: string } };
  sitemap: { totalUrls: number; sampledUrls: number; errors: string[] };
  coverage?: {
    totalUrls: number;
    completedUrls: number;
    emptyShellUrls: number;
    httpErrorUrls: number;
    families?: Array<{ family: string; urls: number; crawled: number; emptyShells: number; errors: number; noindex: number; missingStructuredData: number }>;
  } | null;
  pages: Array<{ url: string; renderedTextLength: number }>;
  findings: Finding[];
  competitors: Array<{ domain: string; category: string; summary: string; relevanceScore?: number; architectureNotes?: string; conversionNotes?: string; technicalNotes?: string }>;
  opportunities: Array<{ title: string; rationale: string; priorityScore: number; potentialPage?: string }>;
  plan: { situation: string; competitiveAdvantage: string; highestImpactOpportunity: string; priorities: Array<{ rank: number; title: string; whyThisMatters: string }> };
  searchNarrative: { totalClicks: number; totalImpressions: number; narrative: string };
  competition?: {
    rows: Array<{
      key: string;
      label: string;
      status: "gap" | "advantage" | "shared" | "yours_only";
      you: { pages: number };
      data?: { dataset: string; records: number; livePages: number };
      competitors: Array<{ domain: string; pages: number; examples: string[] }>;
    }>;
    competitors: Array<{ domain: string; analyzed: boolean; partial: boolean; estimatedUrls: number }>;
    insights: string[];
    aiLabels: boolean;
  } | null;
  conversion?: {
    templates: Array<{ family: string; url: string; paths: string[]; prices: boolean; tracking: string[] }>;
    tracking: string[];
    suggestedEvents: Array<{ event: string; trigger: string }>;
  } | null;
  search?: {
    totals: { clicks: number; impressions: number; ctr: number };
    targetMarkets: string[];
    targetShare: { clicks: number; impressions: number } | null;
    countries: Array<{ country: string; name: string; impressionShare: number }>;
    brandedShare: number;
    commercialShare: number;
    entityQueries: { share: number; byType: Array<{ entityType: string; clicks: number; examples: string[] }> } | null;
    strikingDistance: Array<{ query: string; page: string; position: number; impressions: number; clicks: number }>;
    lowCtrPages: Array<{ page: string; impressions: number; ctr: number; expectedCtr: number; position: number; queries: string[] }>;
    cannibalized: Array<{ query: string; impressions: number; pages: Array<{ page: string; position: number }> }>;
    narrative: string;
  } | null;
  repo?: { fingerprint: Fingerprint; routeInspections?: RouteInspection[]; sitemapCode?: { source: string; splitsSitemaps: boolean } } | null;
  rendering?: {
    comparisons: Array<{ url: string; family: string; verdict: string; rawTextLength: number; renderedTextLength: number; rawTitle?: string; renderedTitle?: string }>;
    repeatability: Array<{ family: string; urls: number; attempts: number; failed: number; medianMs: number }>;
  };
};

type RouteInspection = { pathPattern: string; source: string; dynamic: boolean; rendering: string; renderingEvidence?: string; clientDataFetching?: string; metadata: string; sequentialAwaits: number; unboundedQueries: string[] };
type Fingerprint = { framework: string; router?: string; rendering?: string; deployment?: string; cms?: string; database?: string; analytics: string[]; seoTooling: string[]; contentSource?: string; language: string; packageManager: string };

type Change = { id: string; findingId?: string; title: string; reason: string; patch: string; prUrl?: string };

const SEVERITY_CLASS: Record<string, string> = { CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low", INFORMATIONAL: "info" };

export function OverviewView({ site, repositories, githubInstalled, onSiteChanged, onNavigate }: {
  site: SiteRecord;
  repositories: Repository[];
  githubInstalled: boolean;
  onSiteChanged: (site: SiteRecord) => void;
  onNavigate: (view: "data" | "pages" | "performance" | "setup") => void;
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [pendingId, setPendingId] = useState("");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [changes, setChanges] = useState<Change[]>([]);
  const [busy, setBusy] = useState("");
  const [gscProperties, setGscProperties] = useState<Array<{ siteUrl: string }>>([]);
  const [gscSelected, setGscSelected] = useState(site.gscProperty ?? "");
  const [gscMessage, setGscMessage] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [conversions, setConversions] = useState<{ totalEvents: number; last28Days: number; leads: number } | null>(null);
  const [allFindings, setAllFindings] = useState(false);
  const [markets, setMarkets] = useState<string[]>([]);

  const loadChanges = useCallback(async (analysisId: string) => {
    const data = await api<{ changes: Change[] }>(`/api/analyses/${analysisId}/changes`).catch(() => ({ changes: [] }));
    setChanges(data.changes);
  }, []);

  useEffect(() => {
    setReport(null); setPendingId(""); setError(""); setChanges([]); setGscSelected(site.gscProperty ?? "");
    void (async () => {
      try {
        const latest = await api<{ analysis: { analysisId: string; status: string; report?: Report; error?: string } | null }>(`/api/sites/${site.id}/analyses`);
        if (latest.analysis?.status === "completed" && latest.analysis.report) {
          setReport(latest.analysis.report);
          void loadChanges(latest.analysis.analysisId);
        } else if (latest.analysis?.status === "queued" || latest.analysis?.status === "running") {
          setPendingId(latest.analysis.analysisId);
        } else if (latest.analysis?.status === "failed") {
          setError(`The last analysis failed: ${latest.analysis.error ?? "unknown error"}`);
        }
      } catch (cause) { setError(errorMessage(cause)); }
    })();
    api<{ domains: string[] }>(`/api/sites/${site.id}/competitors`).then((data) => setCompetitors(data.domains.join("\n"))).catch(() => undefined);
    api<{ countries: string[] }>(`/api/sites/${site.id}/markets`).then((data) => setMarkets(data.countries)).catch(() => setMarkets([]));
    api<{ properties: Array<{ siteUrl: string }>; selected: string | null }>(`/api/sites/${site.id}/gsc/properties`)
      .then((data) => { setGscProperties(data.properties); if (data.selected) setGscSelected(data.selected); })
      .catch(() => setGscProperties([]));
    api<{ totalEvents: number; last28Days: number; leads: number }>(`/api/sites/${site.id}/events/summary`).then(setConversions).catch(() => undefined);
  }, [site.id, site.gscProperty, loadChanges]);

  usePolling(Boolean(pendingId), async () => {
    const job = await api<{ status: string; progress?: { message: string }; report?: Report; error?: string }>(`/api/analyses/${pendingId}`);
    setProgress(job.progress?.message ?? `Analysis ${job.status}`);
    if (job.status === "completed" && job.report) {
      setReport(job.report);
      void loadChanges(pendingId);
      setPendingId("");
      return false;
    }
    if (job.status === "failed") {
      setError(job.error ?? "Analysis failed.");
      setPendingId("");
      return false;
    }
  });

  async function runAnalysis() {
    setError(""); setBusy("analysis");
    try {
      await api(`/api/sites/${site.id}/competitors`, { method: "PUT", json: { domains: competitors.split(/[\n,]/).map((value) => value.trim()).filter(Boolean) } });
      const queued = await api<{ analysisId: string }>(`/api/sites/${site.id}/analyses`, { method: "POST" });
      setProgress("Queued");
      setPendingId(queued.analysisId);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  async function saveMarkets(next: string[]) {
    setMarkets(next);
    try {
      await api(`/api/sites/${site.id}/markets`, { method: "PUT", json: { countries: next } });
    } catch (cause) { setError(errorMessage(cause)); }
  }

  async function attachRepository() {
    setBusy("repo"); setError("");
    try {
      const data = await api<{ site: SiteRecord }>("/api/sites", { method: "POST", json: { websiteUrl: site.baseUrl, repositoryId: Number(repositoryId) } });
      onSiteChanged(data.site);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  async function chooseProperty(property: string) {
    setGscSelected(property);
    try {
      await api(`/api/sites/${site.id}/gsc/properties`, { method: "POST", json: { property } });
      setGscMessage("Search Console property saved.");
      onSiteChanged({ ...site, gscProperty: property });
    } catch (cause) { setGscMessage(errorMessage(cause)); }
  }

  async function generateChange(findingId: string) {
    if (!report) return;
    setBusy(findingId); setError("");
    try {
      const data = await api<{ change: Change }>(`/api/analyses/${report.analysisId}/changes`, { method: "POST", json: { findingId } });
      setChanges((items) => [...items, data.change]);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  async function openPullRequest(change: Change) {
    setBusy(change.id); setError("");
    try {
      const data = await api<{ pullRequest: { url: string } }>(`/api/changes/${change.id}/pull-request`, { method: "POST" });
      setChanges((items) => items.map((item) => (item.id === change.id ? { ...item, prUrl: data.pullRequest.url } : item)));
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  const hasRepo = Boolean(site.githubRepo);
  const findings = [...(report?.findings ?? [])].sort((a, b) => b.organicImpactScore - a.organicImpactScore);
  const coverage = report?.coverage;

  return (
    <div>
      <ViewHeader
        eyebrow="SITE INTELLIGENCE"
        title={site.name}
        description={<>What Google receives from <a href={site.baseUrl} target="_blank" rel="noreferrer">{site.baseUrl}</a>, what is holding organic traffic back, and what to fix first.</>}
        actions={<Button busy={busy === "analysis" || Boolean(pendingId)} onClick={runAnalysis}>{pendingId ? progress || "Analyzing…" : report ? "Re-run analysis" : "Run analysis"}</Button>}
      />
      {error && <div className="callout error" role="alert" style={{ marginBottom: 14 }}>{error}</div>}

      <div className="split">
        <Card title="Connections" subtitle="Each connection adds evidence. Only the website is required.">
          <div className="list-row">
            <Badge tone="green">Website</Badge>
            <div className="grow"><h4>{site.baseUrl}</h4><p>Crawled as Googlebot, including every sitemap URL.</p></div>
          </div>
          <div className="list-row">
            <Badge tone={hasRepo ? "green" : "gray"}>{hasRepo ? "GitHub" : "Optional"}</Badge>
            <div className="grow">
              <h4>{hasRepo ? `${site.githubOwner}/${site.githubRepo}` : "GitHub repository"}</h4>
              <p>{hasRepo ? "Code-level analysis and reviewable pull requests are enabled." : "Adds framework and route analysis and lets Eumon open fix PRs. Skip this for WordPress, Drupal, or other CMS sites."}</p>
              {!hasRepo && (githubInstalled && repositories.length ? (
                <div className="row" style={{ marginTop: 8 }}>
                  <select className="select" style={{ maxWidth: 320 }} value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>
                    <option value="">Choose a repository</option>
                    {repositories.map((repo) => <option key={repo.id} value={repo.id}>{repo.fullName}{repo.isPrivate ? " · private" : ""}</option>)}
                  </select>
                  <Button small variant="secondary" disabled={!repositoryId} busy={busy === "repo"} onClick={attachRepository}>Connect</Button>
                </div>
              ) : <a className="btn btn-secondary btn-small" style={{ marginTop: 8 }} href="/api/github/install">Connect GitHub ↗</a>)}
            </div>
          </div>
          <div className="list-row">
            <Badge tone={site.gscProperty ? "green" : "gray"}>{site.gscProperty ? "Search Console" : "Recommended"}</Badge>
            <div className="grow">
              <h4>{site.gscProperty ?? "Google Search Console"}</h4>
              <p>Queries, impressions, and rankings — the evidence behind page opportunities and the performance loop.</p>
              <div className="row" style={{ marginTop: 8 }}>
                <a className="btn btn-secondary btn-small" href={`/api/sites/${site.id}/gsc/connect`}>{gscProperties.length || site.gscProperty ? "Reconnect Google" : "Connect Google ↗"}</a>
                {gscProperties.length > 0 && (
                  <select className="select" style={{ maxWidth: 320 }} value={gscSelected} onChange={(event) => void chooseProperty(event.target.value)}>
                    <option value="">Choose a property</option>
                    {gscProperties.map((property) => <option key={property.siteUrl} value={property.siteUrl}>{property.siteUrl}</option>)}
                  </select>
                )}
              </div>
              {gscMessage && <p className="small">{gscMessage}</p>}
            </div>
          </div>
          <div className="list-row">
            <Badge tone={markets.length ? "green" : "gray"}>{markets.length ? "Markets" : "Recommended"}</Badge>
            <div className="grow">
              <h4>Target markets</h4>
              <p>The countries you sell to. Search traffic is checked against them, so visibility in the wrong market shows up as a problem.</p>
              <div className="row" style={{ marginTop: 8 }}>
                {markets.map((code) => <span className="chip" key={code}>{countryName(code)} <button className="chip-remove" aria-label={`Remove ${countryName(code)}`} onClick={() => void saveMarkets(markets.filter((entry) => entry !== code))}>×</button></span>)}
                <select className="select" style={{ maxWidth: 220 }} value="" onChange={(event) => event.target.value && void saveMarkets([...markets, event.target.value])}>
                  <option value="">Add a country…</option>
                  {COUNTRIES.filter((country) => !markets.includes(country.code)).map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
                </select>
              </div>
            </div>
          </div>
          <div className="list-row">
            <Badge tone={competitors.trim() ? "green" : "gray"}>Competitors</Badge>
            <div className="grow">
              <h4>Competitor domains</h4>
              <p>Saved with the next analysis run; one per line.</p>
              <textarea className="textarea" style={{ marginTop: 8, minHeight: 60 }} placeholder={"competitor-one.com\ncompetitor-two.com"} value={competitors} onChange={(event) => setCompetitors(event.target.value)} />
            </div>
          </div>
        </Card>

        <Card title="Landing page engine" subtitle="Turn what you sell into one high-intent landing page per thing people search for.">
          <ol className="small steps-list">
            <li>Scope the data that matters (doctors, procedures, malls, products…)</li>
            <li>Find and collect it from your site or public sources</li>
            <li>Generate a landing page per record, with a clear call to action</li>
            <li>Serve real HTML on your domain, crawlable by Google</li>
            <li>Track which pages bring visits, clicks, and conversions — then improve them</li>
          </ol>
          <div className="row">
            <Button onClick={() => onNavigate("data")}>Scope my data →</Button>
            <Button variant="secondary" onClick={() => onNavigate("performance")}>See performance</Button>
          </div>
          {conversions && <p className="small muted" style={{ marginTop: 12 }}>Conversion events: {formatNumber(conversions.totalEvents)} total · {formatNumber(conversions.last28Days)} in the last 28 days</p>}
        </Card>
      </div>

      {report && (
        <div className="results">
          <div className="metrics-grid">
            <Kpi label="URLs in sitemap" value={formatNumber(report.sitemap.totalUrls)} caption={report.sitemap.errors[0] ? "See sitemap note below" : "Declared to search engines"} />
            <Kpi label="Crawled as Googlebot" value={coverage ? `${formatNumber(coverage.completedUrls)}/${formatNumber(coverage.totalUrls)}` : "—"} caption={coverage ? `${formatNumber(coverage.emptyShellUrls)} empty shells · ${formatNumber(coverage.httpErrorUrls)} errors` : "Full crawl not run"} />
            <Kpi label="Key findings" value={findings.length} caption="Ranked by organic impact" />
            <Kpi label="Browser rendered" value={`${report.rendering?.comparisons.length ?? report.pages.filter((page) => page.renderedTextLength > 0).length}`} caption="Templates compared with raw HTML" />
          </div>
          <div className="dashboard-columns">
            <section className="panel" id="findings">
              <div className="panel-heading"><div><div className="eyebrow">WHAT WE FOUND</div><h3>Technical findings</h3></div><span className="count-pill">{findings.length} findings</span></div>
              {findings.length ? findings.slice(0, allFindings ? findings.length : 8).map((finding) => {
                const change = changes.find((item) => item.findingId === finding.id);
                const fixable = hasRepo && ["sitemap", "indexing"].includes(finding.category);
                return (
                  <article className="finding" key={finding.id}>
                    <span className={`severity ${SEVERITY_CLASS[finding.severity] ?? "info"}`}>{finding.severity}</span>
                    <div>
                      <h4>{finding.title}</h4>
                      <p>{finding.summary}</p>
                      {finding.recommendation && <small>Next step: {finding.recommendation}</small>}
                      {fixable && !change && <button className="inline-action" disabled={Boolean(busy)} onClick={() => generateChange(finding.id)}>{busy === finding.id ? "Preparing reviewable change…" : "Generate safe configuration fix"}</button>}
                      {change && (
                        <div className="change-card">
                          <strong>{change.title}</strong>
                          <p>{change.reason}</p>
                          <pre>{change.patch}</pre>
                          {change.prUrl ? <a href={change.prUrl} target="_blank" rel="noreferrer">Open draft pull request ↗</a> : <button className="inline-action" disabled={Boolean(busy)} onClick={() => openPullRequest(change)}>{busy === change.id ? "Opening draft PR…" : "Create draft GitHub PR"}</button>}
                        </div>
                      )}
                    </div>
                    <span className="impact">{finding.organicImpactScore}<small>impact</small></span>
                  </article>
                );
              }) : <p className="empty-state">No high-impact technical issues surfaced. Connect Search Console to find demand and page opportunities.</p>}
              {findings.length > 8 && <button className="inline-action" onClick={() => setAllFindings((value) => !value)}>{allFindings ? "Show the top 8" : `Show all ${findings.length} findings`}</button>}
            </section>
            <section className="panel" id="plan">
              <div className="panel-heading"><div><div className="eyebrow">WEBSITE-SPECIFIC STRATEGY</div><h3>Growth plan</h3></div><span className="sparkle">✳</span></div>
              <p className="plan-situation">{report.plan.situation}</p>
              <div className="advantage"><span>YOUR ADVANTAGE</span><p>{report.plan.competitiveAdvantage}</p></div>
              <div className="priority-label">HIGHEST-IMPACT OPPORTUNITY</div>
              <p className="top-opportunity">{report.plan.highestImpactOpportunity}</p>
              <div className="priority-list">{report.plan.priorities.slice(0, 4).map((priority) => (
                <div className="priority-row" key={priority.rank}><span className="priority-number">0{priority.rank}</span><div><strong>{priority.title}</strong><small>{priority.whyThisMatters}</small></div></div>
              ))}</div>
            </section>
          </div>
          <div className="dashboard-columns lower-columns">
            <section className="panel">
              <div className="panel-heading"><div><div className="eyebrow">OPPORTUNITY ENGINE</div><h3>Where to focus</h3></div></div>
              {report.opportunities.length ? report.opportunities.slice(0, 4).map((opportunity) => (
                <div className="opportunity" key={opportunity.title}><div><strong>{opportunity.title}</strong><p>{opportunity.rationale}</p>{opportunity.potentialPage && <code>{opportunity.potentialPage}</code>}</div><span className="score">{Math.round(opportunity.priorityScore)}<small>priority</small></span></div>
              )) : <p className="empty-state">No opportunities yet.</p>}
            </section>
            <section className="panel">
              <div className="panel-heading"><div><div className="eyebrow">SEARCH LANDSCAPE</div><h3>Search & competitor evidence</h3></div></div>
              {report.searchNarrative.totalImpressions > 0 && !report.search && <div className="search-evidence"><strong>{formatNumber(report.searchNarrative.totalClicks)} clicks · {formatNumber(report.searchNarrative.totalImpressions)} impressions</strong><p>{report.searchNarrative.narrative}</p></div>}
              {report.competitors.length ? report.competitors.slice(0, 5).map((competitor) => (
                <div className="competitor" key={competitor.domain}>
                  <div className="domain-icon">{competitor.domain[0]?.toUpperCase()}</div>
                  <div><strong>{competitor.domain}</strong><small>{competitor.summary}{competitor.architectureNotes && <><br />{competitor.architectureNotes}</>}{competitor.conversionNotes && <><br />{competitor.conversionNotes}</>}</small></div>
                  <span className="relevance">{competitor.relevanceScore !== undefined ? <>{Math.round(competitor.relevanceScore * 100)}%<br /><small>overlap</small></> : <>Owner<br />selected</>}</span>
                </div>
              )) : <p className="empty-state">Add competitor domains above. Eumon reads their sitemaps and a few pages per section to show which kinds of pages they publish that you don't. Rankings and competitor traffic are not inferred.</p>}
            </section>
          </div>
          {report.search && <SearchIntelligence search={report.search} />}
          {report.conversion && report.conversion.templates.length > 0 && <ConversionPaths conversion={report.conversion} onNavigate={onNavigate} />}
          {report.competition && report.competition.rows.length > 0 && <ContentGaps competition={report.competition} onNavigate={onNavigate} />}
          {coverage?.families && coverage.families.length > 1 && <FamilyHealth families={coverage.families} />}
          {report.repo && <CodeIntelligence repo={report.repo} />}
          {report.rendering && (report.rendering.comparisons.length > 0 || report.rendering.repeatability.length > 0) && <RenderingChecks rendering={report.rendering} />}
          {report.sitemap.errors.length > 0 && <div className="crawl-note"><strong>Sitemap note</strong><span>{report.sitemap.errors.join(" ")}</span></div>}
        </div>
      )}
      {!report && !pendingId && !error && (
        <div className="empty" style={{ marginTop: 16 }}>Run an analysis to see what Google receives from this site — every sitemap URL is fetched as Googlebot.</div>
      )}
    </div>
  );
}

type FamilyStats = NonNullable<NonNullable<Report["coverage"]>["families"]>[number];

/** What Googlebot received for each page template, so problems point at the code that produces them. */
function FamilyHealth({ families }: { families: FamilyStats[] }) {
  const label = (family: string) => (family === "home" ? "Homepage" : family === "page" ? "Top-level pages" : `/${family}/`);
  const cell = (value: number, of: number) => (value ? <span className="bad-count">{formatNumber(value)}{of ? <small> ({Math.round((value / of) * 100)}%)</small> : null}</span> : <span className="muted">0</span>);
  return (
    <section className="panel" style={{ marginTop: 13 }}>
      <div className="panel-heading"><div><div className="eyebrow">RENDERING & INDEXING BY PAGE TYPE</div><h3>What Googlebot receives from each template</h3></div></div>
      <div className="table-wrap" style={{ marginBottom: 10 }}>
        <table className="table">
          <thead><tr><th>Page type</th><th className="num">Sitemap URLs</th><th className="num">Empty HTML</th><th className="num">Errors</th><th className="num">Noindex</th><th className="num">No structured data</th></tr></thead>
          <tbody>{families.slice(0, 12).map((family) => (
            <tr key={family.family}>
              <td><code>{label(family.family)}</code></td>
              <td className="num">{formatNumber(family.urls)}</td>
              <td className="num">{cell(family.emptyShells, family.crawled)}</td>
              <td className="num">{cell(family.errors, family.urls)}</td>
              <td className="num">{cell(family.noindex, family.crawled)}</td>
              <td className="num">{family.family === "home" || family.family === "page" ? <span className="muted">—</span> : cell(family.missingStructuredData, family.crawled)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}

const VERDICT: Record<string, { label: string; tone: string }> = {
  server_rendered: { label: "Server-rendered", tone: "green" },
  partially_client_rendered: { label: "Partly JavaScript", tone: "amber" },
  client_rendered: { label: "Needs JavaScript", tone: "red" },
  empty_after_render: { label: "Empty in browser too", tone: "red" },
};

/** Source-vs-render comparison per template, and repeated fetches that expose intermittent failures. */
function RenderingChecks({ rendering }: { rendering: NonNullable<Report["rendering"]> }) {
  return (
    <section className="panel" style={{ marginTop: 13 }}>
      <div className="panel-heading"><div><div className="eyebrow">RENDERING INTELLIGENCE</div><h3>HTML vs. browser, and repeated Googlebot fetches</h3></div></div>
      {rendering.comparisons.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 12 }}>
          <table className="table">
            <thead><tr><th>Page (one per template)</th><th className="num">Text in HTML</th><th className="num">Text after JavaScript</th><th>Verdict</th></tr></thead>
            <tbody>{rendering.comparisons.map((entry) => (
              <tr key={entry.url}>
                <td><a href={entry.url} target="_blank" rel="noreferrer">{new URL(entry.url).pathname}</a></td>
                <td className="num">{formatNumber(entry.rawTextLength)}</td>
                <td className="num">{formatNumber(entry.renderedTextLength)}</td>
                <td><Badge tone={VERDICT[entry.verdict]?.tone}>{VERDICT[entry.verdict]?.label ?? entry.verdict}</Badge></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {rendering.repeatability.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 10 }}>
          <table className="table">
            <thead><tr><th>Template</th><th className="num">URLs × fetches</th><th className="num">Empty or failed</th><th className="num">Median response</th></tr></thead>
            <tbody>{rendering.repeatability.map((entry) => (
              <tr key={entry.family}>
                <td><code>{entry.family === "home" ? "Homepage" : entry.family === "page" ? "Top-level pages" : `/${entry.family}/`}</code></td>
                <td className="num">{entry.urls} × {Math.round(entry.attempts / Math.max(entry.urls, 1))}</td>
                <td className="num">{entry.failed ? <span className="bad-count">{entry.failed} of {entry.attempts}</span> : <span className="muted">0</span>}</td>
                <td className="num">{entry.medianMs ? `${(entry.medianMs / 1000).toFixed(1)} s` : "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const GAP_STATUS: Record<string, { label: string; tone: string }> = {
  gap: { label: "Gap", tone: "red" },
  advantage: { label: "You lead", tone: "green" },
  yours_only: { label: "Only you", tone: "green" },
  shared: { label: "Comparable", tone: "gray" },
};

/** Which kinds of pages competitors publish, compared with yours and with the data you already hold. */
function ContentGaps({ competition, onNavigate }: { competition: NonNullable<Report["competition"]>; onNavigate: (view: "data") => void }) {
  const domains = competition.competitors.filter((competitor) => competitor.analyzed).slice(0, 3);
  const pages = (value: number) => (value ? `~${formatNumber(value)}` : "—");
  return (
    <section className="panel" style={{ marginTop: 13 }}>
      <div className="panel-heading">
        <div><div className="eyebrow">COMPETITOR CONTENT ARCHITECTURE</div><h3>What competitors publish, and what you have</h3></div>
        {competition.rows.some((row) => row.status === "gap") && <Button small variant="secondary" onClick={() => onNavigate("data")}>Close a gap in Data →</Button>}
      </div>
      {competition.insights.length > 0 && <ul className="insights">{competition.insights.slice(0, 6).map((insight) => <li key={insight}>{insight}</li>)}</ul>}
      <div className="table-wrap" style={{ marginBottom: 10 }}>
        <table className="table">
          <thead><tr><th>Content type</th><th className="num">You</th>{domains.map((competitor) => <th className="num" key={competitor.domain}>{competitor.domain}</th>)}<th>Status</th><th>Your data</th></tr></thead>
          <tbody>{competition.rows.slice(0, 15).map((row) => (
            <tr key={row.key}>
              <td>{row.label}</td>
              <td className="num">{pages(row.you.pages)}</td>
              {domains.map((competitor) => {
                const entry = row.competitors.find((item) => item.domain === competitor.domain);
                return <td className="num" key={competitor.domain}>{entry?.examples[0] ? <a href={entry.examples[0]} target="_blank" rel="noreferrer">{pages(entry.pages)}</a> : pages(entry?.pages ?? 0)}</td>;
              })}
              <td><Badge tone={GAP_STATUS[row.status]?.tone}>{GAP_STATUS[row.status]?.label ?? row.status}</Badge></td>
              <td className="small">{row.data ? `${row.data.dataset}: ${formatNumber(row.data.records)} records, ${formatNumber(row.data.livePages)} live` : <span className="muted">—</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p className="small muted" style={{ margin: "0 0 10px" }}>
        Page counts come from each site's sitemaps{competition.competitors.some((competitor) => competitor.partial) ? " (large sitemaps are sampled and extrapolated)" : ""}{competition.aiLabels ? "; sections are matched across sites by content type" : "; sections are matched by URL name"}. They show where competitors invest, not search demand.
      </p>
    </section>
  );
}

const RENDERING_LABEL: Record<string, { label: string; tone: string }> = {
  static: { label: "Static", tone: "green" },
  isr: { label: "Static + revalidate", tone: "green" },
  ssr: { label: "Server per request", tone: "blue" },
  on_demand: { label: "On demand", tone: "blue" },
  client: { label: "Browser", tone: "red" },
  unknown: { label: "Unknown", tone: "gray" },
};

/** The detected stack and what each route's code means for the HTML crawlers receive. */
function CodeIntelligence({ repo }: { repo: NonNullable<Report["repo"]> }) {
  const { fingerprint } = repo;
  const facts: Array<[string, string | undefined]> = [
    ["Framework", [fingerprint.framework, fingerprint.router].filter(Boolean).join(" · ")],
    ["Rendering", fingerprint.rendering],
    ["Language", `${fingerprint.language} · ${fingerprint.packageManager}`],
    ["Deployment", fingerprint.deployment],
    ["Content", fingerprint.contentSource ?? (fingerprint.cms !== "none" ? fingerprint.cms : undefined)],
    ["Database", fingerprint.database],
    ["Analytics", fingerprint.analytics.join(", ") || undefined],
    ["SEO tooling", fingerprint.seoTooling.join(", ") || undefined],
    ["Sitemap code", repo.sitemapCode ? `${repo.sitemapCode.source}${repo.sitemapCode.splitsSitemaps ? " (split)" : ""}` : undefined],
  ];
  const routes = [...(repo.routeInspections ?? [])].sort((a, b) => Number(b.dynamic) - Number(a.dynamic)).slice(0, 15);
  return (
    <section className="panel" style={{ marginTop: 13 }}>
      <div className="panel-heading"><div><div className="eyebrow">WEBSITE INTELLIGENCE · FROM THE REPOSITORY</div><h3>Stack and routes</h3></div></div>
      <div className="fact-grid">{facts.filter(([, value]) => value).map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      {routes.length > 0 && (
        <div className="table-wrap" style={{ margin: "12px 0 10px" }}>
          <table className="table">
            <thead><tr><th>Route</th><th>Renders</th><th>Content data</th><th>Title & meta</th><th>Notes</th></tr></thead>
            <tbody>{routes.map((route) => (
              <tr key={route.source + route.pathPattern}>
                <td><code>{route.pathPattern}</code><div className="small muted">{route.source}</div></td>
                <td><Badge tone={RENDERING_LABEL[route.rendering]?.tone}>{RENDERING_LABEL[route.rendering]?.label ?? route.rendering}</Badge></td>
                <td className="small">{route.clientDataFetching ? <span className="bad-count">In the browser</span> : route.rendering === "client" ? <span className="muted">—</span> : "In the HTML"}</td>
                <td className="small">{route.metadata === "server" ? "Per page" : route.metadata === "inherited" ? <span className="bad-count">Layout only</span> : route.metadata === "client" ? <span className="bad-count">Set by JavaScript</span> : <span className="bad-count">None</span>}</td>
                <td className="small">{[
                  route.sequentialAwaits >= 3 && `${route.sequentialAwaits} sequential requests`,
                  route.unboundedQueries.length > 0 && `unpaginated: ${route.unboundedQueries.map((query) => query.split(":")[0]).join(", ")}`,
                ].filter(Boolean).join(" · ") || <span className="muted">—</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, "") || "/";

/** Where search visibility comes from, what kind of searches bring clicks, and the demand closest to winning. */
function SearchIntelligence({ search }: { search: NonNullable<Report["search"]> }) {
  const share = (value: number) => `${Math.round(value * 100)}%`;
  const entity = search.entityQueries?.byType[0];
  return (
    <section className="panel" style={{ marginTop: 13 }}>
      <div className="panel-heading"><div><div className="eyebrow">SEARCH INTELLIGENCE · LAST 28 DAYS</div><h3>Who finds you, and through which searches</h3></div></div>
      <p className="plan-situation">{search.narrative}</p>
      <div className="metrics-grid">
        <Kpi label="Clicks" value={formatNumber(search.totals.clicks)} caption={`${formatNumber(search.totals.impressions)} impressions · ${(search.totals.ctr * 100).toFixed(1)}% CTR`} />
        <Kpi label="From target markets" value={search.targetShare ? share(search.targetShare.impressions) : "—"} caption={search.targetShare ? `of impressions · ${search.targetMarkets.map(countryName).join(", ")}` : "Set target markets above"} />
        <Kpi label="Commercial searches" value={share(search.commercialShare)} caption="of clicks (cost, price, best, booking…)" />
        <Kpi label={entity ? `Looking up a ${entity.entityType}` : "Branded searches"} value={share(entity ? search.entityQueries!.share : search.brandedShare)} caption={entity ? "of clicks name one specific record" : "of clicks include your brand"} />
      </div>
      {search.strikingDistance.length > 0 && (
        <>
          <div className="section-title">Closest to page-one clicks (positions 4–15)</div>
          <div className="table-wrap" style={{ marginBottom: 10 }}>
            <table className="table">
              <thead><tr><th>Query</th><th>Page</th><th className="num">Position</th><th className="num">Impressions</th><th className="num">Clicks</th></tr></thead>
              <tbody>{search.strikingDistance.slice(0, 8).map((entry) => (
                <tr key={entry.query + entry.page}><td>{entry.query}</td><td className="small"><a href={entry.page} target="_blank" rel="noreferrer">{path(entry.page)}</a></td><td className="num">{entry.position.toFixed(1)}</td><td className="num">{formatNumber(entry.impressions)}</td><td className="num">{formatNumber(entry.clicks)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
      {search.lowCtrPages.length > 0 && (
        <>
          <div className="section-title">On page one, but searchers skip them</div>
          <div className="table-wrap" style={{ marginBottom: 10 }}>
            <table className="table">
              <thead><tr><th>Page</th><th className="num">Position</th><th className="num">CTR</th><th className="num">Typical CTR</th><th>Top queries</th></tr></thead>
              <tbody>{search.lowCtrPages.slice(0, 5).map((page) => (
                <tr key={page.page}><td className="small"><a href={page.page} target="_blank" rel="noreferrer">{path(page.page)}</a></td><td className="num">{page.position.toFixed(1)}</td><td className="num"><span className="bad-count">{(page.ctr * 100).toFixed(1)}%</span></td><td className="num">{(page.expectedCtr * 100).toFixed(0)}%</td><td className="small">{page.queries.join(", ")}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
      {search.cannibalized.length > 0 && (
        <>
          <div className="section-title">Pages competing for the same search</div>
          <ul className="insights">{search.cannibalized.slice(0, 5).map((entry) => (
            <li key={entry.query}>“{entry.query}” ({formatNumber(entry.impressions)} impressions): {entry.pages.map((page) => `${path(page.page)} (#${page.position.toFixed(0)})`).join(" vs ")}</li>
          ))}</ul>
        </>
      )}
    </section>
  );
}

const PATH_LABELS: Record<string, string> = { whatsapp: "WhatsApp", phone: "Phone", email: "Email", form: "Enquiry form", booking: "Booking / quote" };

/** How each template turns a visitor into a lead, what measures it, and the events worth tracking. */
function ConversionPaths({ conversion, onNavigate }: { conversion: NonNullable<Report["conversion"]>; onNavigate: (view: "setup") => void }) {
  const label = (family: string) => (family === "home" ? "Homepage" : family === "page" ? "Top-level pages" : `/${family}/`);
  return (
    <section className="panel" style={{ marginTop: 13 }}>
      <div className="panel-heading">
        <div><div className="eyebrow">CONVERSION</div><h3>How each template turns visitors into leads</h3></div>
        <Button small variant="secondary" onClick={() => onNavigate("setup")}>Track conversions →</Button>
      </div>
      <div className="table-wrap" style={{ marginBottom: 10 }}>
        <table className="table">
          <thead><tr><th>Template</th><th>Ways to convert</th><th>Prices shown</th><th>Tracking</th></tr></thead>
          <tbody>{conversion.templates.map((template) => (
            <tr key={template.url}>
              <td><a href={template.url} target="_blank" rel="noreferrer"><code>{label(template.family)}</code></a></td>
              <td>{template.paths.length ? template.paths.map((path) => PATH_LABELS[path] ?? path).join(", ") : <span className="bad-count">None found</span>}</td>
              <td>{template.prices ? "Yes" : <span className="muted">No</span>}</td>
              <td className="small">{template.tracking.join(", ") || <span className="bad-count">None found</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="section-title">Events to track</div>
      <ul className="insights">{conversion.suggestedEvents.map((entry) => <li key={entry.event}><code>{entry.event}</code> — {entry.trigger}</li>)}</ul>
    </section>
  );
}
