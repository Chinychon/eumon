"use client";

import { useCallback, useEffect, useState } from "react";
import type { Dataset, FaqPattern, GeneratedPageStatus, PageSettings, PageTemplate, SiteRecord } from "@organic-growth/core";
import { api, errorMessage, formatNumber } from "./api";
import { Badge, Button, Card, Field, toneFor, ViewHeader } from "./ui";

type TemplateWithCounts = PageTemplate & { pageCounts: Record<string, number> };
type DatasetSummary = Dataset & { recordCount: number };
type PageRow = { id: string; path: string; title: string; description: string; status: GeneratedPageStatus; qualityScore: number; qualityIssues: string[]; items: number };
type Generation = { created: number; updated: number; retired: number; draft: number; thin: number; duplicate: number };

const STATUS_TABS: Array<GeneratedPageStatus | "all"> = ["all", "published", "draft", "thin", "duplicate", "unpublished", "retired"];

/** "published" means approved by the owner; it is only "live" once the domain check passed. */
function statusLabel(status: GeneratedPageStatus | "all", live: boolean): string {
  if (status === "published") return live ? "live" : "approved";
  return status === "draft" ? "ready" : status;
}

function summarize(generation: Generation): string {
  const parts = [`${formatNumber(generation.draft)} ready`];
  if (generation.thin) parts.push(`${formatNumber(generation.thin)} held back as thin`);
  if (generation.duplicate) parts.push(`${formatNumber(generation.duplicate)} duplicates`);
  if (generation.retired) parts.push(`${formatNumber(generation.retired)} retired`);
  return `Generated: ${parts.join(", ")}.`;
}

