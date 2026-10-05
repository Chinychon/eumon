"use client";

import { FormEvent, useEffect, useState } from "react";

type Site = { id: string; name: string; baseUrl: string; githubOwner?: string; githubRepo?: string };
type Repository = { id: number; name: string; fullName: string; owner: string; defaultBranch: string; isPrivate: boolean };

type Result = {
  analysisId: string;
  site: { name: string; baseUrl: string; fingerprint?: { framework: string; rendering?: string } };
  sitemap: { totalUrls: number; sampledUrls: number; errors: string[] };
  pages: Array<{ url: string; rawTextLength: number; renderedTextLength: number; renderDelta: number }>;
  findings: Array<{ id: string; category: string; severity: string; title: string; summary: string; recommendation?: string; organicImpactScore: number }>;
  competitors: Array<{ domain: string; category: string; relevanceScore: number; summary: string; technicalNotes?: string }>;
  opportunities: Array<{ title: string; rationale: string; priorityScore: number; potentialPage?: string }>;
  plan: { situation: string; constraints: string[]; competitiveAdvantage: string; highestImpactOpportunity: string; priorities: Array<{ rank: number; title: string; whyThisMatters: string; measurementMethod: string }> };
  searchNarrative: { totalClicks: number; totalImpressions: number; narrative: string };
};
type ProposedChange = { id: string; findingId: string; title: string; reason: string; patch: string; prUrl?: string };

const severityClass: Record<string, string> = {
  CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low", INFORMATIONAL: "info",
};

