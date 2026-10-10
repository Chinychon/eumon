"use client";

import { useEffect, useState } from "react";
import { strFromU8, unzipSync } from "fflate";
import { GSC_REASONS } from "@organic-growth/core";
import { api, errorMessage, formatDay, formatNumber } from "./api";
import { Badge, Button, Card, CopyBlock } from "./ui";

type Connectors = {
  dataForSeo: boolean;
  bing: { configured: boolean; siteUrl: string; lastSync: string | null };
  indexNow: { available: boolean; keyUrl: string | null; verified: boolean; lastSubmitted: string | null };
  logs: { endpoint: string; token: string; host: string; firstDay: string | null; lastDay: string | null; lastWeek: number } | null;
};

/** Ways to send logs, from least to most setup on the customer's side. */
function logSnippets(logs: NonNullable<Connectors["logs"]>) {
  const { endpoint, token, host } = logs;
  return [
    {
      id: "worker", label: "Cloudflare (any plan)",
      when: `Cloudflare → Workers → Create, paste this, then add the route ${host}/* to it. It passes every request through unchanged and reports only crawler requests.`,
      code: `const ENDPOINT = "${endpoint}";
const TOKEN = "${token}";
const CRAWLER = /bot|crawler|spider|slurp|ChatGPT-User|Perplexity-User|Claude-User|Meta-External|MistralAI-User/i;

export default {
  async fetch(request, env, ctx) {
    const response = await fetch(request);
    const userAgent = request.headers.get("user-agent") || "";
    if (CRAWLER.test(userAgent)) {
      const url = new URL(request.url);
      ctx.waitUntil(fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: \`Bearer \${TOKEN}\`, "Content-Type": "application/json" },
        body: JSON.stringify({ time: Date.now(), host: url.host, path: url.pathname + url.search, status: response.status, userAgent }),
      }));
    }
    return response;
  },
};`,
    },
    {
      id: "logpush", label: "Cloudflare Logpush",
      when: "Enterprise plans: Analytics & Logs → Logpush → Create a job → HTTP destination, dataset HTTP requests, with these fields. Eumon keeps only the crawler requests.",
      code: `Destination:
${endpoint}?header_Authorization=Bearer%20${token}

Fields:
ClientRequestHost, ClientRequestURI, ClientRequestUserAgent, EdgeResponseStatus, EdgeStartTimestamp`,
    },
    {
      id: "vercel", label: "Vercel",
      when: "Pro and Enterprise: Team Settings → Drains → Add Drain → Logs → Custom endpoint. Sources: static, lambda, edge, external and redirect; environment: production.",
      code: `Endpoint URL:
${endpoint}

Format: NDJSON

Custom headers:
Authorization: Bearer ${token}`,
    },
    {
      id: "server", label: "nginx or Apache",
      when: "Send yesterday's log once a day, after rotation (crontab -e). The standard combined log format is read as is; gzip keeps large logs under the 24 MB limit.",
      code: `15 1 * * * gzip -c /var/log/nginx/access.log.1 | curl -sS -X POST --data-binary @- -H "Authorization: Bearer ${token}" ${endpoint}`,
    },
  ];
}

/** Most bytes sent per upload request; the endpoint reads up to 24 MB. */
const UPLOAD_CHUNK = 8 * 1024 * 1024;