export function PagesView({ site, onNavigate }: { site: SiteRecord; onNavigate: (view: "data" | "setup") => void }) {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [templates, setTemplates] = useState<TemplateWithCounts[]>([]);
  const [settings, setSettings] = useState<PageSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    try {
      const [datasetData, templateData, settingsData] = await Promise.all([
        api<{ datasets: DatasetSummary[] }>(`/api/sites/${site.id}/datasets`),
        api<{ templates: TemplateWithCounts[] }>(`/api/sites/${site.id}/templates`),
        api<{ settings: PageSettings }>(`/api/sites/${site.id}/settings`),
      ]);
      setDatasets(datasetData.datasets); setTemplates(templateData.templates); setSettings(settingsData.settings);
    } catch (cause) { setError(errorMessage(cause)); } finally { setLoading(false); }
  }, [site.id]);

  useEffect(() => { setLoading(true); void reload(); }, [reload]);

  async function createTemplate(dataset: DatasetSummary, ideaIndex: number) {
    setBusy(`${dataset.id}:${ideaIndex}`); setError(""); setMessage("");
    try {
      const result = await api<{ generation: Generation; model: string | null; aiError: string | null }>(`/api/datasets/${dataset.id}/templates`, { method: "POST", json: { ideaIndex, useAi: true } });
      setMessage(`${summarize(result.generation)} ${result.model ? `Copy written by ${result.model}.` : `AI copy wasn't available (${result.aiError ?? "no model"}), so data-only copy was used — edit it below.`}`);
      await reload();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  const approved = templates.reduce((sum, template) => sum + (template.pageCounts.published ?? 0), 0);
  const verified = Boolean(settings?.verifiedAt);
  const host = settings ? new URL(settings.publicOrigin).host : new URL(site.baseUrl).host;
  const usable = datasets.filter((dataset) => dataset.recordCount > 0);

  return (
    <div>
      <ViewHeader
        title="Landing pages"
        description="Each template turns records into landing pages: what the searcher is looking for, the facts that answer it, and a clear call to action. Thin or duplicate pages are never published."
        actions={<><Badge tone={verified && approved ? "green" : approved ? "amber" : "gray"}>{`${formatNumber(approved)} ${verified ? "live" : "approved"}`}</Badge><Button variant="secondary" onClick={() => onNavigate("setup")}>Serving setup</Button></>}
      />
      <div className="results">
      {error && <div className="callout error" role="alert">{error}</div>}
      {message && <div className="callout">{message}</div>}
      {!verified && approved > 0 && (
        <div className="callout warn">
          {formatNumber(approved)} approved pages are not on {host} yet: nobody, including Google, can see them until the proxy rule is added and verified.{" "}
          <Button small variant="ghost" onClick={() => onNavigate("setup")}>Finish setup</Button>
        </div>
      )}
      {loading ? <div className="empty">Loading…</div> : usable.length === 0 ? (
        <div className="empty">No records yet. <Button small variant="ghost" onClick={() => onNavigate("data")}>Collect data first</Button></div>
      ) : usable.map((dataset) => {
        const datasetTemplates = templates.filter((template) => template.datasetId === dataset.id);
        return (
          <Card key={dataset.id} title={`From ${dataset.name}`} subtitle={`${formatNumber(dataset.recordCount)} records`}>
            <div className="row" style={{ marginBottom: datasetTemplates.length ? 12 : 0 }}>
              {dataset.pageIdeas.map((idea, index) => (
                <Button key={idea.name + index} small variant={datasetTemplates.length ? "secondary" : "primary"} busy={busy === `${dataset.id}:${index}`} disabled={Boolean(busy)} onClick={() => createTemplate(dataset, index)} title={idea.rationale}>
                  Create {idea.groupBy.length ? `pages by ${idea.groupBy.join(" × ")}` : `one page per ${dataset.entityType}`}
                </Button>
              ))}
            </div>
            {datasetTemplates.map((template) => (
              <TemplateCard key={template.id} template={template} dataset={dataset} site={site} settings={settings} verified={verified} onChanged={reload} onMessage={setMessage} />
            ))}
          </Card>
        );
      })}
      </div>
    </div>
  );
}

function TemplateCard({ template, dataset, site, settings, verified, onChanged, onMessage }: {
  template: TemplateWithCounts; dataset: DatasetSummary; site: SiteRecord; settings: PageSettings | null; verified: boolean;
  onChanged: () => Promise<void>; onMessage: (message: string) => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [showPages, setShowPages] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const counts = template.pageCounts;
  const ready = counts.draft ?? 0;

  async function act(key: string, action: () => Promise<unknown>) {
    setBusy(key); setError("");
    try { await action(); await onChanged(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  return (
    <div className="template-row">
      <div className="row spread">
        <div className="grow">
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 650 }}>{template.name}</h3>
          <div className="mono muted" style={{ marginTop: 4 }}>{template.pathPattern}</div>
        </div>
        <div className="row">
          {(["published", "draft", "thin", "duplicate", "unpublished", "retired"] as const).filter((status) => counts[status]).map((status) => (
            <Badge key={status} tone={status === "published" && !verified ? "amber" : toneFor(status)}>{`${formatNumber(counts[status] ?? 0)} ${statusLabel(status, verified)}`}</Badge>
          ))}
        </div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        {ready > 0 && <Button small busy={busy === "publish"} onClick={() => act("publish", async () => {
          const result = await api<{ changed: number }>(`/api/templates/${template.id}/publish`, { method: "POST", json: { publish: true } });
          onMessage(verified
            ? `Approved ${formatNumber(result.changed)} pages; they are live on your domain now.`
            : `Approved ${formatNumber(result.changed)} pages. They go live once the proxy rule in Setup is added and verified.`);
        })}>Approve {formatNumber(ready)} ready pages</Button>}
        {(counts.published ?? 0) > 0 && <Button small variant="secondary" busy={busy === "unpublish"} onClick={() => act("unpublish", () => api(`/api/templates/${template.id}/publish`, { method: "POST", json: { publish: false } }))}>Withdraw approval</Button>}
        <Button small variant="secondary" busy={busy === "generate"} onClick={() => act("generate", async () => {
          const result = await api<{ generation: Generation }>(`/api/templates/${template.id}/generate`, { method: "POST" });
          onMessage(summarize(result.generation));
        })}>Regenerate from data</Button>
        <Button small variant="ghost" onClick={() => setEditing((value) => !value)}>{editing ? "Close editor" : "Edit copy"}</Button>
        <Button small variant="ghost" onClick={() => setShowPages((value) => !value)}>{showPages ? "Hide pages" : "Review pages"}</Button>
        {confirmDelete
          ? <><Button small variant="danger" busy={busy === "delete"} onClick={() => act("delete", () => api(`/api/templates/${template.id}`, { method: "DELETE" }))}>Delete template and pages</Button><Button small variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button></>
          : <Button small variant="danger" onClick={() => setConfirmDelete(true)}>Delete</Button>}
      </div>
      {error && <p className="small" style={{ color: "var(--red)" }}>{error}</p>}
      {editing && <TemplateEditor template={template} dataset={dataset} onSaved={async () => {
        const result = await api<{ generation: Generation }>(`/api/templates/${template.id}/generate`, { method: "POST" });
        onMessage(`Saved. ${summarize(result.generation)}`);
        setEditing(false);
        await onChanged();
      }} />}
      {showPages && <PagesList template={template} site={site} settings={settings} verified={verified} onChanged={onChanged} />}
    </div>
  );
}

function TemplateEditor({ template, dataset, onSaved }: { template: PageTemplate; dataset: Dataset; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState(template);
  const [faq, setFaq] = useState<FaqPattern[]>(template.faq);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof PageTemplate>(key: K, value: PageTemplate[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const numberFields = dataset.fields.filter((field) => field.type === "number");
  async function save() {
    setBusy(true); setError("");
    try {
      await api(`/api/templates/${template.id}`, {
        method: "PATCH",
        json: {
          name: draft.name, pathPattern: draft.pathPattern, titlePattern: draft.titlePattern, descriptionPattern: draft.descriptionPattern,
          h1Pattern: draft.h1Pattern, introPattern: draft.introPattern, itemFields: draft.itemFields, sortBy: draft.sortBy ?? "",
          sortDir: draft.sortDir, minRecords: draft.minRecords, faq: faq.filter((entry) => entry.question.trim() && entry.answer.trim()),
        },
      });
      await onSaved();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  return (
    <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
      <div className="callout" style={{ marginBottom: 12 }}>
        Placeholders: {dataset.fields.map((field) => <code key={field.key} className="mono">{`{${field.key}} `}</code>)}
        <code className="mono">{"{count} {names} {site} {year} {entity} "}</code>
        {numberFields.slice(0, 2).map((field) => <code key={field.key} className="mono">{`{min:${field.key}} {max:${field.key}} `}</code>)}
        — a sentence whose placeholder has no data is left out automatically.
      </div>
      <div className="form-grid">
        <Field label="Template name"><input className="input" value={draft.name} onChange={(event) => set("name", event.target.value)} /></Field>
        <Field label="URL pattern" hint="Published pages keep their URL even if this changes."><input className="input mono" value={draft.pathPattern} onChange={(event) => set("pathPattern", event.target.value)} /></Field>
        <Field label="Title tag" hint="Aim for under 60 characters, primary search phrase first." wide><input className="input" value={draft.titlePattern} onChange={(event) => set("titlePattern", event.target.value)} /></Field>
        <Field label="Meta description" wide><input className="input" value={draft.descriptionPattern} onChange={(event) => set("descriptionPattern", event.target.value)} /></Field>
        <Field label="H1" wide><input className="input" value={draft.h1Pattern} onChange={(event) => set("h1Pattern", event.target.value)} /></Field>
        <Field label="Intro" wide><textarea className="textarea" value={draft.introPattern} onChange={(event) => set("introPattern", event.target.value)} /></Field>
        <Field label="Fields shown on the page" wide>
          <div className="row">
            {dataset.fields.filter((field) => field.key !== template.itemTitleField).map((field) => (
              <label key={field.key} className="chip">
                <input type="checkbox" checked={draft.itemFields.includes(field.key)} onChange={(event) => set("itemFields", event.target.checked ? [...draft.itemFields, field.key] : draft.itemFields.filter((key) => key !== field.key))} />
                {field.label}
              </label>
            ))}
          </div>
        </Field>
        {template.groupBy.length > 0 && (
          <>
            <Field label="Sort listings by">
              <select className="select" value={draft.sortBy ?? ""} onChange={(event) => set("sortBy", event.target.value || undefined)}>
                <option value="">Data order</option>
                {dataset.fields.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
              </select>
            </Field>
            <Field label="Minimum listings per page" hint="Pages with fewer records are held back as thin.">
              <input className="input" type="number" min={1} max={100} value={draft.minRecords} onChange={(event) => set("minRecords", Number(event.target.value))} />
            </Field>
          </>
        )}
      </div>
      <div className="section-title">FAQ</div>
      {faq.map((entry, index) => (
        <div className="form-grid" key={index} style={{ marginBottom: 8 }}>
          <input className="input" placeholder="Question" value={entry.question} onChange={(event) => setFaq((items) => items.map((item, i) => (i === index ? { ...item, question: event.target.value } : item)))} />
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input className="input" placeholder="Answer" value={entry.answer} onChange={(event) => setFaq((items) => items.map((item, i) => (i === index ? { ...item, answer: event.target.value } : item)))} />
            <Button small variant="danger" onClick={() => setFaq((items) => items.filter((_, i) => i !== index))}>Remove</Button>
          </div>
        </div>
      ))}
      <Button small variant="ghost" onClick={() => setFaq((items) => [...items, { question: "", answer: "" }])}>+ Add question</Button>
      {error && <p className="small" style={{ color: "var(--red)" }}>{error}</p>}
      <div className="row" style={{ marginTop: 12 }}><Button busy={busy} onClick={save}>Save and regenerate</Button></div>
    </div>
  );
}

function PagesList({ template, site, settings, verified, onChanged }: { template: PageTemplate; site: SiteRecord; settings: PageSettings | null; verified: boolean; onChanged: () => Promise<void> }) {
  const [tab, setTab] = useState<GeneratedPageStatus | "all">("all");
  const [pages, setPages] = useState<PageRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    const status = tab === "all" ? "" : `&status=${tab}`;
    const data = await api<{ pages: PageRow[]; total: number }>(`/api/templates/${template.id}/pages?limit=25&offset=${offset}${status}`);
    setPages(data.pages); setTotal(data.total);
  }, [template.id, tab, offset]);
  useEffect(() => { void load(); }, [load]);

  async function setStatus(page: PageRow, status: "published" | "unpublished") {
    setBusy(page.id);
    try {
      await api(`/api/pages/${page.id}`, { method: "PATCH", json: { status, reason: status === "published" ? "Published individually" : "Taken offline individually" } });
      await load(); await onChanged();
    } finally { setBusy(""); }
  }

  const origin = settings?.publicOrigin ?? site.baseUrl;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="tabs">{STATUS_TABS.map((status) => <button key={status} className={tab === status ? "active" : ""} onClick={() => { setTab(status); setOffset(0); }}>{statusLabel(status, verified)}</button>)}</div>
      {pages.length === 0 ? <div className="empty">No pages in this view.</div> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Page</th><th>Status</th><th className="num">Quality</th><th>Notes</th><th /></tr></thead>
            <tbody>
              {pages.map((page) => (
                <tr key={page.id}>
                  <td>
                    <strong style={{ fontSize: 13 }}>{page.title}</strong>
                    <div className="row small" style={{ marginTop: 3 }}>
                      <a className="mono" href={`/p/${site.id}${page.path}?preview=1`} target="_blank" rel="noreferrer">{page.path}</a>
                      {page.status === "published" && verified && <a href={`${origin}${page.path}`} target="_blank" rel="noreferrer">live</a>}
                    </div>
                  </td>
                  <td><Badge tone={page.status === "published" && !verified ? "amber" : toneFor(page.status)}>{statusLabel(page.status, verified)}</Badge></td>
                  <td className="num">{Math.round(page.qualityScore * 100)}</td>
                  <td className="small muted">{page.qualityIssues.join(" ")}</td>
                  <td>
                    {page.status === "published" && <Button small variant="ghost" busy={busy === page.id} onClick={() => setStatus(page, "unpublished")}>Withdraw</Button>}
                    {(page.status === "draft" || page.status === "unpublished") && <Button small variant="secondary" busy={busy === page.id} onClick={() => setStatus(page, "published")}>Approve</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <Button small variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous</Button>
        <span className="small muted">{total ? `${offset + 1}–${Math.min(offset + 25, total)} of ${formatNumber(total)}` : ""}</span>
        <Button small variant="secondary" disabled={offset + 25 >= total} onClick={() => setOffset(offset + 25)}>Next</Button>
      </div>
    </div>
  );
}
