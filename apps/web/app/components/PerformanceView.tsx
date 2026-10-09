"use client";

import { useCallback, useEffect, useState } from "react";
import type { CtaVariant, SiteRecord } from "@organic-growth/core";
import type { PerformanceReport, Suggestion } from "@organic-growth/pages";
import { api, errorMessage, formatNumber, percent } from "./api";
import { Badge, Button, Card, Field, Kpi, ViewHeader } from "./ui";

type WindowMetrics = { views: number; ctaClicks: number; searchClicks: number; searchImpressions: number };
type Revision = { id: string; pageId: string; path: string; field: string; before: string; after: string; reason: string; createdAt: string; windowDays: number; metricsBefore: WindowMetrics; metricsAfter: WindowMetrics };
type PerformanceData = { days: number; report: PerformanceReport; revisions: Revision[]; variants: CtaVariant[]; searchConnected: boolean; live: boolean; publicHost: string };
type SnippetOption = { title: string; description: string; rationale: string };

const KIND_LABEL: Record<Suggestion["kind"], string> = {
  rewrite_snippet: "Search snippet", target_queries: "Near-miss queries", not_crawled: "Crawling", no_visibility: "Visibility",
  weak_cta: "Conversion", expand_template: "Scale up", start_cta_test: "CTA test", cta_winner: "CTA test",
};

function delta(before: number, after: number): string {
  if (!before && !after) return "—";
  if (!before) return `+${formatNumber(after)}`;
  const change = (after - before) / before;
  return `${change >= 0 ? "+" : ""}${Math.round(change * 100)}%`;
}

