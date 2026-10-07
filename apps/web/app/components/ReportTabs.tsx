"use client";

import type { ReactNode } from "react";
import { countryName, type SiteRecord } from "@organic-growth/core";
import { formatNumber } from "./api";
import { BarList, Funnel, Heatmap, PairedBars, Scatter } from "./charts";
import { CrawlGarden } from "./pixel";
import { familyLabel, findingTab, gapsFirst, HEALTH_COLUMNS, opportunityTab, pageTypeHealth, type Finding, type Report } from "./report-model";
import { Badge, Button, Card, Kpi } from "./ui";

/*
 * The full report, one tab per area. Each tab leads with a chart; every
 * finding, opportunity, and insight is one line, with the explanation behind
 * "Why" so the page reads at a glance.
 */

export type Change = { id: string; findingId?: string; title: string; reason: string; patch: string; prUrl?: string };
export type Leads = { pages: number; views: number; ctaClicks: number; conversions: number; events28: number } | null;
type Navigate = (view: "connections" | "data" | "setup") => void;

const SEVERITY_CLASS: Record<string, string> = { CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low", INFORMATIONAL: "info" };
const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, "") || "/";
const share = (value: number) => `${Math.round(value * 100)}%`;

/** One line that opens in place to say why it matters and what to do. */
export function WhyRow({ lead, title, aside, children }: { lead?: ReactNode; title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <details className="why-row">
      <summary>
        {lead}
        <span className="why-title">{title}</span>
        {aside && <span className="why-aside">{aside}</span>}
        <span className="why-open" aria-hidden="true">Why</span>
      </summary>
      <div className="why-body">{children}</div>
    </details>
  );
}

export const Severity = ({ value }: { value: string }) => <span className={`severity ${SEVERITY_CLASS[value] ?? "info"}`}>{value}</span>;

/** The site as Google receives it, where it breaks, and the fixes, most impact first. */
export function TechnicalTab({ report, changes, busy, hasRepo, onGenerateChange, onOpenPullRequest, onRecrawl }: {
  report: Report;
  changes: Change[];
  busy: string;
  hasRepo: boolean;
  onGenerateChange: (findingId: string) => void;
  onOpenPullRequest: (change: Change) => void;
  onRecrawl: () => void;
}) {
  const families = report.coverage?.families ?? [];
  const findings = report.findings.filter((finding) => findingTab(finding.category) === "technical").sort((a, b) => b.organicImpactScore - a.organicImpactScore);
  const comparisons = report.rendering?.comparisons ?? [];
  const flaky = (report.rendering?.repeatability ?? []).filter((entry) => entry.failed);
  return (
    <div className="results">
      <div className="ruled-grid c11">
        <Card title="Every sitemap URL" subtitle={`${formatNumber(report.coverage?.totalUrls ?? report.sitemap.totalUrls)} URLs, one square each, as Googlebot received them.`}>
          {families.length ? (
            <CrawlGarden
              label="Every sitemap URL by page type"
              families={families.map((family) => ({ family: family.family, total: family.urls, done: family.urls, blocked: Math.max(0, family.urls - family.crawled - family.errors), emptyShells: family.emptyShells, errors: family.errors }))}
            />
          ) : <p className="empty-state">Run a full analysis to see every URL.</p>}
        </Card>
        <Card title="Text Google gets, before and after JavaScript" subtitle="One page per template. A short first bar means Google sees little until scripts run.">
          {comparisons.length
            ? <PairedBars series={["In the HTML", "After JavaScript"]} groups={comparisons.map((entry) => ({ label: familyLabel(entry.family), values: [entry.rawTextLength, entry.renderedTextLength] }))} />
            : <p className="empty-state">No pages were rendered in a browser in this analysis.</p>}
          {flaky.length > 0 && <p className="small muted" style={{ marginBottom: 0 }}>Repeated fetches failed on {flaky.map((entry) => `${familyLabel(entry.family)} (${entry.failed} of ${entry.attempts})`).join(", ")}.</p>}
        </Card>
      </div>
      {families.length > 0 && (
        <Card title="Where pages break, by page type" subtitle="Darker means a larger share of that page type has the problem.">
          <Heatmap caption="Problems per page type" columns={HEALTH_COLUMNS.map((column) => column.label)} rows={pageTypeHealth(families).map((row) => ({ ...row, note: `${formatNumber(row.urls)} ${row.urls === 1 ? "URL" : "URLs"}` }))} />
        </Card>
      )}
      <Card title="Fixes" actions={<span className="count-pill">{findings.length} findings</span>}>
        {findings.length ? findings.map((finding) => (
          <FindingRow key={finding.id} finding={finding} change={changes.find((item) => item.findingId === finding.id)} busy={busy}
            fixable={hasRepo && ["sitemap", "indexing"].includes(finding.category)} onGenerateChange={onGenerateChange} onOpenPullRequest={onOpenPullRequest} />
        )) : <p className="empty-state">No technical issues surfaced in this analysis.</p>}
      </Card>
      {report.repo && <CodeIntelligence repo={report.repo} />}
      {report.crawlReuse && (
        <div className="callout run-reuse">
          <span>{formatNumber(report.crawlReuse.urls)} pages were reused from {report.crawlReuse.from ? `the analysis on ${new Date(report.crawlReuse.from).toLocaleDateString("en", { day: "numeric", month: "short" })}` : "the last analysis"}: unchanged since then, so they were not fetched again.</span>
          <Button small variant="ghost" disabled={busy === "analysis"} onClick={onRecrawl}>Re-crawl every page</Button>
        </div>
      )}
      {report.sitemap.errors.length > 0 && <div className="crawl-note"><strong>Sitemap note</strong><span>{report.sitemap.errors.join(" ")}</span></div>}
    </div>
  );
}

