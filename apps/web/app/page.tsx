"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SiteRecord } from "@organic-growth/core";
import { runLabel, useSiteRun } from "./components/AnalysisProgress";
import { AskDrawer, AskView } from "./components/Ask";
import { ConnectionsView } from "./components/ConnectionsView";
import { api, errorMessage } from "./components/api";
import { DataView } from "./components/DataView";
import { OverviewView, type Repository } from "./components/OverviewView";
import { PagesView } from "./components/PagesView";
import { ResultsView } from "./components/ResultsView";
import { PerformanceView } from "./components/PerformanceView";
import { SetupView } from "./components/SetupView";
import { BrandMark } from "./components/pixel";
import { Button, LeafIcon, ThemeToggle } from "./components/ui";

type View = "overview" | "results" | "ask" | "connections" | "data" | "pages" | "performance" | "setup";

/**
 * `steps` are the pipeline steps (README) a view covers; `group` labels the run of views it starts.
 * View keys stay as they were when labels changed, so saved and shared links keep working.
 */
const NAV: Array<{ view: View; label: string; steps?: string; group?: string }> = [
  { view: "overview", label: "Overview" },
  { view: "results", label: "Performance" },
  { view: "ask", label: "Ask" },
  { view: "data", label: "Data", steps: "1–3", group: "Landing page engine" },
  { view: "pages", label: "Landing pages", steps: "4–5" },
  { view: "performance", label: "Page performance", steps: "6–7" },
  { view: "setup", label: "Setup" },
];

/** Connections now live at the top of Setup. */
const resolveView = (view: View): View => (view === "connections" ? "setup" : view);

function setQuery(params: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  window.history.replaceState({}, "", `${url.pathname}${url.search}`);
}