export function PerformanceView({ site, onNavigate }: { site: SiteRecord; onNavigate: (view: "pages" | "connections") => void }) {
  const [days, setDays] = useState(28);
  const [data, setData] = useState<PerformanceData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api<PerformanceData>(`/api/sites/${site.id}/performance?days=${days}`));
    } catch (cause) { setError(errorMessage(cause)); }
  }, [site.id, days]);

  useEffect(() => { void load(); }, [load]);

  async function sync() {
    setBusy("sync"); setError(""); setMessage("");
    try {
      const result = await api<{ queries: number; pageDays: number; periodStart: string; periodEnd: string }>(`/api/sites/${site.id}/search-sync`, { method: "POST" });
      setMessage(`Imported ${formatNumber(result.queries)} query rows and ${formatNumber(result.pageDays)} page-days (${result.periodStart} → ${result.periodEnd}).`);
      await load();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  const report = data?.report;
  const totals = report?.totals;
  const ctr = totals && totals.impressions ? totals.clicks / totals.impressions : 0;

  return (
    <div>
      <ViewHeader
        title="What's working"
        description="Search Console, on-page analytics, and conversions for every generated page — plus the next changes most likely to pay off."
        actions={<>
          <select className="select" style={{ width: 130 }} value={days} onChange={(event) => setDays(Number(event.target.value))}>
            <option value={7}>Last 7 days</option><option value={28}>Last 28 days</option><option value={90}>Last 90 days</option>
          </select>
          {data?.searchConnected
            ? <Button variant="secondary" busy={busy === "sync"} onClick={sync}>Sync Search Console</Button>
            : <Button variant="secondary" onClick={() => onNavigate("connections")}>Connect Search Console</Button>}
        </>}
      />
      {error && <div className="callout error" role="alert" style={{ marginBottom: 14 }}>{error}</div>}
      {message && <div className="callout" style={{ marginBottom: 14 }}>{message}</div>}
      {!report || !totals ? <div className="empty">Loading…</div> : totals.pages === 0 ? (
        <div className="empty">No approved pages yet. <Button small variant="ghost" onClick={() => onNavigate("pages")}>Approve pages</Button></div>
      ) : (
        <div className="results">
          {!data?.live && (
            <div className="callout warn">
              These pages are approved but not live on {data?.publicHost} yet, so there is no real traffic to measure. Numbers start once the proxy rule in Setup is verified.
            </div>
          )}
          <div className="kpi-grid">
            <Kpi label={data?.live ? "Live pages" : "Approved pages"} value={formatNumber(totals.pages)} caption={data?.live ? `${formatNumber(report.templates.reduce((sum, template) => sum + template.pagesWithImpressions, 0))} seen in search` : "Not on your domain yet"} />
            <Kpi label="Search impressions" value={formatNumber(totals.impressions)} caption="Last synced 28 days" />
            <Kpi label="Search clicks" value={formatNumber(totals.clicks)} caption={`CTR ${percent(ctr)}`} />
            <Kpi label="Page views" value={formatNumber(totals.views)} caption={`${formatNumber(totals.googlebotHits)} Googlebot fetches`} />
            <Kpi label="CTA clicks" value={formatNumber(totals.ctaClicks)} caption={totals.views ? `${percent(totals.ctaClicks / totals.views)} of views` : "—"} />
            <Kpi label="Conversions" value={formatNumber(totals.conversions)} caption="From visitors who landed on a page" />
          </div>

          <Card title="What to do next" subtitle="Ranked by the size of the opportunity. Every suggestion shows the evidence behind it.">
            {report.suggestions.length === 0
              ? <div className="empty">No changes recommended yet. Suggestions appear as pages collect search impressions and visits{data?.searchConnected ? "" : " — connect Search Console to unlock most of them"}.</div>
              : report.suggestions.map((suggestion, index) => <SuggestionRow key={index} suggestion={suggestion} siteId={site.id} onApplied={load} />)}
          </Card>

          <div className="split">
            <Card title="By template" subtitle="Which kinds of page earn traffic and conversions.">
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Template</th><th className="num">Pages</th><th className="num">Impr.</th><th className="num">Clicks</th><th className="num">Views</th><th className="num">CTA rate</th><th className="num">Conv.</th></tr></thead>
                  <tbody>{report.templates.map((template) => (
                    <tr key={template.templateId}>
                      <td>{template.name}</td><td className="num">{formatNumber(template.pages)}</td><td className="num">{formatNumber(template.impressions)}</td>
                      <td className="num">{formatNumber(template.clicks)}</td><td className="num">{formatNumber(template.views)}</td>
                      <td className="num">{template.views ? percent(template.ctaRate) : "—"}</td><td className="num">{formatNumber(template.conversions)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </Card>
            <CtaTest siteId={site.id} variants={data?.variants ?? []} onChanged={load} />
          </div>

          <Card title="Best performing pages" subtitle="Scored by conversions, CTA clicks, search clicks, and visits.">
            {report.topPages.length === 0 ? <div className="empty">No traffic recorded yet.</div> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Page</th><th className="num">Position</th><th className="num">Impr.</th><th className="num">Clicks</th><th className="num">Views</th><th className="num">CTA</th><th className="num">Conv.</th></tr></thead>
                  <tbody>{report.topPages.map((page) => (
                    <tr key={page.pageId}>
                      <td><div style={{ fontWeight: 600 }}>{page.title}</div><a className="mono small" href={`/p/${site.id}${page.path}?preview=1`} target="_blank" rel="noreferrer">{page.path}</a></td>
                      <td className="num">{page.position == null ? "—" : page.position.toFixed(1)}</td><td className="num">{formatNumber(page.impressions)}</td>
                      <td className="num">{formatNumber(page.clicks)}</td><td className="num">{formatNumber(page.views)}</td>
                      <td className="num">{formatNumber(page.ctaClicks)}</td><td className="num">{formatNumber(page.conversions)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Changes and their effect" subtitle="Every edit is logged. Equal windows before and after each change show whether it helped.">
            {!data?.revisions.length ? <div className="empty">No page changes yet. Apply a suggestion above to start measuring.</div> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Change</th><th className="num">Window</th><th className="num">Search clicks</th><th className="num">Impressions</th><th className="num">Views</th><th className="num">CTA clicks</th></tr></thead>
                  <tbody>{data.revisions.map((revision) => (
                    <tr key={revision.id}>
                      <td>
                        <div className="mono small">{revision.path}</div>
                        <div className="small"><strong>{revision.field}</strong>: <span className="muted">{revision.before}</span> → {revision.after}</div>
                        <div className="small muted">{revision.reason} · {revision.createdAt.slice(0, 10)}</div>
                      </td>
                      <td className="num">{revision.windowDays ? `${revision.windowDays}d` : "too soon"}</td>
                      <td className="num">{delta(revision.metricsBefore.searchClicks, revision.metricsAfter.searchClicks)}</td>
                      <td className="num">{delta(revision.metricsBefore.searchImpressions, revision.metricsAfter.searchImpressions)}</td>
                      <td className="num">{delta(revision.metricsBefore.views, revision.metricsAfter.views)}</td>
                      <td className="num">{delta(revision.metricsBefore.ctaClicks, revision.metricsAfter.ctaClicks)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

function SuggestionRow({ suggestion, siteId, onApplied }: { suggestion: Suggestion; siteId: string; onApplied: () => Promise<void> }) {
  const [options, setOptions] = useState<SnippetOption[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const canRewrite = Boolean(suggestion.pageId) && (suggestion.kind === "rewrite_snippet" || suggestion.kind === "target_queries");

  async function suggest() {
    setBusy("suggest"); setError("");
    try {
      setOptions((await api<{ options: SnippetOption[] }>(`/api/pages/${suggestion.pageId}/snippets`, { method: "POST" })).options);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  async function apply(option: SnippetOption) {
    setBusy(option.title); setError("");
    try {
      await api(`/api/pages/${suggestion.pageId}`, { method: "PATCH", json: { title: option.title, description: option.description, reason: `${KIND_LABEL[suggestion.kind]}: ${option.rationale || suggestion.title}` } });
      setOptions(null);
      await onApplied();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  return (
    <div className="list-row">
      <Badge tone="gray">{KIND_LABEL[suggestion.kind]}</Badge>
      <div className="grow">
        <h4>{suggestion.title}</h4>
        <p>{suggestion.detail}</p>
        {suggestion.queries && suggestion.queries.length > 0 && <div className="row" style={{ marginTop: 6 }}>{suggestion.queries.map((query) => <span key={query} className="chip">{query}</span>)}</div>}
        {suggestion.examples && suggestion.examples.length > 0 && <div className="small mono muted" style={{ marginTop: 6 }}>{suggestion.examples.join("  ·  ")}</div>}
        {error && <p className="small" style={{ color: "var(--red)" }}>{error}</p>}
        {options && options.map((option) => (
          <div className="option" key={option.title}>
            <strong>{option.title}</strong>
            <p>{option.description}</p>
            <div className="row spread"><span className="small muted">{option.rationale}</span><Button small busy={busy === option.title} onClick={() => apply(option)}>Apply</Button></div>
          </div>
        ))}
      </div>
      {canRewrite && !options && <Button small variant="secondary" busy={busy === "suggest"} onClick={suggest}>Suggest titles</Button>}
    </div>
  );
}

function CtaTest({ siteId, variants, onChanged }: { siteId: string; variants: CtaVariant[]; onChanged: () => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [copy, setCopy] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function act(key: string, action: () => Promise<unknown>) {
    setBusy(key); setError("");
    try { await action(); await onChanged(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }
  return (
    <Card title="Call-to-action test" subtitle="Traffic shifts automatically toward the CTA that gets clicked more (Thompson sampling), so a test never needs a fixed end date.">
      {variants.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 12 }}>
          <table className="table">
            <thead><tr><th>CTA</th><th className="num">Views</th><th className="num">Clicks</th><th className="num">CTR</th><th /></tr></thead>
            <tbody>{variants.map((variant) => (
              <tr key={variant.id}>
                <td><strong>{variant.label}</strong><div className="small muted">{variant.copy}</div></td>
                <td className="num">{formatNumber(variant.impressions)}</td><td className="num">{formatNumber(variant.clicks)}</td>
                <td className="num">{variant.impressions ? percent(variant.clicks / variant.impressions) : "—"}</td>
                <td><Button small variant="ghost" busy={busy === variant.id} onClick={() => act(variant.id, () => api(`/api/sites/${siteId}/cta-variants/${variant.id}`, { method: "PATCH", json: { active: !variant.active } }))}>{variant.active ? "Pause" : "Resume"}</Button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div className="form-grid">
        <Field label="Button label"><input className="input" value={label} maxLength={60} placeholder="Get a free quote" onChange={(event) => setLabel(event.target.value)} /></Field>
        <Field label="Link (optional)" hint="Defaults to the CTA link in Setup."><input className="input" value={url} placeholder="https://wa.me/60123456789" onChange={(event) => setUrl(event.target.value)} /></Field>
        <Field label="Supporting line (optional)" wide><input className="input" value={copy} maxLength={200} placeholder="Reply within one working day." onChange={(event) => setCopy(event.target.value)} /></Field>
      </div>
      {error && <p className="small" style={{ color: "var(--red)" }}>{error}</p>}
      <div className="row" style={{ marginTop: 10 }}>
        <Button small busy={busy === "add"} disabled={!label.trim()} onClick={() => act("add", async () => {
          await api(`/api/sites/${siteId}/cta-variants`, { method: "POST", json: { label, copy, url } });
          setLabel(""); setCopy(""); setUrl("");
        })}>{variants.length ? "Add variant" : "Start test with this variant"}</Button>
      </div>
    </Card>
  );
}