/** Sends a log file in line-aligned pieces (or as one gzip file), and sums what the endpoint kept. */
async function uploadLog(file: File, logs: NonNullable<Connectors["logs"]>): Promise<{ received: number; crawler: number }> {
  const post = async (body: BodyInit) => {
    const response = await fetch(logs.endpoint, { method: "POST", headers: { Authorization: `Bearer ${logs.token}` }, body });
    const data = await response.json() as { received?: number; crawler?: number; error?: string };
    if (!response.ok) throw new Error(data.error ?? `Upload failed (${response.status}).`);
    return { received: data.received ?? 0, crawler: data.crawler ?? 0 };
  };
  if (file.name.endsWith(".gz")) return post(file);
  const total = { received: 0, crawler: 0 };
  for (let start = 0; start < file.size;) {
    const slice = await file.slice(start, start + UPLOAD_CHUNK).text();
    // End each piece on a line break, so no request is split in two.
    const cut = start + UPLOAD_CHUNK >= file.size ? slice.length : slice.lastIndexOf("\n") + 1 || slice.length;
    const part = await post(slice.slice(0, cut));
    total.received += part.received;
    total.crawler += part.crawler;
    start += new Blob([slice.slice(0, cut)]).size;
  }
  return total;
}

/** The connections beyond Google: DataForSEO's search results and backlinks, Bing, IndexNow, and server logs. */
export function ConnectorSetup({ siteId }: { siteId: string }) {
  const [connectors, setConnectors] = useState<Connectors | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("worker");
  const [upload, setUpload] = useState("");
  const [uploading, setUploading] = useState(false);
  const [exportReason, setExportReason] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setConnectors(null);
    api<Connectors>(`/api/sites/${siteId}/connectors`).then(setConnectors).catch((cause) => setError(errorMessage(cause)));
  }, [siteId]);

  async function sendFile(file: File | undefined) {
    if (!file || !connectors?.logs) return;
    setUploading(true); setUpload("");
    try {
      const result = await uploadLog(file, connectors.logs);
      setUpload(`Read ${formatNumber(result.received)} requests; kept ${formatNumber(result.crawler)} from crawlers. The Technical tab shows them now.`);
    } catch (cause) { setUpload(errorMessage(cause)); } finally { setUploading(false); }
  }

  /** One export (CSV, or the ZIP Search Console downloads): every CSV inside is imported, then URLs outside the sitemap are fetched until none remain. */
  async function sendExport(file: File | undefined) {
    if (!file) return;
    setExporting(true); setExportStatus("Reading the export…");
    try {
      // The ZIP's name carries the reason; its members are Table.csv, Chart.csv and the like. Finder's resource forks are not data.
      const files: Array<{ name: string; text: string }> = file.name.toLowerCase().endsWith(".zip")
        ? Object.entries(unzipSync(new Uint8Array(await file.arrayBuffer()))).filter(([name]) => name.toLowerCase().endsWith(".csv") && !name.startsWith("__MACOSX/")).map(([, data]) => ({ name: file.name, text: strFromU8(data) }))
        : [{ name: file.name, text: await file.text() }];
      if (!files.length) throw new Error("The ZIP holds no CSV files.");
      const notes: string[] = [];
      const skipped: string[] = [];
      let remaining = 0;
      for (const entry of files) {
        const query = new URLSearchParams({ name: entry.name, ...(exportReason ? { reason: exportReason } : {}) });
        try {
          const outcome = await api<{ kind: string; imported: number; reason?: string; otherHost?: number; remainingChecks?: number }>(`/api/sites/${siteId}/search-console/import?${query}`, { method: "POST", body: entry.text, headers: { "Content-Type": "text/csv" } });
          const label = outcome.reason ? GSC_REASONS.find((reason) => reason.reason === outcome.reason)?.label ?? outcome.reason : "";
          notes.push(outcome.kind === "urls" ? `${formatNumber(outcome.imported)} URLs as ${label}${outcome.otherHost ? ` (${formatNumber(outcome.otherHost)} on another host left out)` : ""}` : outcome.kind === "table" ? `the overview (${outcome.imported} reasons)` : `the chart (${outcome.imported} days)`);
          remaining = Math.max(remaining, outcome.remainingChecks ?? 0);
        } catch (cause) {
          // One member the importer doesn't know (a drill-down's own chart, say) doesn't stop the others.
          if (files.length === 1) throw cause;
          skipped.push(errorMessage(cause));
        }
      }
      if (!notes.length) throw new Error(skipped[0] ?? "Nothing in the ZIP could be read.");
      const imported = `Imported ${notes.join(", ")}.${skipped.length ? ` Skipped ${skipped.length} file${skipped.length === 1 ? "" : "s"} in the ZIP: ${skipped[0]}` : ""}`;
      let done = 0;
      while (remaining > 0) {
        setExportStatus(`${imported} Checking ${formatNumber(remaining + done)} URLs that are no longer in the sitemap… ${formatNumber(done)} done.`);
        const step = await api<{ checked: number; remaining: number }>(`/api/sites/${siteId}/search-console/check`, { method: "POST" });
        done += step.checked;
        remaining = step.remaining;
        if (!step.checked) break;
      }
      setExportStatus(`${imported}${done ? ` Checked ${formatNumber(done)} URLs outside the sitemap.` : ""} The Search tab shows the result.`);
      setExportReason("");
    } catch (cause) { setExportStatus(errorMessage(cause)); } finally { setExporting(false); }
  }

  if (error) return <Card><p className="empty-state">{error}</p></Card>;
  if (!connectors) return <Card><p className="empty-state">Loading…</p></Card>;
  const { logs, bing, indexNow } = connectors;
  const snippets = logs ? logSnippets(logs) : [];
  const snippet = snippets.find((entry) => entry.id === tab);
  return (
    <Card title="More sources" subtitle="Each one is optional and adds evidence the growth plan uses.">
      <div className="list-row">
        <Badge tone={connectors.dataForSeo ? "green" : "gray"}>{connectors.dataForSeo ? "DataForSEO" : "Optional"}</Badge>
        <div className="grow">
          <h3>Search results, search competitors and backlinks</h3>
          <p>{connectors.dataForSeo
            ? "Google's first page for your biggest searches (10 a day), the domains that win them, your referring domains with new, lost and spam links, and link profiles with the link gap, each refreshed monthly. Daily positions for the keywords you track on the Keywords tab. Weekly answers from ChatGPT, Gemini, Google AI Mode and Perplexity to the questions you track on the AI visibility tab. Backlinks need the Backlinks API active on the DataForSEO account."
            : "Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD (app.dataforseo.com → API Access). The same account prices your keywords."}</p>
        </div>
      </div>
      <div className="list-row">
        {/* Configured means the key is set; whether Bing knows this site shows only when a sync has read it. */}
        <Badge tone={bing.lastSync ? "green" : bing.configured ? "amber" : "gray"}>{bing.lastSync ? "Bing" : bing.configured ? "Key set" : "Optional"}</Badge>
        <div className="grow">
          <h3>Bing Webmaster Tools</h3>
          <p>{bing.configured || bing.lastSync
            ? <>Verify <span className="mono">{bing.siteUrl}</span> in the Bing account the key belongs to (Bing can import it from Search Console). {bing.lastSync ? `Last synced ${formatDay(bing.lastSync)}.` : "The key is set; nothing has synced yet. Press Sync now on the Overview, or wait for the daily sync, and Bing's clicks, impressions and crawl counts appear."}</>
            : <>Create an API key in Bing Webmaster Tools (Settings → API access) and set it as BING_WEBMASTER_API_KEY. Bing's clicks, impressions and crawl counts then sync daily.</>}</p>
        </div>
      </div>
      <div className="list-row">
        <Badge tone={indexNow.lastSubmitted ? "green" : "gray"}>{indexNow.lastSubmitted ? "IndexNow" : indexNow.available ? "Waiting" : "Off"}</Badge>
        <div className="grow">
          <h3>IndexNow</h3>
          <p>{!indexNow.available
            ? "Needs SESSION_SECRET of at least 32 characters: each site's IndexNow key is derived from it."
            : !indexNow.verified
              ? "Tells Bing and the other IndexNow engines about every page Eumon publishes, changes or takes down. Starts once the proxy rule is verified below."
              : <>New and changed landing pages are sent with each sync. Key file: <a className="mono" href={indexNow.keyUrl!} target="_blank" rel="noreferrer">{indexNow.keyUrl}</a>{indexNow.lastSubmitted ? `. Last sent ${formatDay(indexNow.lastSubmitted)}.` : "."}</>}</p>
        </div>
      </div>
      <div className="list-row">
        <Badge tone="gray">Export</Badge>
        <div className="grow">
          <h3>Search Console export</h3>
          <p>Google's Page indexing report has no API, but it exports. Drop a reason's URL list (the ZIP as downloaded, or its CSV), the overview table, or the chart: every URL is checked against today's crawl, URLs no longer in the sitemap are fetched, and gone ones get a redirect suggestion. The Search tab shows the result.</p>
          <div className="row" style={{ marginTop: 8 }}>
            <select className="input" value={exportReason} onChange={(event) => setExportReason(event.target.value)} disabled={exporting} aria-label="Reason of the URL list">
              <option value="">Reason from the file name</option>
              {GSC_REASONS.filter((entry) => entry.reason !== "other").map((entry) => <option key={entry.reason} value={entry.reason}>{entry.label}</option>)}
            </select>
            <label className="btn btn-secondary btn-small">
              {exporting ? "Importing…" : "Import an export"}
              <input type="file" accept=".csv,.zip" hidden disabled={exporting} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void sendExport(file); }} />
            </label>
          </div>
          {exportStatus && <p className="small">{exportStatus}</p>}
        </div>
      </div>
      <div className="list-row">
        <Badge tone={logs?.lastDay ? "green" : "gray"}>{logs?.lastDay ? "Logs" : "Optional"}</Badge>
        <div className="grow">
          <h3>Server or CDN logs</h3>
          {!logs ? <p>Needs SESSION_SECRET of at least 32 characters: each site's log token is derived from it.</p> : (
            <>
              <p>Shows which pages Googlebot, Bingbot and AI agents actually request across the whole site, and where crawl requests go to waste. Only crawler requests are kept. {logs.lastDay ? `Receiving since ${formatDay(logs.firstDay!)}; ${formatNumber(logs.lastWeek)} crawler requests in the last 7 days.` : "Nothing received yet."}</p>
              <div className="tabs" style={{ marginTop: 8 }}>{snippets.map((entry) => <button key={entry.id} className={tab === entry.id ? "active" : ""} onClick={() => setTab(entry.id)}>{entry.label}</button>)}</div>
              {snippet && <><p className="small muted" style={{ marginTop: 0 }}>{snippet.when}</p><CopyBlock code={snippet.code} /></>}
              <div className="row" style={{ marginTop: 8 }}>
                <label className="btn btn-secondary btn-small">
                  {uploading ? "Uploading…" : "Upload an access log"}
                  <input type="file" accept=".log,.txt,.gz,.json,.ndjson" hidden disabled={uploading} onChange={(event) => void sendFile(event.target.files?.[0])} />
                </label>
                <span className="small muted">A one-off look: an nginx or Apache log, or an NDJSON export.</span>
              </div>
              {upload && <p className="small">{upload}</p>}
              <p className="small muted">The token in these snippets lets anyone who has it send logs for this site; rotate it if it leaks.</p>
              <Button small variant="ghost" onClick={async () => {
                if (!window.confirm("Rotate the log token? Log shipping stops until you paste the new token into it.")) return;
                try {
                  const { token } = await api<{ token: string }>(`/api/sites/${siteId}/connectors`, { method: "POST" });
                  setConnectors({ ...connectors, logs: { ...logs, token } });
                } catch (cause) { setUpload(errorMessage(cause)); }
              }}>Rotate token</Button>
            </>
          )}
        </div>
      </div>
      <Button small variant="ghost" onClick={() => api<Connectors>(`/api/sites/${siteId}/connectors`).then(setConnectors).catch((cause) => setError(errorMessage(cause)))}>Refresh status</Button>
    </Card>
  );
}