export default function Home() {
  const [sites, setSites] = useState<SiteRecord[] | null>(null);
  const [siteId, setSiteId] = useState("");
  const [view, setView] = useState<View>("overview");
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [githubInstalled, setGithubInstalled] = useState(false);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [askThread, setAskThread] = useState("");
  const [drawer, setDrawer] = useState(false);
  const askToggle = useRef<HTMLButtonElement>(null);
  // Closing the drawer hands focus back to the button that opened it.
  const closeDrawer = useCallback(() => { setDrawer(false); askToggle.current?.focus(); }, []);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const loadSites = useCallback(async (preferred?: string) => {
    const data = await api<{ sites: SiteRecord[] }>("/api/sites");
    setSites(data.sites);
    setSiteId((current) => {
      const wanted = preferred || current;
      return data.sites.find((site) => site.id === wanted)?.id ?? data.sites[0]?.id ?? "";
    });
  }, []);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const requestedView = query.get("view") as View | null;
    if (requestedView && NAV.some((item) => item.view === resolveView(requestedView))) setView(resolveView(requestedView));
    setAskThread(query.get("thread") ?? "");
    if (query.get("github") === "connected") setNotice("GitHub connected. Choose a repository in Setup.");
    if (query.get("github_error") === "installation_invalid") setError("GitHub returned without a valid install session. Start “Connect GitHub” from this tab and use the same address for the callback.");
    if (query.get("github_error") === "installation_failed") setError("GitHub installed the app, but Eumon couldn't save the connection. Check that SESSION_SECRET is at least 32 characters, then try again.");
    const gsc = query.get("gsc");
    if (gsc === "connected") setNotice("Google connected. Choose a Search Console property in Setup.");
    else if (gsc) setError("The Google Search Console connection needs attention — try connecting again.");
    setQuery({ github: null, github_error: null, gsc: null });

    loadSites(query.get("site") ?? undefined).catch((cause) => setError(errorMessage(cause)));
    api<{ repositories: Repository[] }>("/api/github/repositories")
      .then((data) => { setRepositories(data.repositories); setGithubInstalled(true); })
      .catch(() => undefined);
  }, [loadSites]);

  useEffect(() => { if (siteId) setQuery({ site: siteId, view, thread: view === "ask" ? askThread || null : null, ...(view === "overview" ? {} : { tab: null }) }); }, [siteId, view, askThread]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 6000); return () => clearTimeout(timer); }, [notice]);

  const site = sites?.find((entry) => entry.id === siteId) ?? null;
  const run = useSiteRun(siteId);
  const navigate = (next: View) => { setView(resolveView(next)); window.scrollTo({ top: 0 }); };
  const drawerOpen = drawer && Boolean(site) && view !== "ask" && !adding;
  // On phones the drawer covers the page, so the page behind it is taken out of reach.
  const covered = drawerOpen && narrow;

  return (
    <main className={`app-shell${drawerOpen ? " ask-open" : ""}`}>
      <aside className="sidebar" inert={covered}>
        <a className="brand" href="/"><BrandMark /><span>Eumon</span></a>
        <div className="workspace-label">{site ? new URL(site.baseUrl).hostname.toUpperCase() : "WORKSPACE"}</div>
        {NAV.map((item) => (
          <div key={item.view} className="workspace-item">
            {item.group && <div className="workspace-group">{item.group}</div>}
            <button className={`workspace${view === item.view && site && !adding ? " active" : ""}`} disabled={!site} onClick={() => { setAdding(false); navigate(item.view); }}>
              <span>{item.label}</span>{item.steps && <small>{item.steps}</small>}
            </button>
          </div>
        ))}
        <div className="site-switcher">
          {sites && sites.length > 0 && (
            <>
              <label htmlFor="site-select">WEBSITE</label>
              <select id="site-select" value={siteId} onChange={(event) => { setAdding(false); setAskThread(""); setSiteId(event.target.value); }}>
                {sites.map((entry) => <option key={entry.id} value={entry.id}>{new URL(entry.baseUrl).hostname}</option>)}
              </select>
            </>
          )}
          <button onClick={() => setAdding(true)}>Add website</button>
          <ThemeToggle />
        </div>
      </aside>

      <section className="main-area" id="top" inert={covered}>
        <header className="topbar">
          <div className="breadcrumb">{site ? <>{new URL(site.baseUrl).hostname} <span>/</span> {adding ? "Add website" : NAV.find((item) => item.view === view)?.label}</> : "Welcome"}</div>
          {run && (view !== "overview" || adding) && <button className="top-actions run-chip" onClick={() => { setAdding(false); navigate("overview"); }}>{runLabel(run)}</button>}
          {site && view !== "ask" && !adding && <button ref={askToggle} className="top-actions ask-toggle" aria-expanded={drawerOpen} onClick={() => setDrawer((value) => !value)}><LeafIcon />Ask Eumon</button>}
          {site && <a className="top-actions" href={site.baseUrl} target="_blank" rel="noreferrer">Open site</a>}
        </header>
        <div className="content-wrap">
          {error && <div className="callout error" role="alert" style={{ marginBottom: 14 }}>{error} <button className="btn btn-ghost btn-small" onClick={() => setError("")}>Dismiss</button></div>}
          {sites === null ? <div className="empty">Loading…</div> : adding || !site ? (
            <AddSite
              hasSites={Boolean(sites.length)}
              repositories={repositories}
              githubInstalled={githubInstalled}
              onCancel={sites.length ? () => setAdding(false) : undefined}
              onAdded={async (siteId) => { setAdding(false); await loadSites(siteId); setView("overview"); }}
            />
          ) : (
            <div key={`${site.id}:${view}`} className="view-enter">
              {view === "overview" && <OverviewView site={site} onNavigate={navigate} />}
              {view === "results" && <ResultsView endpoint={`/api/sites/${site.id}/results`} operator onNavigate={navigate} />}
              {view === "ask" && <AskView key={site.id} site={site} threadId={askThread} onThreadChange={setAskThread} />}
              {view === "data" && <DataView site={site} onNavigate={navigate} />}
              {view === "pages" && <PagesView site={site} onNavigate={navigate} />}
              {view === "performance" && <PerformanceView site={site} onNavigate={navigate} />}
              {view === "setup" && (
                <>
                  <ConnectionsView site={site} repositories={repositories} githubInstalled={githubInstalled} onSiteChanged={(updated) => setSites((items) => items?.map((item) => (item.id === updated.id ? updated : item)) ?? null)} />
                  <SetupView site={site} />
                </>
              )}
            </div>
          )}
          <footer>Eumon <span>•</span> Landing pages from real data, measured by real outcomes</footer>
        </div>
      </section>
      {site && (
        <AskDrawer
          site={site}
          view={NAV.find((item) => item.view === view)?.label ?? "Overview"}
          open={drawerOpen}
          modal={covered}
          onClose={closeDrawer}
          onOpenInAsk={(threadId) => { setAskThread(threadId); setDrawer(false); navigate("ask"); }}
        />
      )}
      {notice && <div className="flash" role="status">{notice}</div>}
    </main>
  );
}

