"use client";

import { useEffect, useState } from "react";
import type { PageSettings, SiteRecord } from "@organic-growth/core";
import { PAGE_LANGUAGES } from "@organic-growth/pages/labels";
import { api, errorMessage } from "./api";
import { WhyRow } from "./ReportTabs";
import { Badge, Button, Card, CheckIcon, CopyBlock, CrossIcon, Field, PartHead } from "./ui";

type Snippet = { id: string; label: string; when: string; language: string; code: string };
type Integration = {
  settings: PageSettings; target: string; hubUrl: string; sitemapUrl: string; snippets: Snippet[];
  framework: string | null; deployment: string | null; trackingSnippet: string;
  hosting: { provider: string | null; cms: string | null; server: string | null };
};
type Check = { name: string; ok: boolean; detail: string };

/** Suggests the proxy option that fits what we know about the site's stack. */
function recommendedSnippet(integration: Integration): string {
  const detected = integration.hosting.provider;
  if (detected && integration.snippets.some((snippet) => snippet.id === detected)) return detected;
  const deployment = (integration.deployment ?? "").toLowerCase();
  const framework = (integration.framework ?? "").toLowerCase();
  if (deployment.includes("vercel")) return "vercel";
  if (deployment.includes("netlify")) return "netlify";
  if (deployment.includes("cloudflare")) return "cloudflare";
  if (framework.includes("next")) return "nextjs";
  return "cloudflare";
}