export default function Home() {
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [site, setSite] = useState<Site | null>(null);
  const [pendingAnalysisId, setPendingAnalysisId] = useState("");
  const [githubInstalled, setGithubInstalled] = useState(false);
  const [analysisMessage, setAnalysisMessage] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [gscProperties, setGscProperties] = useState<Array<{ siteUrl: string; permissionLevel: string }>>([]);
  const [selectedGscProperty, setSelectedGscProperty] = useState("");
  const [competitorInput, setCompetitorInput] = useState("");
  const [settingsMessage, setSettingsMessage] = useState("");
  const [conversionSummary, setConversionSummary] = useState<{ totalEvents: number; leads: number; last28Days: number } | null>(null);
  const [proposedChanges, setProposedChanges] = useState<ProposedChange[]>([]);
  const [changeBusy, setChangeBusy] = useState("");

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const installed = query.get("github") === "connected";
    setGithubInstalled(installed);
    fetch("/api/sites", { cache: "no-store" }).then((response) => response.json()).then(async (data) => {
      const sites = (data.sites as Site[] | undefined) ?? [];
      const current = sites.find((entry) => entry.id === query.get("site")) ?? sites[0];
      if (current) {
        setSite(current);
        setWebsiteUrl(current.baseUrl);
        const latestResponse = await fetch(`/api/sites/${current.id}/analyses`, { cache: "no-store" });
        const latest = await latestResponse.json();
        const analysis = latest.analysis;
        if (analysis?.status === "completed") {
          setResult(analysis.report as Result);
          const changes = await fetch(`/api/analyses/${analysis.analysisId}/changes`, { cache: "no-store" }).then((response) => response.json()).catch(() => ({ changes: [] }));
          setProposedChanges(changes.changes ?? []);
        }
        else if (analysis?.status === "queued" || analysis?.status === "running") setPendingAnalysisId(analysis.analysisId);
        const [competitors, properties] = await Promise.all([
          fetch(`/api/sites/${current.id}/competitors`, { cache: "no-store" }).then((res) => res.json()).catch(() => ({ domains: [] })),
          fetch(`/api/sites/${current.id}/gsc/properties`, { cache: "no-store" }).then((res) => res.json()).catch(() => ({ properties: [], selected: null })),
        ]);
        setCompetitorInput((competitors.domains as string[] ?? []).join("\n"));
        if (Array.isArray(properties.properties)) setGscProperties(properties.properties);
        if (typeof properties.selected === "string") setSelectedGscProperty(properties.selected);
        fetch(`/api/sites/${current.id}/events/summary`, { cache: "no-store" }).then((response) => response.json()).then(setConversionSummary).catch(() => undefined);
      }
    }).catch(() => undefined);
    if (installed) {
      fetch("/api/github/repositories", { cache: "no-store" }).then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Could not load repositories.");
        setRepositories(data.repositories as Repository[]);
        const first = data.repositories?.[0];
        if (first) setSelectedRepositoryId(String(first.id));
      }).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load repositories."));
      window.history.replaceState({}, "", window.location.pathname);
    }
    if (query.get("gsc")) setSettingsMessage(query.get("gsc") === "connected" ? "Google account connected. Select a Search Console property." : "Google Search Console connection needs attention; try connecting again.");
    if (query.get("gsc") === "connected" && query.get("site")) {
      fetch(`/api/sites/${encodeURIComponent(query.get("site")!)}/gsc/properties`, { cache: "no-store" }).then((res) => res.json()).then((data) => setGscProperties(data.properties ?? [])).catch(() => undefined);
      window.history.replaceState({}, "", `/?site=${encodeURIComponent(query.get("site")!)}`);
    }
  }, []);

  useEffect(() => {
    if (!pendingAnalysisId) return;
    let active = true;
    const poll = async () => {
      while (active) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        if (!active) return;
        try {
          const response = await fetch(`/api/analyses/${pendingAnalysisId}`, { cache: "no-store" });
          const job = await response.json();
          if (!response.ok) throw new Error(job.error ?? "Could not read analysis status.");
          setAnalysisMessage(job.progress?.message ?? `Analysis ${job.status}`);
          if (job.status === "completed") {
            setResult(job.report as Result);
            const changes = await fetch(`/api/analyses/${pendingAnalysisId}/changes`, { cache: "no-store" }).then((response) => response.json()).catch(() => ({ changes: [] }));
            setProposedChanges(changes.changes ?? []);
            setPendingAnalysisId("");
            setAnalysisMessage("");
            return;
          }
          if (job.status === "failed") throw new Error(job.error ?? "Analysis failed.");
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Analysis failed.");
          setPendingAnalysisId("");
          return;
        }
      }
    };
    void poll();
    return () => { active = false; };
  }, [pendingAnalysisId]);

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setResult(null);
    setLoading(true);
    setAnalysisMessage("Saving your connected site");
    try {
      let connectedSite = site;
      if (!connectedSite) {
        const response = await fetch("/api/sites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ websiteUrl, repositoryId: Number(selectedRepositoryId) }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Could not connect the site.");
        connectedSite = payload.site as Site;
        setSite(connectedSite);
      }
      const competitors = competitorInput.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
      const competitorSave = await fetch(`/api/sites/${connectedSite.id}/competitors`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domains: competitors }),
      });
      if (!competitorSave.ok) throw new Error((await competitorSave.json()).error ?? "Could not save competitor domains.");
      setAnalysisMessage("Queueing repository and site analysis");
      const start = await fetch(`/api/sites/${connectedSite.id}/analyses`, { method: "POST" });
      const queued = await start.json();
      if (!start.ok) throw new Error(queued.error ?? "Could not start analysis.");
      setPendingAnalysisId(queued.analysisId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Analysis failed.");
    } finally {
      setLoading(false);
      setAnalysisMessage("");
    }
  }

  async function generateChange(findingId: string) {
    if (!result) return;
    setChangeBusy(findingId); setError("");
    try {
      const response = await fetch(`/api/analyses/${result.analysisId}/changes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ findingId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not generate a proposal.");
      setProposedChanges((items) => [...items, data.change]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not generate a proposal."); }
    finally { setChangeBusy(""); }
  }

  async function openPullRequest(change: ProposedChange) {
    setChangeBusy(change.id); setError("");
    try {
      const response = await fetch(`/api/changes/${change.id}/pull-request`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not open the draft pull request.");
      setProposedChanges((items) => items.map((item) => item.id === change.id ? { ...item, prUrl: data.pullRequest.url } : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open the draft pull request."); }
    finally { setChangeBusy(""); }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#top"><span className="brand-mark">og</span><span>organic<span className="brand-light">growth</span></span></a>
        <div className="workspace-label">WORKSPACE</div>
        <button className="workspace active"><span className="workspace-dot" />Overview</button>
        <button className="workspace" onClick={() => document.getElementById("findings")?.scrollIntoView({ behavior: "smooth" })}>◉ <span>Site intelligence</span></button>
        <button className="workspace" onClick={() => document.getElementById("plan")?.scrollIntoView({ behavior: "smooth" })}>↗ <span>Growth plan</span></button>
        <div className="sidebar-bottom"><div className="avatar">OG</div><div><strong>Organic Growth</strong><small>Free workspace</small></div><span className="more">···</span></div>
      </aside>

      <section className="main-area" id="top">
        <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> Overview</div><div className="top-actions"><span className="status-indicator" /> <span>All systems operational</span><button className="help-button" aria-label="Help">?</button></div></header>
        <div className="content-wrap">
          <div className="welcome-row"><div><div className="eyebrow">ORGANIC GROWTH WORKSPACE</div><h1>Make organic traffic<br className="desktop-break" /> work harder.</h1><p className="intro">Understand what’s holding your website back, find valuable search opportunities, and turn evidence into a plan.</p></div><div className="welcome-art" aria-hidden="true"><div className="art-orbit orbit-one"/><div className="art-orbit orbit-two"/><div className="art-spark">✳</div><div className="art-dot"/></div></div>

          <form className="connect-card connect-card-stack" onSubmit={analyze}>
            <div className="connect-icon">↗</div>
            <div className="connect-copy"><strong>{site ? `${site.name} is connected` : "Connect your GitHub repository"}</strong><span>We’ll inspect your Next.js routes and public pages, then save an evidence-backed growth plan.</span></div>
            {!githubInstalled && !site ? <a className="github-connect-button" href="/api/github/install">Install GitHub App <span>↗</span></a> : <div className="connect-controls">
              {!site && <>
                <label className="sr-only" htmlFor="repository">GitHub repository</label><select id="repository" value={selectedRepositoryId} onChange={(event) => setSelectedRepositoryId(event.target.value)} required><option value="">Choose a repository</option>{repositories.map((repo) => <option key={repo.id} value={repo.id}>{repo.fullName}{repo.isPrivate ? " · private" : ""}</option>)}</select>
                <label className="sr-only" htmlFor="website-url">Website URL</label><input id="website-url" type="url" placeholder="https://yourwebsite.com" value={websiteUrl} onChange={(event) => setWebsiteUrl(event.target.value)} required />
              </>}
              <button disabled={loading || Boolean(pendingAnalysisId) || (!site && (!selectedRepositoryId || !websiteUrl))}>{loading || pendingAnalysisId ? <><span className="spinner"/>{analysisMessage || "Analyzing"}</> : <> {site ? "Run analysis" : "Connect site & analyze"} <span>→</span></>}</button>
            </div>}
            <div className="connect-footnote"><span>◈</span> Selected repository access <i/> Public pages only <i/> Analysis runs in the background</div>
            {site && <div className="connect-controls integrations">
              <a className="github-connect-button" href={`/api/sites/${site.id}/gsc/connect`}>{gscProperties.length || selectedGscProperty ? "Reconnect Google Search Console" : "Connect Google Search Console"} <span>↗</span></a>
              {gscProperties.length > 0 && <label className="sr-only" htmlFor="gsc-property">Search Console property</label>}
              {gscProperties.length > 0 && <select id="gsc-property" value={selectedGscProperty} onChange={async (event) => {
                setSelectedGscProperty(event.target.value);
                const response = await fetch(`/api/sites/${site.id}/gsc/properties`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ property: event.target.value }) });
                const data = await response.json(); setSettingsMessage(response.ok ? "Search Console property saved." : data.error);
              }}><option value="">Choose a Search Console property</option>{gscProperties.map((property) => <option key={property.siteUrl} value={property.siteUrl}>{property.siteUrl}</option>)}</select>}
              <label className="sr-only" htmlFor="competitors">Competitor domains</label>
              <textarea id="competitors" rows={2} placeholder="Competitor domains, one per line" value={competitorInput} onChange={(event) => setCompetitorInput(event.target.value)} />
              {conversionSummary && <small>Conversion events: {conversionSummary.totalEvents} total · {conversionSummary.last28Days} in 28 days · {conversionSummary.leads} lead-stage events</small>}
              {settingsMessage && <small>{settingsMessage}</small>}
            </div>}
          </form>
          {error && <div className="error-banner" role="alert">{error}</div>}

          {result ? <AnalysisDashboard result={result} changes={proposedChanges} busyId={changeBusy} onGenerate={generateChange} onOpenPR={openPullRequest} /> : <>
            <div className="section-heading"><div><div className="eyebrow">YOUR GROWTH LOOP</div><h2>From search signal to business outcome</h2></div><span className="muted-note">A connected, measurable workflow</span></div>
            <div className="steps-grid">
              {[{ n: "01", title: "Understand", copy: "Map your routes, content, rendering, and technical foundations.", icon: "⌕" }, { n: "02", title: "Find opportunity", copy: "Connect search intent, competitor gaps, and business value.", icon: "◌" }, { n: "03", title: "Take action", copy: "Turn the best opportunities into reviewable implementation work.", icon: "↗" }, { n: "04", title: "Learn", copy: "Measure what brings qualified visits, leads, and revenue.", icon: "⌁" }].map((step) => <div className="step-card" key={step.n}><div className="step-top"><span>{step.n}</span><b>{step.icon}</b></div><h3>{step.title}</h3><p>{step.copy}</p></div>)}
            </div>
            <div className="bottom-note"><span className="note-icon">✳</span><div><strong>Built for the way modern websites are made</strong><p>Code-aware analysis for Next.js, Astro, Nuxt, and TypeScript sites. Your code stays yours.</p></div><span className="note-arrow">↗</span></div>
          </>}
          <footer>Organic Growth Engine <span>•</span> Evidence-led growth for the open web</footer>
        </div>
      </section>
    </main>
  );
}

function AnalysisDashboard({ result, changes, busyId, onGenerate, onOpenPR }: { result: Result; changes: ProposedChange[]; busyId: string; onGenerate: (findingId: string) => void; onOpenPR: (change: ProposedChange) => void }) {
  const findings = [...result.findings].sort((a, b) => b.organicImpactScore - a.organicImpactScore);
  return <div className="results" aria-live="polite">
    <div className="result-heading"><div><div className="eyebrow">SITE ANALYSIS COMPLETE</div><h2>{result.site.name}</h2><a href={result.site.baseUrl} target="_blank" rel="noreferrer">{result.site.baseUrl} ↗</a></div><span className="live-tag"><i/> CRAWL COMPLETE</span></div>
    <div className="metrics-grid">
      <Metric label="URLs in sitemap" value={result.sitemap.totalUrls.toLocaleString()} caption={`${result.sitemap.sampledUrls} pages sampled`} />
      <Metric label="Browser rendered" value={`${result.pages.filter((page) => page.renderedTextLength > 0).length}/${Math.min(5, result.pages.length)}`} caption="Representative pages checked" />
      <Metric label="Key findings" value={String(findings.length).padStart(2, "0")} caption="Ranked by organic impact" />
      <Metric label="Competitor domains" value={String(result.competitors.length).padStart(2, "0")} caption="Owner-selected only" />
    </div>
    <div className="dashboard-columns">
      <section className="panel" id="findings"><div className="panel-heading"><div><div className="eyebrow">SITE INTELLIGENCE</div><h3>What we found</h3></div><span className="count-pill">{findings.length} findings</span></div>
        {findings.length ? findings.slice(0, 5).map((finding) => { const change = changes.find((item) => item.findingId === finding.id); return <article className="finding" key={finding.id}><span className={`severity ${severityClass[finding.severity] ?? "info"}`}>{finding.severity}</span><div><h4>{finding.title}</h4><p>{finding.summary}</p>{finding.recommendation && <small>Next step: {finding.recommendation}</small>}{["sitemap", "indexing"].includes(finding.category) && <button className="inline-action" disabled={Boolean(busyId)} onClick={() => onGenerate(finding.id)}>{busyId === finding.id ? "Preparing reviewable change…" : "Generate safe configuration fix"}</button>}{change && <div className="change-card"><strong>{change.title}</strong><p>{change.reason}</p><pre>{change.patch}</pre>{change.prUrl ? <a href={change.prUrl} target="_blank" rel="noreferrer">Open draft pull request ↗</a> : <button className="inline-action" disabled={Boolean(busyId)} onClick={() => onOpenPR(change)}>{busyId === change.id ? "Opening draft PR…" : "Create draft GitHub PR"}</button>}</div>}</div><span className="impact">{finding.organicImpactScore}<small>impact</small></span></article>; }) : <p className="empty-state">No high-impact technical issues surfaced in this sample. Connect Search Console to find demand and page opportunities.</p>}
      </section>
      <section className="panel" id="plan"><div className="panel-heading"><div><div className="eyebrow">WEBSITE-SPECIFIC STRATEGY</div><h3>Your growth plan</h3></div><span className="sparkle">✳</span></div><p className="plan-situation">{result.plan.situation}</p><div className="advantage"><span>YOUR ADVANTAGE</span><p>{result.plan.competitiveAdvantage}</p></div><div className="priority-label">HIGHEST-IMPACT OPPORTUNITY</div><p className="top-opportunity">{result.plan.highestImpactOpportunity}</p>
        <div className="priority-list">{result.plan.priorities.slice(0, 4).map((priority) => <div className="priority-row" key={priority.rank}><span className="priority-number">0{priority.rank}</span><div><strong>{priority.title}</strong><small>{priority.whyThisMatters}</small></div></div>)}</div>
      </section>
    </div>
    <div className="dashboard-columns lower-columns"><section className="panel"><div className="panel-heading"><div><div className="eyebrow">OPPORTUNITY ENGINE</div><h3>Where to focus</h3></div><span className="arrow-circle">↗</span></div>{result.opportunities.slice(0, 3).map((opportunity) => <div className="opportunity" key={opportunity.title}><div><strong>{opportunity.title}</strong><p>{opportunity.rationale}</p>{opportunity.potentialPage && <code>{opportunity.potentialPage}</code>}</div><span className="score">{Math.round(opportunity.priorityScore)}<small>priority</small></span></div>)}</section>
      <section className="panel"><div className="panel-heading"><div><div className="eyebrow">SEARCH LANDSCAPE</div><h3>Search & competitor evidence</h3></div></div>{result.searchNarrative.totalImpressions > 0 && <div className="search-evidence"><strong>{result.searchNarrative.totalClicks.toLocaleString()} clicks · {result.searchNarrative.totalImpressions.toLocaleString()} impressions</strong><p>{result.searchNarrative.narrative}</p></div>}{result.competitors.length ? result.competitors.slice(0, 4).map((competitor) => <div className="competitor" key={competitor.domain}><div className="domain-icon">{competitor.domain[0].toUpperCase()}</div><div><strong>{competitor.domain}</strong><small><span>{competitor.category}</span> · {competitor.summary}<br/>{competitor.technicalNotes}</small></div><span className="relevance">Owner<br/>selected</span></div>) : <p className="empty-state">Add competitor domains above to record basic homepage evidence. Search rankings and competitor traffic are not inferred.</p>}</section></div>
    {result.sitemap.errors.length > 0 && <div className="crawl-note"><strong>Sitemap note</strong><span>{result.sitemap.errors[0]}</span></div>}
  </div>;
}

function Metric({ label, value, caption }: { label: string; value: string; caption: string }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong><small>{caption}</small></div>;
}
