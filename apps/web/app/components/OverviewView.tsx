"use client";

import { useCallback, useEffect, useState } from "react";
import type { SiteRecord } from "@organic-growth/core";
import { api, errorMessage, formatNumber } from "./api";
import { Badge, Button, Card, Kpi, usePolling, ViewHeader } from "./ui";

export type Repository = { id: number; name: string; fullName: string; owner: string; defaultBranch: string; isPrivate: boolean };

type Finding = { id: string; category: string; severity: string; title: string; summary: string; recommendation?: string; organicImpactScore: number };

type Report = {
  analysisId: string;
  site: { name: string; baseUrl: string; fingerprint?: { framework: string; rendering?: string; deployment?: string } };
  sitemap: { totalUrls: number; sampledUrls: number; errors: string[] };
  coverage?: { totalUrls: number; completedUrls: number; emptyShellUrls: number; httpErrorUrls: number } | null;
  pages: Array<{ url: string; renderedTextLength: number }>;
  findings: Finding[];
  competitors: Array<{ domain: string; category: string; summary: string; technicalNotes?: string }>;
  opportunities: Array<{ title: string; rationale: string; priorityScore: number; potentialPage?: string }>;
  plan: { situation: string; competitiveAdvantage: string; highestImpactOpportunity: string; priorities: Array<{ rank: number; title: string; whyThisMatters: string }> };
  searchNarrative: { totalClicks: number; totalImpressions: number; narrative: string };
};

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
            <Kpi label="Browser rendered" value={`${report.pages.filter((page) => page.renderedTextLength > 0).length}`} caption="Pages compared with raw HTML" />
          </div>
          <div className="dashboard-columns">
            <section className="panel" id="findings">
              <div className="panel-heading"><div><div className="eyebrow">WHAT WE FOUND</div><h3>Technical findings</h3></div><span className="count-pill">{findings.length} findings</span></div>
              {findings.length ? findings.slice(0, 8).map((finding) => {
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
              {report.searchNarrative.totalImpressions > 0 && <div className="search-evidence"><strong>{formatNumber(report.searchNarrative.totalClicks)} clicks · {formatNumber(report.searchNarrative.totalImpressions)} impressions</strong><p>{report.searchNarrative.narrative}</p></div>}
              {report.competitors.length ? report.competitors.slice(0, 4).map((competitor) => (
                <div className="competitor" key={competitor.domain}><div className="domain-icon">{competitor.domain[0]?.toUpperCase()}</div><div><strong>{competitor.domain}</strong><small><span>{competitor.category}</span> · {competitor.summary}<br />{competitor.technicalNotes}</small></div><span className="relevance">Owner<br />selected</span></div>
              )) : <p className="empty-state">Add competitor domains above to record homepage evidence. Rankings and competitor traffic are not inferred.</p>}
            </section>
          </div>
          {report.sitemap.errors.length > 0 && <div className="crawl-note"><strong>Sitemap note</strong><span>{report.sitemap.errors.join(" ")}</span></div>}
        </div>
      )}
      {!report && !pendingId && !error && (
        <div className="empty" style={{ marginTop: 16 }}>Run an analysis to see what Google receives from this site — every sitemap URL is fetched as Googlebot.</div>
      )}
    </div>
  );
}