function FindingRow({ finding, change, busy, fixable, onGenerateChange, onOpenPullRequest }: {
  finding: Finding; change?: Change; busy: string; fixable: boolean;
  onGenerateChange: (findingId: string) => void; onOpenPullRequest: (change: Change) => void;
}) {
  return (
    <WhyRow lead={<Severity value={finding.severity} />} title={finding.title} aside={<span className="impact">{finding.organicImpactScore}<small>impact</small></span>}>
      <p>{finding.summary}</p>
      {finding.recommendation && <p><strong>Next step.</strong> {finding.recommendation}</p>}
      {fixable && !change && <button className="inline-action" disabled={Boolean(busy)} onClick={() => onGenerateChange(finding.id)}>{busy === finding.id ? "Preparing reviewable change…" : "Generate safe configuration fix"}</button>}
      {change && (
        <div className="change-card">
          <strong>{change.title}</strong>
          <p>{change.reason}</p>
          <pre>{change.patch}</pre>
          {change.prUrl ? <a href={change.prUrl} target="_blank" rel="noreferrer">Open draft pull request</a> : <button className="inline-action" disabled={Boolean(busy)} onClick={() => onOpenPullRequest(change)}>{busy === change.id ? "Opening draft PR…" : "Create draft GitHub PR"}</button>}
        </div>
      )}
    </WhyRow>
  );
}

/** Points for the position × impressions plot: queries near page one stand out from the rest. */
export function searchPoints(search: NonNullable<Report["search"]>) {
  return [
    ...search.strikingDistance.map((entry) => ({ label: entry.query, x: entry.position, y: entry.impressions, detail: path(entry.page), highlight: true })),
    ...search.lowCtrPages.map((entry) => ({ label: path(entry.page), x: entry.position, y: entry.impressions, detail: `CTR ${(entry.ctr * 100).toFixed(1)}%, typical ${(entry.expectedCtr * 100).toFixed(0)}%` })),
  ];
}

