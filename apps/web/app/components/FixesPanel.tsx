"use client";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { Badge, Button, Card, CopyBlock } from "./ui";

type FixView = {
  id: string; kind: string; route: string; filePath: string; title: string; reason: string; urls: string[]; snippet?: string;
  beforeSnippet?: string; afterSnippet?: string; warnings: string[]; status: string; prUrl?: string; result?: string;
};
type Settings = { allowAiSearch: boolean; budget: number; autopilot: boolean };
type Data = { fixes: FixView[]; settings: Settings; open: number };

const STATUS_LABEL: Record<string, string> = {
  staged: "Ready to open", skipped: "Snippet", draft: "Draft PR", ready: "Ready for review", merged: "Merged",
  failed: "Failed checks", rejected: "Rejected", closed: "Closed", reverted: "Reverted",
};

/** Code fixes for a Next.js repo: staged ones open as small pull requests; the rest are snippets to paste. */
export function FixesPanel({ siteId, hasRepo }: { siteId: string; hasRepo: boolean }) {
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  // The site this panel shows now; an answer for a site the user has left is dropped.
  const current = useRef(siteId);
  const load = async () => {
    const id = siteId;
    try {
      const next = await api<Data>(`/api/sites/${id}/fixes`);
      if (current.current === id) { setData(next); setLoadError(""); }
    } catch (cause) {
      // A failed reload keeps the last list on screen.
      if (current.current === id) setLoadError(errorMessage(cause));
    }
  };
  useEffect(() => {
    current.current = siteId;
    setData(null); setLoadError(""); setError("");
    if (hasRepo) void load();
  }, [siteId, hasRepo]);

  const act = async (id: string, path: string, init: Parameters<typeof api>[1] = { method: "POST" }) => {
    setBusy(id); setError("");
    try { await api(path, init); await load(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(""); }
  };
  const save = (next: Settings) => act("settings", `/api/sites/${siteId}/fixes`, { method: "PUT", json: next });

  if (!hasRepo) return <Card title="Code fixes"><p className="muted">Connect a GitHub repository in Connections, and Eumon will open small pull requests that fix head tags, structured data and llms.txt.</p></Card>;
  const loadCallout = loadError && (
    <div className="callout error" role="alert">
      The code fixes didn't load: {loadError} <Button small variant="ghost" onClick={() => void load()}>Retry</Button>
    </div>
  );
  if (!data) return <Card title="Code fixes">{loadCallout || <p className="empty-state">Loading…</p>}</Card>;
  const { fixes, settings, open } = data;
  // Settings stay locked while any action runs, so a save can't race an open or reject.
  const locked = Boolean(busy);
  return (
    <Card title="Code fixes" subtitle="Small pull requests, checked by your CI and preview deploy. You merge." actions={<span className="count-pill">{open} of {settings.budget} open</span>}>
      <div className="fix-settings">
        <label><input type="checkbox" checked={settings.autopilot} disabled={locked} onChange={(e) => save({ ...settings, autopilot: e.target.checked })} /> Open pull requests automatically</label>
        <label>At most <select value={settings.budget} disabled={locked} onChange={(e) => save({ ...settings, budget: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</select> open at once</label>
        <label><input type="checkbox" checked={settings.allowAiSearch} disabled={locked} onChange={(e) => save({ ...settings, allowAiSearch: e.target.checked })} /> Let AI search crawlers read the site (never training crawlers)</label>
      </div>
      {loadCallout}
      {error && <p className="callout error">{error}</p>}
      {fixes.length === 0 && <p className="muted">No code fixes yet. They're prepared at the end of each analysis on Next.js App Router sites.</p>}
      {fixes.map((fix) => (
        <details key={fix.id} className="fix-row">
          <summary>
            <Badge>{STATUS_LABEL[fix.status] ?? fix.status}</Badge> <strong>{fix.title}</strong> <span className="muted">{fix.urls.length} {fix.urls.length === 1 ? "page" : "pages"} · {fix.filePath}</span>
          </summary>
          <p>{fix.reason}</p>
          {fix.result && <p className="muted">{fix.result}</p>}
          {fix.warnings.map((w) => <p key={w} className="muted">{w}</p>)}
          {fix.beforeSnippet && <><h4>Before</h4><pre>{fix.beforeSnippet}</pre></>}
          {fix.afterSnippet && <><h4>After</h4><pre>{fix.afterSnippet}</pre></>}
          {fix.status === "skipped" && fix.snippet && <><h4>Paste this into {fix.filePath}</h4><CopyBlock code={fix.snippet} /></>}
          <div className="row">
            {fix.prUrl && <a href={fix.prUrl} target="_blank" rel="noreferrer">View pull request</a>}
            {fix.status === "staged" && <Button small busy={busy === fix.id} disabled={Boolean(busy)} onClick={() => act(fix.id, `/api/fixes/${fix.id}/open`)}>Open now</Button>}
            {(["staged", "draft", "ready"].includes(fix.status) || (fix.status === "failed" && fix.prUrl)) && <Button small variant="ghost" disabled={Boolean(busy)} onClick={() => act(fix.id, `/api/fixes/${fix.id}/reject`)}>Reject</Button>}
          </div>
        </details>
      ))}
    </Card>
  );
}
