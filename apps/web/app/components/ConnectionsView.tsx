"use client";

import { useEffect, useState } from "react";
import { COUNTRIES, countryName, type SiteRecord } from "@organic-growth/core";
import { api, errorMessage } from "./api";
import type { Repository } from "./OverviewView";
import { Badge, Button, Card, CrossIcon, ViewHeader } from "./ui";

const domainsOf = (text: string) => text.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);

/** Everything Eumon reads from: the website, the code, Search Console, the markets you sell to, and your competitors. */
export function ConnectionsView({ site, repositories, githubInstalled, onSiteChanged }: {
  site: SiteRecord;
  repositories: Repository[];
  githubInstalled: boolean;
  onSiteChanged: (site: SiteRecord) => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [gscProperties, setGscProperties] = useState<Array<{ siteUrl: string }>>([]);
  const [gscSelected, setGscSelected] = useState(site.gscProperty ?? "");
  const [gscMessage, setGscMessage] = useState("");
  const [ga4, setGa4] = useState<{ properties: Array<{ property: string; name: string }>; selected: string | null; needsReconnect: boolean; connected: boolean } | null>(null);
  const [ga4Message, setGa4Message] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [savedCompetitors, setSavedCompetitors] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [markets, setMarkets] = useState<string[]>([]);

  useEffect(() => {
    api<{ domains: string[] }>(`/api/sites/${site.id}/competitors`).then((data) => { const text = data.domains.join("\n"); setCompetitors(text); setSavedCompetitors(text); }).catch(() => undefined);
    api<{ countries: string[] }>(`/api/sites/${site.id}/markets`).then((data) => setMarkets(data.countries)).catch(() => setMarkets([]));
    api<{ properties: Array<{ siteUrl: string }>; selected: string | null }>(`/api/sites/${site.id}/gsc/properties`)
      .then((data) => { setGscProperties(data.properties); if (data.selected) setGscSelected(data.selected); })
      .catch(() => setGscProperties([]));
    api<{ properties: Array<{ property: string; name: string }>; selected: string | null; needsReconnect: boolean; connected: boolean }>(`/api/sites/${site.id}/ga4/properties`)
      .then(setGa4).catch(() => setGa4(null));
  }, [site.id]);

  async function saveMarkets(next: string[]) {
    setMarkets(next);
    try {
      await api(`/api/sites/${site.id}/markets`, { method: "PUT", json: { countries: next } });
    } catch (cause) { setError(errorMessage(cause)); }
  }

  async function saveCompetitors() {
    setBusy("competitors"); setError("");
    try {
      const data = await api<{ domains: string[] }>(`/api/sites/${site.id}/competitors`, { method: "PUT", json: { domains: domainsOf(competitors) } });
      const text = data.domains.join("\n");
      setCompetitors(text); setSavedCompetitors(text);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  async function attachRepository() {
    setBusy("repo"); setError("");
    try {
      const data = await api<{ site: SiteRecord }>("/api/sites", { method: "POST", json: { websiteUrl: site.baseUrl, repositoryId: Number(repositoryId) } });
      onSiteChanged(data.site);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  async function chooseGa4(property: string) {
    try {
      await api(`/api/sites/${site.id}/ga4/properties`, { method: "POST", json: { property: property || null } });
      setGa4((current) => (current ? { ...current, selected: property || null } : current));
      setGa4Message(property ? "Google Analytics property saved. Results fills in on the next sync." : "Google Analytics disconnected.");
      onSiteChanged({ ...site, ga4Property: property || undefined });
    } catch (cause) { setGa4Message(errorMessage(cause)); }
  }

  async function chooseProperty(property: string) {
    setGscSelected(property);
    try {
      await api(`/api/sites/${site.id}/gsc/properties`, { method: "POST", json: { property } });
      setGscMessage("Search Console property saved.");
      onSiteChanged({ ...site, gscProperty: property });
    } catch (cause) { setGscMessage(errorMessage(cause)); }
  }

  const hasRepo = Boolean(site.githubRepo);
  const competitorsChanged = competitors.trim() !== savedCompetitors.trim();

  return (
    <div>
      <ViewHeader title="Connections" description="Each connection adds evidence to the analysis. Only the website is required." />
      {error && <div className="callout error" role="alert" style={{ marginBottom: 14 }}>{error}</div>}
      <Card>
        <div className="list-row">
          <Badge tone="green">Website</Badge>
          <div className="grow"><h3>{site.baseUrl}</h3><p>Crawled as Googlebot, including every sitemap URL.</p></div>
        </div>
        <div className="list-row">
          <Badge tone={hasRepo ? "green" : "gray"}>{hasRepo ? "GitHub" : "Optional"}</Badge>
          <div className="grow">
            <h3>{hasRepo ? `${site.githubOwner}/${site.githubRepo}` : "GitHub repository"}</h3>
            <p>{hasRepo ? "Code-level analysis and reviewable pull requests are enabled." : "Adds framework and route analysis and lets Eumon open fix PRs. Skip this for WordPress, Drupal, or other CMS sites."}</p>
            {!hasRepo && (githubInstalled && repositories.length ? (
              <div className="row" style={{ marginTop: 8 }}>
                <select className="select" style={{ maxWidth: 320 }} value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>
                  <option value="">Choose a repository</option>
                  {repositories.map((repo) => <option key={repo.id} value={repo.id}>{repo.fullName}{repo.isPrivate ? " · private" : ""}</option>)}
                </select>
                <Button small variant="secondary" disabled={!repositoryId} busy={busy === "repo"} onClick={attachRepository}>Connect</Button>
              </div>
            ) : <a className="btn btn-secondary btn-small" style={{ marginTop: 8 }} href="/api/github/install">Connect GitHub</a>)}
          </div>
        </div>
        <div className="list-row">
          <Badge tone={site.gscProperty ? "green" : "gray"}>{site.gscProperty ? "Search Console" : "Recommended"}</Badge>
          <div className="grow">
            <h3>{site.gscProperty ?? "Google Search Console"}</h3>
            <p>Queries, impressions, and rankings: the evidence behind page opportunities and the performance loop.</p>
            <div className="row" style={{ marginTop: 8 }}>
              <a className="btn btn-secondary btn-small" href={`/api/sites/${site.id}/gsc/connect`}>{gscProperties.length || site.gscProperty ? "Reconnect Google" : "Connect Google"}</a>
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
          <Badge tone={site.ga4Property ? "green" : "gray"}>{site.ga4Property ? "Analytics" : "Recommended"}</Badge>
          <div className="grow">
            <h3>{ga4?.properties.find((entry) => entry.property === site.ga4Property)?.name ?? site.ga4Property ?? "Google Analytics 4"}</h3>
            <p>Organic sessions and key events, with 16 months of history: the "before Eumon" baseline Results compares against.</p>
            <div className="row" style={{ marginTop: 8 }}>
              {!ga4?.connected || ga4.needsReconnect
                ? <a className="btn btn-secondary btn-small" href={`/api/sites/${site.id}/gsc/connect`}>{ga4?.needsReconnect ? "Reconnect Google to add Analytics" : "Connect Google"}</a>
                : (
                  <select className="select" style={{ maxWidth: 360 }} value={ga4.selected ?? ""} onChange={(event) => void chooseGa4(event.target.value)}>
                    <option value="">Choose a property</option>
                    {ga4.properties.map((entry) => <option key={entry.property} value={entry.property}>{entry.name}</option>)}
                  </select>
                )}
            </div>
            {ga4Message && <p className="small">{ga4Message}</p>}
          </div>
        </div>
        <div className="list-row">
          <Badge tone={markets.length ? "green" : "gray"}>{markets.length ? "Markets" : "Recommended"}</Badge>
          <div className="grow">
            <h3>Target markets</h3>
            <p>The countries you sell to. Search traffic is checked against them, so visibility in the wrong market shows up as a problem.</p>
            <div className="row" style={{ marginTop: 8 }}>
              {markets.map((code) => <span className="chip" key={code}>{countryName(code)} <button className="chip-remove" aria-label={`Remove ${countryName(code)}`} onClick={() => void saveMarkets(markets.filter((entry) => entry !== code))}><CrossIcon /></button></span>)}
              <select className="select" style={{ maxWidth: 220 }} value="" onChange={(event) => event.target.value && void saveMarkets([...markets, event.target.value])}>
                <option value="">Add a country…</option>
                {COUNTRIES.filter((country) => !markets.includes(country.code)).map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
              </select>
            </div>
          </div>
        </div>
        <div className="list-row">
          <Badge tone={savedCompetitors.trim() ? "green" : "gray"}>Competitors</Badge>
          <div className="grow">
            <h3>Competitor domains</h3>
            <p>One per line. The next analysis reads their sitemaps and a few pages per section.</p>
            <textarea className="textarea" style={{ marginTop: 8, minHeight: 72 }} placeholder={"competitor-one.com\ncompetitor-two.com"} value={competitors} onChange={(event) => setCompetitors(event.target.value)} />
            <div className="row" style={{ marginTop: 8 }}>
              <Button small variant="secondary" disabled={!competitorsChanged} busy={busy === "competitors"} onClick={saveCompetitors}>Save competitors</Button>
              {!competitorsChanged && savedCompetitors.trim() && <span className="small muted">Saved</span>}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