export function SearchTab({ report, onNavigate }: { report: Report; onNavigate: Navigate }) {
  const search = report.search;
  if (!search) {
    return (
      <Card title="No search data yet" subtitle="Connect Search Console to see which searches find this site, the queries closest to page one, and pages searchers skip.">
        <Button onClick={() => onNavigate("connections")}>Connect Search Console</Button>
      </Card>
    );
  }
  const entity = search.entityQueries?.byType[0];
  const opportunities = report.opportunities.filter((entry) => opportunityTab(entry.intent) === "search").sort((a, b) => b.priorityScore - a.priorityScore);
  // The page-level rows below say what the search findings say, page by page; the findings show only without them.
  const findings = search.lowCtrPages.length || search.cannibalized.length ? [] : report.findings.filter((finding) => finding.category === "search");
  return (
    <div className="results">
      <div className="metrics-grid">
        <Kpi label="Clicks" value={formatNumber(search.totals.clicks)} caption={`${formatNumber(search.totals.impressions)} impressions · ${(search.totals.ctr * 100).toFixed(1)}% CTR`} />
        <Kpi label="From target markets" value={search.targetShare ? share(search.targetShare.impressions) : "—"} caption={search.targetShare ? search.targetMarkets.map(countryName).join(", ") : "Set markets in Connections"} />
        <Kpi label="Commercial searches" value={share(search.commercialShare)} caption="of clicks: cost, price, best, booking…" />
        <Kpi label={entity ? `Looking up a ${entity.entityType}` : "Branded searches"} value={share(entity ? search.entityQueries!.share : search.brandedShare)} caption={entity ? "of clicks name one record" : "of clicks include your brand"} />
      </div>
      <div className="ruled-grid c21">
        <Card title="Position vs impressions" subtitle="Green: queries at positions 4–15, the closest to page-one clicks. Grey: pages on page one that searchers skip.">
          <Scatter points={searchPoints(search)} band={[4, 15]} xLabel="Position" yLabel="impressions" />
        </Card>
        <Card title="Where searchers are" subtitle="Share of impressions by country.">
          <BarList rows={search.countries.slice(0, 6).map((country) => ({ label: country.name, value: Math.round(country.impressionShare * 100) }))} />
        </Card>
      </div>
      <Card title="Queries to push" actions={<span className="count-pill">{opportunities.length}</span>}>
        {opportunities.length ? opportunities.slice(0, 5).map((entry) => (
          <WhyRow key={entry.title} title={entry.title} aside={<span className="score">{Math.round(entry.priorityScore)}<small>priority</small></span>}>
            <p>{entry.rationale}</p>
            {entry.potentialPage && <p><code>{entry.potentialPage}</code></p>}
          </WhyRow>
        )) : <p className="empty-state">No queries are close enough to page one to push yet.</p>}
      </Card>
      <Card title="Pages to fix">
        {findings.map((finding) => (
          <WhyRow key={finding.id} lead={<Severity value={finding.severity} />} title={finding.title}>
            <p>{finding.summary}</p>
            {finding.recommendation && <p><strong>Next step.</strong> {finding.recommendation}</p>}
          </WhyRow>
        ))}
        {search.lowCtrPages.slice(0, 5).map((page) => (
          <WhyRow key={page.page} title={<>Skipped on page one: <a href={page.page} target="_blank" rel="noreferrer">{path(page.page)}</a></>} aside={<span className="bad-count">{(page.ctr * 100).toFixed(1)}% CTR</span>}>
            <p>Position {page.position.toFixed(1)} usually earns about {(page.expectedCtr * 100).toFixed(0)}% of clicks. Rewrite the title and description around: {page.queries.join(", ")}.</p>
          </WhyRow>
        ))}
        {search.cannibalized.slice(0, 5).map((entry) => (
          <WhyRow key={entry.query} title={<>Competing pages for “{entry.query}”</>} aside={<span className="small muted">{entry.pages.length} pages</span>}>
            <p>{formatNumber(entry.impressions)} impressions split between {entry.pages.map((page) => `${path(page.page)} (#${page.position.toFixed(0)})`).join(" and ")}. Pick one page to rank; merge or redirect the other, or link it to the main one.</p>
          </WhyRow>
        ))}
        {!findings.length && !search.lowCtrPages.length && !search.cannibalized.length && <p className="empty-state">No search problems found on existing pages.</p>}
      </Card>
    </div>
  );
}

const GAP_STATUS: Record<string, { label: string; tone: string }> = {
  gap: { label: "Gap", tone: "red" },
  advantage: { label: "You lead", tone: "green" },
  yours_only: { label: "Only you", tone: "green" },
  shared: { label: "Comparable", tone: "gray" },
};