function AddSite({ hasSites, repositories, githubInstalled, onAdded, onCancel }: {
  hasSites: boolean;
  repositories: Repository[];
  githubInstalled: boolean;
  onAdded: (siteId: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The demo site (fictional data, served from memory) is offered only on this machine.
  const [local, setLocal] = useState(false);
  useEffect(() => setLocal(["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)), []);

  async function loadDemo() {
    setBusy(true); setError("");
    try {
      const data = await api<{ siteId: string }>("/api/dev/demo-site", { method: "POST" });
      await onAdded(data.siteId);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const data = await api<{ site: SiteRecord }>("/api/sites", {
        method: "POST",
        json: { websiteUrl, ...(repositoryId ? { repositoryId: Number(repositoryId) } : {}) },
      });
      await onAdded(data.site.id);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }

  return (
    <>
      {!hasSites && (
        <div className="welcome-row">
          <h1>Turn what you sell into<br className="desktop-break" /> pages people search for.</h1>
          <p className="intro">Eumon scopes the specific things your customers look for, collects the facts, publishes a crawlable landing page for each one on your domain, and shows you which pages bring customers.</p>
        </div>
      )}
      <form className="card" onSubmit={add}>
        <div className="card-header"><div><h2>Add a website</h2><p>Works with any stack — Next.js, WordPress, Drupal, Webflow, custom. A GitHub repository is optional.</p></div></div>
        <div className="form-grid">
          <label className="field"><span>Website URL</span><input className="input" type="text" inputMode="url" required placeholder="https://yourwebsite.com" value={websiteUrl} onChange={(event) => setWebsiteUrl(event.target.value)} /></label>
          <label className="field">
            <span>GitHub repository (optional)</span>
            {githubInstalled ? (
              <select className="select" value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>
                <option value="">No repository</option>
                {repositories.map((repo) => <option key={repo.id} value={repo.id}>{repo.fullName}{repo.isPrivate ? " · private" : ""}</option>)}
              </select>
            ) : <a className="btn btn-secondary" href="/api/github/install">Connect GitHub</a>}
          </label>
        </div>
        {error && <div className="callout error" style={{ marginTop: 12 }}>{error}</div>}
        <div className="row" style={{ marginTop: 14 }}>
          <Button busy={busy} disabled={!websiteUrl.trim()} onClick={undefined} type="submit">Add website</Button>
          {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
          {local && <Button variant="ghost" disabled={busy} onClick={loadDemo}>Load demo site</Button>}
        </div>
      </form>
      {!hasSites && (
        <div className="steps-grid" style={{ marginTop: 18 }}>
          {[
            { n: "01", title: "Scope", copy: "Find the units people search for: doctors, procedures, malls, products, locations." },
            { n: "02", title: "Collect", copy: "Pull structured facts from your site, public directories, or a spreadsheet." },
            { n: "03", title: "Publish", copy: "One landing page per record — real HTML on your domain, with a clear CTA." },
            { n: "04", title: "Learn", copy: "See which pages earn impressions, clicks, and customers; improve the rest." },
          ].map((step) => <div className="step-card" key={step.n}><div className="step-top"><span>{step.n}</span></div><h3>{step.title}</h3><p>{step.copy}</p></div>)}
        </div>
      )}
    </>
  );
}