export function SetupView({ site }: { site: SiteRecord }) {
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [form, setForm] = useState<PageSettings | null>(null);
  const [tab, setTab] = useState("cloudflare");
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const data = await api<Integration>(`/api/sites/${site.id}/integration`);
      setIntegration(data);
      setForm(data.settings);
      setTab((current) => (data.snippets.some((snippet) => snippet.id === current) && current !== "cloudflare" ? current : recommendedSnippet(data)));
    } catch (cause) { setError(errorMessage(cause)); }
  }

  useEffect(() => { setChecks(null); void load(); }, [site.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!form) return;
    setBusy("save"); setError(""); setMessage("");
    try {
      await api(`/api/sites/${site.id}/settings`, { method: "PUT", json: form });
      setMessage("Settings saved. Live pages pick up the change within five minutes (CDN cache).");
      await load();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  async function check() {
    setBusy("check"); setError("");
    try {
      const result = await api<{ checks: Check[]; ok: boolean }>(`/api/sites/${site.id}/integration`, { method: "POST" });
      setChecks(result.checks);
      setMessage(result.ok ? "Verified: approved pages are now live on your domain." : "");
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  const set = <K extends keyof PageSettings>(key: K, value: PageSettings[K]) => setForm((current) => (current ? { ...current, [key]: value } : current));
  const snippet = integration?.snippets.find((entry) => entry.id === tab);

  return (
    <div>
      <PartHead
        id="on-your-site"
        title="On your site"
        description="Eumon renders every landing page as complete HTML. A small proxy rule on your domain forwards one path to Eumon, so Google sees real pages on your site — no JavaScript rendering, no CMS changes."
      />
      {error && <div className="callout error" role="alert" style={{ marginBottom: 14 }}>{error}</div>}
      {message && <div className="callout" style={{ marginBottom: 14 }}>{message}</div>}
      {!form || !integration ? <div className="empty">Loading…</div> : (
        <>
          <Card title="Where pages live, and how they convert">
            <div className="form-grid">
              <Field label="Public origin" hint={`Your domain (${new URL(site.baseUrl).hostname}) or a subdomain such as guides.${new URL(site.baseUrl).hostname.replace(/^www\./, "")}.`}>
                <input className="input" value={form.publicOrigin} onChange={(event) => set("publicOrigin", event.target.value)} />
              </Field>
              <Field label="Path" hint="Everything under this path is served by Eumon. Leave empty to use a whole subdomain.">
                <input className="input mono" value={form.mountPath} placeholder="/guides" onChange={(event) => set("mountPath", event.target.value)} />
              </Field>
              <Field label="Business name"><input className="input" value={form.siteName} onChange={(event) => set("siteName", event.target.value)} /></Field>
              <Field label="Page language" hint="New templates are written in this language; labels and the lang attribute follow it. Regenerate existing templates to switch their copy.">
                <select className="select" value={form.language} onChange={(event) => set("language", event.target.value)}>
                  {PAGE_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.name}</option>)}
                  {!PAGE_LANGUAGES.some((language) => language.code === form.language) && <option value={form.language}>{form.language}</option>}
                </select>
              </Field>
              <Field label="Brand colour"><div className="row" style={{ flexWrap: "nowrap" }}><input type="color" value={form.brandColor} onChange={(event) => set("brandColor", event.target.value)} style={{ width: 44, height: 36, border: 0, background: "none" }} /><input className="input mono" value={form.brandColor} onChange={(event) => set("brandColor", event.target.value)} /></div></Field>
              <Field label="Call-to-action label"><input className="input" value={form.ctaLabel} onChange={(event) => set("ctaLabel", event.target.value)} /></Field>
              <Field label="Call-to-action link" hint="WhatsApp (https://wa.me/60…), tel:, mailto:, or your contact page."><input className="input" value={form.ctaUrl} onChange={(event) => set("ctaUrl", event.target.value)} /></Field>
              <Field label="Supporting line" hint="Shown next to the button on every page." wide><input className="input" value={form.ctaCopy} onChange={(event) => set("ctaCopy", event.target.value)} /></Field>
            </div>
            <div className="row" style={{ marginTop: 12 }}><Button busy={busy === "save"} onClick={save}>Save settings</Button></div>
          </Card>

          <Card title="1 · Add the proxy rule" subtitle={<>Forward <span className="mono">{integration.hubUrl}</span> to Eumon. Pick the option that matches how your site is hosted{(() => {
              const detected = [integration.hosting.provider ?? integration.deployment, integration.hosting.cms].filter(Boolean).join(" · ");
              return detected ? ` — detected: ${detected}` : "";
            })()}.</>}>
            <div className="tabs">{integration.snippets.map((entry) => <button key={entry.id} className={tab === entry.id ? "active" : ""} onClick={() => setTab(entry.id)}>{entry.label}</button>)}</div>
            {snippet && <><p className="small muted" style={{ marginTop: 0 }}>{snippet.id === recommendedSnippet(integration) ? "Matches how your site is hosted. " : ""}{snippet.when}</p><CopyBlock code={snippet.code} /></>}
            <p className="small muted">Proxied requests must carry <span className="mono">X-Eumon-Proxy: 1</span> or <span className="mono">X-Forwarded-Host</span>; pages reached any other way are marked noindex so they never compete with your domain.</p>
          </Card>

          <Card title="2 · Verify what Google receives" subtitle="Fetches a published page through your domain as Googlebot." actions={<Button variant="secondary" busy={busy === "check"} onClick={check}>Run check</Button>}>
            {checks ? checks.map((entry) => (
              <div key={entry.name} className={`check ${entry.ok ? "ok" : "bad"}`}><b role="img" aria-label={entry.ok ? "Passed" : "Failed"}>{entry.ok ? <CheckIcon /> : <CrossIcon />}</b><div><strong>{entry.name}</strong><p>{entry.detail}</p></div></div>
            )) : <p className="small muted" style={{ margin: 0 }}>Run the check after adding the proxy rule and publishing at least one template.</p>}
          </Card>

          <Card title="3 · Help Google find the pages">
            <ol className="small" style={{ lineHeight: 1.9, paddingLeft: 18, margin: 0 }}>
              <li>Submit <span className="mono">{integration.sitemapUrl}</span> in Search Console (Sitemaps).</li>
              <li>Link to <span className="mono">{integration.hubUrl}</span> from your main navigation or footer — internal links are how crawlers and visitors discover the pages.</li>
              <li>Pages are listed in the hub and link to related pages, so every published page is reachable.</li>
            </ol>
          </Card>

          <Card title="4 · Track conversions on your main site" subtitle="Paste before </body> on every page. Conversions (forms, WhatsApp, calls, emails) are credited to the landing page the visitor first arrived on.">
            <CopyBlock code={integration.trackingSnippet} />
            <p className="small muted">Track anything else with <span className="mono">eumonTrack(&quot;booking_complete&quot;)</span>. No personal data or form contents are sent.</p>
            <RecentEvents siteId={site.id} />
          </Card>
        </>
      )}
      <PartHead id="sync-history" title="Sync history" description="Each time Eumon fetched Search Console, Analytics, speed, authority and keywords for this site, and what every source said. A failure here is why a number stopped updating." />
      <SyncHistory siteId={site.id} />
    </div>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString("en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const isProblem = (note: string) => /\b(failed|stopped|refused)\b/i.test(note);

type SyncRun = { id: string; trigger: "manual" | "daily"; startedAt: string; finishedAt: string; notes: string[] };

/** The latest syncs, newest first; a run with a failed source opens to say which and why. */
function SyncHistory({ siteId }: { siteId: string }) {
  const [runs, setRuns] = useState<SyncRun[] | null>(null);
  const [error, setError] = useState("");
  const load = () => api<{ runs: SyncRun[] }>(`/api/sites/${siteId}/sync-runs`).then((data) => { setRuns(data.runs); setError(""); }).catch((cause) => setError(errorMessage(cause)));
  useEffect(() => { setRuns(null); void load(); }, [siteId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card title="Recent syncs" actions={<Button small variant="ghost" onClick={load}>Refresh</Button>}>
      {error ? <p className="empty-state">{error}</p> : !runs ? <p className="empty-state">Loading…</p> : !runs.length ? <p className="empty-state">No syncs yet. Sync now on the Dashboard runs one; the daily run adds one a day.</p> : runs.map((run) => {
        const problems = run.notes.filter(isProblem);
        const seconds = Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
        return (
          <details key={run.id} className="why-row" open={problems.length > 0 && run === runs[0]}>
            <summary>
              {problems.length ? <Badge tone="red">{problems.length} failed</Badge> : <Badge tone="green">OK</Badge>}
              <span className="why-title">{run.trigger === "manual" ? "Sync now" : "Daily sync"} · {when(run.startedAt)}</span>
              <span className="why-aside small muted">{seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`}</span>
              <span className="why-open" aria-hidden="true">Notes</span>
            </summary>
            <ul className="why-body sync-notes">
              {run.notes.length ? run.notes.map((note, index) => <li key={index} className={isProblem(note) ? "bad-count" : undefined}>{note}</li>) : <li>Nothing to sync: no sources apply yet.</li>}
            </ul>
          </details>
        );
      })}
    </Card>
  );
}

type RecentEvent = { id: string; event: string; destination: string | null; pageUrl: string | null; occurredAt: string; landedOnEumon: boolean };

/** The latest events the tracker sent, to check the snippet works without waiting for the counts. */
function RecentEvents({ siteId }: { siteId: string }) {
  const [events, setEvents] = useState<RecentEvent[] | null>(null);
  const load = () => api<{ events: RecentEvent[] }>(`/api/sites/${siteId}/events/recent?limit=10`).then((data) => setEvents(data.events)).catch(() => setEvents([]));
  useEffect(() => { setEvents(null); void load(); }, [siteId]); // eslint-disable-line react-hooks/exhaustive-deps
  const path = (url: string | null) => (url ? url.replace(/^https?:\/\/[^/]+/, "") || "/" : "—");
  return (
    <>
      <div className="row spread recent-events-head">
        <div className="section-title">Recent events received</div>
        <Button small variant="ghost" onClick={load}>Refresh</Button>
      </div>
      {!events ? <p className="empty-state">Loading…</p> : !events.length ? (
        <p className="empty-state">No events received yet. Once the snippet is on your site, a WhatsApp tap, call or form submission shows up here within seconds.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Event</th><th>Page</th><th>First landed on</th></tr></thead>
            <tbody>{events.map((event) => (
              <tr key={event.id}>
                <td className="small">{when(event.occurredAt)}</td>
                <td><code>{event.event}</code>{event.destination && <span className="was">{event.destination}</span>}</td>
                <td className="small"><code>{path(event.pageUrl)}</code></td>
                <td className="small">{event.landedOnEumon ? "An Eumon page" : <span className="muted">Your site</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </>
  );
}