export function CompetitorsTab({ report, site, onNavigate }: { report: Report; site: SiteRecord; onNavigate: Navigate }) {
  const competition = report.competition;
  if (!competition?.rows.length) {
    return (
      <Card title="No competitors compared yet" subtitle="Add competitor domains. The next analysis reads their sitemaps and a few pages per section to show which kinds of pages they publish that you don't.">
        <Button onClick={() => onNavigate("connections")}>Add competitors</Button>
      </Card>
    );
  }
  const domains = competition.competitors.filter((competitor) => competitor.analyzed).slice(0, 3);
  const you = new URL(site.baseUrl).hostname.replace(/^www\./, "");
  const rows = gapsFirst(competition);
  const pages = (entry?: { pages: number; urls?: number; languages?: number }) => (entry?.pages
    ? <>{`~${formatNumber(entry.pages)}`}{(entry.languages ?? 1) > 1 && <small className="cell-note">{entry.languages} languages · {formatNumber(entry.urls ?? entry.pages)} URLs</small>}</>
    : "—");
  return (
    <div className="results">
      <Card
        title="Pages per section: you vs each competitor"
        subtitle="Sections where a competitor is furthest ahead come first. Counts show where they invest, not search demand."
        actions={competition.rows.some((row) => row.status === "gap") && <Button small variant="secondary" onClick={() => onNavigate("data")}>Close a gap in Data</Button>}
      >
        <PairedBars series={[you, ...domains.map((competitor) => competitor.domain)]} groups={rows.slice(0, 10).map((row) => ({
          label: row.label,
          values: [row.you.pages, ...domains.map((competitor) => row.competitors.find((entry) => entry.domain === competitor.domain)?.pages ?? 0)],
        }))} />
      </Card>
      <div className="ruled-grid c11">
        <Card title="Your advantage"><p className="advantage-line">{report.plan.competitiveAdvantage}</p></Card>
        <Card title="Competitors">
          {report.competitors.slice(0, 5).map((competitor) => (
            <WhyRow key={competitor.domain} lead={<span className="domain-icon">{competitor.domain[0]?.toUpperCase()}</span>} title={competitor.domain}
              aside={<span className="relevance">{competitor.relevanceScore !== undefined ? `${Math.round(competitor.relevanceScore * 100)}% overlap` : "Owner selected"}</span>}>
              <p>{competitor.summary}</p>
              {competitor.architectureNotes && <p>{competitor.architectureNotes}</p>}
              {competitor.conversionNotes && <p>{competitor.conversionNotes}</p>}
            </WhyRow>
          ))}
        </Card>
      </div>
      <Card title="What stands out">
        {competition.insights.slice(0, 6).map((insight) => <p key={insight} className="line-item">{insight}</p>)}
        <details className="why-row table-toggle">
          <summary><span className="why-title">Every section as a table</span><span className="why-open" aria-hidden="true">Show</span></summary>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Content type</th><th className="num">You</th>{domains.map((competitor) => <th className="num" key={competitor.domain}>{competitor.domain}</th>)}<th>Status</th><th>Your data</th></tr></thead>
              <tbody>{rows.map((row) => (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  <td className="num">{pages(row.you)}</td>
                  {domains.map((competitor) => {
                    const entry = row.competitors.find((item) => item.domain === competitor.domain);
                    return <td className="num" key={competitor.domain}>{entry?.examples[0] ? <a href={entry.examples[0]} target="_blank" rel="noreferrer">{pages(entry)}</a> : pages(entry)}</td>;
                  })}
                  <td><Badge tone={GAP_STATUS[row.status]?.tone}>{GAP_STATUS[row.status]?.label ?? row.status}</Badge></td>
                  <td className="small">{row.data ? `${row.data.dataset}: ${formatNumber(row.data.records)} records, ${formatNumber(row.data.livePages)} live` : <span className="muted">—</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      </Card>
    </div>
  );
}

const PATH_LABELS: Record<string, string> = { whatsapp: "WhatsApp", phone: "Phone", email: "Email", form: "Enquiry form", booking: "Booking / quote" };

/** Visit → CTA → lead from the landing pages, then how each template asks for the enquiry. */
export function LeadFunnel({ leads, onNavigate }: { leads: Leads; onNavigate: Navigate }) {
  if (!leads) return <p className="empty-state">Loading…</p>;
  if (!leads.pages) {
    return (
      <>
        <p className="empty-state">{leads.events28 ? `${formatNumber(leads.events28)} conversion events in the last 28 days. Publish landing pages to see which ones bring them.` : "No conversions recorded yet. Install tracking to count WhatsApp taps, calls, and forms."}</p>
        {!leads.events28 && <Button small variant="secondary" onClick={() => onNavigate("setup")}>Install tracking</Button>}
      </>
    );
  }
  return <Funnel steps={[{ label: "Page views", value: leads.views }, { label: "CTA clicks", value: leads.ctaClicks }, { label: "Leads", value: leads.conversions }]} />;
}

export function LeadsTab({ report, leads, onNavigate }: { report: Report; leads: Leads; onNavigate: Navigate }) {
  const conversion = report.conversion;
  const label = (family: string) => familyLabel(family);
  return (
    <div className="results">
      <div className="ruled-grid c11">
        <Card title="Visit to lead, last 28 days" subtitle="From Eumon's landing pages: views, taps on the call to action, then enquiries.">
          <LeadFunnel leads={leads} onNavigate={onNavigate} />
        </Card>
        <Card title="Conversion events" subtitle="Everything tracked on the site in the last 28 days.">
          <div className="big-number">{leads ? formatNumber(leads.events28) : "—"}</div>
          <Button small variant="secondary" onClick={() => onNavigate("setup")}>Tracking setup</Button>
        </Card>
      </div>
      {conversion && conversion.templates.length > 0 && (
        <Card title="How each template asks for the enquiry">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Template</th><th>Ways to convert</th><th>Prices shown</th><th>Tracking</th></tr></thead>
              <tbody>{conversion.templates.map((template) => (
                <tr key={template.url}>
                  <td><a href={template.url} target="_blank" rel="noreferrer"><code>{label(template.family)}</code></a></td>
                  <td>{template.paths.length ? template.paths.map((entry) => PATH_LABELS[entry] ?? entry).join(", ") : <span className="bad-count">None found</span>}</td>
                  <td>{template.prices ? "Yes" : <span className="muted">No</span>}</td>
                  <td className="small">{template.tracking.join(", ") || <span className="bad-count">None found</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <details className="why-row table-toggle">
            <summary><span className="why-title">Events worth tracking</span><span className="why-open" aria-hidden="true">Show</span></summary>
            <div className="why-body">{conversion.suggestedEvents.map((entry) => <p key={entry.event}><code>{entry.event}</code>: {entry.trigger}</p>)}</div>
          </details>
        </Card>
      )}
      {report.findings.filter((finding) => finding.category === "conversion").map((finding) => (
        <Card key={finding.id}>
          <WhyRow lead={<Severity value={finding.severity} />} title={finding.title}>
            <p>{finding.summary}</p>
            {finding.recommendation && <p><strong>Next step.</strong> {finding.recommendation}</p>}
          </WhyRow>
        </Card>
      ))}
    </div>
  );
}

const RENDERING_LABEL: Record<string, { label: string; tone: string }> = {
  static: { label: "Static", tone: "green" },
  isr: { label: "Static + revalidate", tone: "green" },
  ssr: { label: "Server per request", tone: "gray" },
  on_demand: { label: "On demand", tone: "gray" },
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
    <Card title="Stack and routes, from the repository">
      <div className="fact-grid">{facts.filter(([, value]) => value).map(([name, value]) => <div key={name}><span>{name}</span><strong>{value}</strong></div>)}</div>
      {routes.length > 0 && (
        <details className="why-row table-toggle">
          <summary><span className="why-title">{routes.length} routes and how they render</span><span className="why-open" aria-hidden="true">Show</span></summary>
          <div className="table-wrap">
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
        </details>
      )}
    </Card>
  );
}
