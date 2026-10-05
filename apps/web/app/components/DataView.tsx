"use client";

import { useCallback, useEffect, useState } from "react";
import type { DataRecord, DataSource, Dataset, DatasetField, DatasetFieldType, Job, SiteRecord } from "@organic-growth/core";
import { api, errorMessage, formatNumber } from "./api";
import { Badge, Button, Card, Field, Progress, toneFor, usePolling, ViewHeader } from "./ui";

type DatasetWithDetails = Dataset & { recordCount: number; sources: DataSource[]; latestJob: Job | null };
type Scope = { goal?: string; businessSummary: string; conversionGoal: string } | null;
type Preview = {
  matched: number; blocked: number; total?: number; urls: string[]; notes: string[];
  sample: { url: string; summary: string; records: Array<Record<string, unknown>> } | null; sampleError?: string;
};

const FIELD_TYPES: DatasetFieldType[] = ["text", "number", "list", "url", "boolean"];
const KIND_LABEL: Record<DataSource["kind"], string> = {
  own_site: "Your site", listing: "Listing page", sitemap: "Sitemap", page: "Single page",
};

function display(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

export function DataView({ site, onNavigate }: { site: SiteRecord; onNavigate: (view: "pages") => void }) {
  const [datasets, setDatasets] = useState<DatasetWithDetails[]>([]);
  const [scope, setScope] = useState<Scope>(null);
  const [goal, setGoal] = useState("");
  const [loading, setLoading] = useState(true);
  const [scoping, setScoping] = useState(false);
  const [error, setError] = useState("");
  const [showNew, setShowNew] = useState(false);

  const reload = useCallback(async () => {
    try {
      const data = await api<{ datasets: DatasetWithDetails[]; scope: Scope }>(`/api/sites/${site.id}/datasets`);
      setDatasets(data.datasets);
      setScope(data.scope);
      if (data.scope?.goal) setGoal((current) => current || data.scope?.goal || "");
    } catch (cause) { setError(errorMessage(cause)); } finally { setLoading(false); }
  }, [site.id]);

  useEffect(() => { setLoading(true); setDatasets([]); setGoal(""); void reload(); }, [reload]);

  async function runScope() {
    setScoping(true); setError("");
    try {
      await api(`/api/sites/${site.id}/scope`, { method: "POST", json: { goal } });
      await reload();
    } catch (cause) { setError(errorMessage(cause)); } finally { setScoping(false); }
  }

  const withRecords = datasets.filter((dataset) => dataset.recordCount > 0).length;

  return (
    <div>
      <ViewHeader
        eyebrow="STEPS 1–3 · SCOPE, SOURCE & COLLECT"
        title="Data for your landing pages"
        description="Break the business down into the specific things people search for — each becomes a dataset, and each record becomes its own landing page."
        actions={withRecords > 0 && <Button variant="secondary" onClick={() => onNavigate("pages")}>Design pages →</Button>}
      />
      {error && <div className="callout error" role="alert" style={{ marginBottom: 14 }}>{error}</div>}

      <Card
        title="Scope the opportunity"
        subtitle="Eumon reads your homepage, key pages, sitemap structure, and Search Console queries, then proposes the units worth a page each — with fields to collect and where to find them."
      >
        <Field label="What should more organic traffic turn into?" hint="Optional, but it sharpens the proposal: who you sell to, what a conversion is, which markets matter.">
          <textarea className="textarea" value={goal} maxLength={600} placeholder="e.g. More WhatsApp enquiries from Indonesian patients looking for treatment in Malaysia" onChange={(event) => setGoal(event.target.value)} />
        </Field>
        <div className="row" style={{ marginTop: 12 }}>
          <Button busy={scoping} onClick={runScope}>{scoping ? "Reading your site… (about a minute)" : scope ? "Re-scope" : "Propose datasets"}</Button>
          <Button variant="secondary" onClick={() => setShowNew((value) => !value)}>Create a dataset manually</Button>
        </div>
        {scope && (
          <div className="callout" style={{ marginTop: 14 }}>
            <strong>Business:</strong> {scope.businessSummary}<br />
            <strong>Conversion:</strong> {scope.conversionGoal}
          </div>
        )}
        {showNew && <NewDatasetForm siteId={site.id} onCreated={() => { setShowNew(false); void reload(); }} />}
      </Card>

      {loading ? <div className="empty" style={{ marginTop: 14 }}>Loading datasets…</div> : datasets.length === 0 ? (
        <div className="empty" style={{ marginTop: 14 }}>No datasets yet. Propose datasets from your site, or create one and import a CSV.</div>
      ) : datasets.map((dataset) => <DatasetCard key={dataset.id} dataset={dataset} siteBaseUrl={site.baseUrl} onChanged={reload} />)}
    </div>
  );
}

function NewDatasetForm({ siteId, onCreated }: { siteId: string; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [entityType, setEntityType] = useState("");
  const [fields, setFields] = useState("Name:text, City:text, Price:number, Services:list");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create() {
    setBusy(true); setError("");
    try {
      const parsed = fields.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
        const [label, type] = part.split(":").map((value) => value.trim());
        return { label, type: FIELD_TYPES.includes(type as DatasetFieldType) ? type : "text" };
      });
      await api(`/api/sites/${siteId}/datasets`, { method: "POST", json: { name, entityType, fields: parsed } });
      onCreated();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  return (
    <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
      <div className="form-grid">
        <Field label="Dataset name"><input className="input" value={name} placeholder="Malls" onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="One record is a…"><input className="input" value={entityType} placeholder="mall" onChange={(event) => setEntityType(event.target.value)} /></Field>
        <Field label="Fields" hint="Label:type pairs. Types: text, number, list, url, boolean. The first field names each record." wide>
          <input className="input" value={fields} onChange={(event) => setFields(event.target.value)} />
        </Field>
      </div>
      {error && <p className="small" style={{ color: "#9f3e31" }}>{error}</p>}
      <div className="row" style={{ marginTop: 10 }}><Button busy={busy} disabled={!name.trim()} onClick={create}>Create dataset</Button></div>
    </div>
  );
}

function DatasetCard({ dataset, siteBaseUrl, onChanged }: { dataset: DatasetWithDetails; siteBaseUrl: string; onChanged: () => Promise<void> }) {
  const [job, setJob] = useState<Job | null>(dataset.latestJob);
  const [jobCounts, setJobCounts] = useState<{ total: number; pending: number; failed: number; records: number } | null>(null);
  const [failures, setFailures] = useState<Array<{ url: string; error: string }>>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [editingFields, setEditingFields] = useState(false);
  const [showRecords, setShowRecords] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const running = job?.status === "queued" || job?.status === "running";
  const approved = dataset.sources.filter((source) => source.status === "approved");

  useEffect(() => setJob(dataset.latestJob), [dataset.latestJob]);

  usePolling(running, async () => {
    if (!job) return false;
    const data = await api<{ job: Job; counts: typeof jobCounts; failures: typeof failures }>(`/api/jobs/${job.id}`);
    setJob(data.job); setJobCounts(data.counts); setFailures(data.failures);
    if (data.job.status === "completed" || data.job.status === "failed") {
      await onChanged();
      return false;
    }
  }, 3000);

  async function act(key: string, action: () => Promise<unknown>) {
    setBusy(key); setError("");
    try { await action(); await onChanged(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  async function collect() {
    setBusy("collect"); setError("");
    try {
      const started = await api<{ jobId: string }>(`/api/datasets/${dataset.id}/scrape`, { method: "POST", json: {} });
      setJob({ id: started.jobId, siteId: dataset.siteId, kind: "scrape", subjectId: dataset.id, status: "queued", createdAt: new Date().toISOString() });
      setJobCounts(null); setFailures([]);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  async function importCsv(file: File) {
    setBusy("csv"); setError("");
    try {
      const result = await api<{ imported: number; skipped: number }>(`/api/datasets/${dataset.id}/records/import`, {
        method: "POST", headers: { "Content-Type": "text/csv" }, body: await file.text(),
      });
      setError(`Imported ${formatNumber(result.imported)} records${result.skipped ? ` (${result.skipped} rows skipped: missing the key field)` : ""}.`);
      await onChanged();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }

  return (
    <Card
      title={<span className="row">{dataset.name} <Badge tone={toneFor(dataset.status)}>{dataset.status}</Badge> <span className="small muted" style={{ fontWeight: 400 }}>{formatNumber(dataset.recordCount)} records · one page per {dataset.entityType}</span></span>}
      subtitle={dataset.description}
      actions={confirmDelete
        ? <><span className="small muted">Delete dataset, records, and pages?</span><Button small variant="danger" busy={busy === "delete"} onClick={() => act("delete", () => api(`/api/datasets/${dataset.id}`, { method: "DELETE" }))}>Delete</Button><Button small variant="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Button></>
        : <Button small variant="ghost" onClick={() => setConfirmDelete(true)}>Delete</Button>}
    >
      {dataset.pageIdeas.length > 0 && (
        <div className="row" style={{ marginBottom: 10 }}>
          {dataset.pageIdeas.map((idea) => (
            <span className="chip" key={idea.name} title={idea.rationale}>
              {idea.groupBy.length ? `By ${idea.groupBy.join(" × ")}` : `Per ${dataset.entityType}`}: {idea.exampleTitle || idea.name}
            </span>
          ))}
        </div>
      )}
      {error && <div className={`callout ${/^(Imported|Merged|No duplicates)/.test(error) ? "" : "error"}`} style={{ marginBottom: 10 }}>{error}</div>}

      <div className="section-title">Fields</div>
      {editingFields
        ? <FieldsEditor dataset={dataset} onDone={async () => { setEditingFields(false); await onChanged(); }} />
        : (
          <div className="row">
            {dataset.fields.map((field) => (
              <span className="chip" key={field.key} title={field.description}>
                {field.key === dataset.keyField ? "★ " : ""}{field.label} <span className="muted">· {field.type}</span>
              </span>
            ))}
            <Button small variant="ghost" onClick={() => setEditingFields(true)}>Edit</Button>
          </div>
        )}

      <div className="section-title">Sources</div>
      {dataset.sources.length === 0 && <p className="small muted">No sources yet. Add your own site's pages, a public directory, or import a CSV.</p>}
      {dataset.sources.map((source) => <SourceRow key={source.id} source={source} onChanged={onChanged} />)}
      <AddSourceForm datasetId={dataset.id} siteBaseUrl={siteBaseUrl} onAdded={onChanged} />

      <div className="section-title">Collect</div>
      {running || job ? (
        <div style={{ marginBottom: 10 }}>
          <div className="row spread small"><span>{job?.status === "failed" ? job.error : job?.progress?.message ?? "Starting…"}</span><Badge tone={toneFor(job?.status ?? "")}>{job?.status ?? ""}</Badge></div>
          {job?.progress && job.progress.total > 0 && <div style={{ marginTop: 6 }}><Progress done={job.progress.done} total={job.progress.total} /></div>}
          {jobCounts && jobCounts.failed > 0 && <details className="disclosure" style={{ marginTop: 8 }}><summary>{jobCounts.failed} pages could not be read</summary>{failures.map((failure) => <div key={failure.url} className="small mono">{failure.url} — {failure.error}</div>)}</details>}
        </div>
      ) : null}
      <div className="row">
        <Button busy={busy === "collect" || running} disabled={!approved.length} onClick={collect}>
          {running ? "Collecting…" : `Collect from ${approved.length} approved source${approved.length === 1 ? "" : "s"}`}
        </Button>
        <label className="btn btn-secondary">
          {busy === "csv" ? "Importing…" : "Import CSV"}
          <input type="file" accept=".csv,text/csv" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importCsv(file); event.target.value = ""; }} />
        </label>
        {dataset.recordCount > 0 && <Button variant="ghost" onClick={() => setShowRecords((value) => !value)}>{showRecords ? "Hide records" : `Browse ${formatNumber(dataset.recordCount)} records`}</Button>}
        {dataset.recordCount > 1 && <Button variant="ghost" busy={busy === "dedupe"} onClick={async () => {
          setBusy("dedupe"); setError("");
          try {
            const { merges } = await api<{ merges: Array<{ canonical: string; merged: string[] }> }>(`/api/datasets/${dataset.id}/dedupe`, { method: "POST" });
            setError(merges.length
              ? `Merged ${merges.reduce((sum, merge) => sum + merge.merged.length, 0)} duplicates: ${merges.slice(0, 6).map((merge) => `${merge.merged.join(", ")} → ${merge.canonical}`).join("; ")}${merges.length > 6 ? "…" : ""}`
              : "No duplicates found.");
            await onChanged();
          } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
        }}>Merge duplicates</Button>}
      </div>
      {showRecords && <RecordsTable dataset={dataset} onChanged={onChanged} />}
    </Card>
  );
}

function FieldsEditor({ dataset, onDone }: { dataset: Dataset; onDone: () => Promise<void> }) {
  const [fields, setFields] = useState<DatasetField[]>(dataset.fields);
  const [keyField, setKeyField] = useState(dataset.keyField);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = (index: number, patch: Partial<DatasetField>) => setFields((items) => items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  async function save() {
    setBusy(true); setError("");
    try {
      await api(`/api/datasets/${dataset.id}`, { method: "PATCH", json: { fields, keyField, status: "active" } });
      await onDone();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  return (
    <div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Key</th><th>Label</th><th>Type</th><th>Description</th><th /></tr></thead>
          <tbody>
            {fields.map((field, index) => (
              <tr key={index}>
                <td><input type="radio" name={`key-${dataset.id}`} checked={keyField === field.key} onChange={() => setKeyField(field.key)} aria-label="Names each record" /></td>
                <td><input className="input" value={field.label} onChange={(event) => update(index, { label: event.target.value })} /></td>
                <td><select className="select" value={field.type} onChange={(event) => update(index, { type: event.target.value as DatasetFieldType })}>{FIELD_TYPES.map((type) => <option key={type}>{type}</option>)}</select></td>
                <td><input className="input" value={field.description ?? ""} onChange={(event) => update(index, { description: event.target.value })} /></td>
                <td><Button small variant="danger" disabled={field.key === keyField} onClick={() => setFields((items) => items.filter((_, i) => i !== index))}>Remove</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p className="small" style={{ color: "#9f3e31" }}>{error}</p>}
      <div className="row" style={{ marginTop: 10 }}>
        <Button small variant="secondary" onClick={() => setFields((items) => [...items, { key: `field_${items.length + 1}`, label: "", type: "text" }])}>Add field</Button>
        <Button small busy={busy} onClick={save}>Save fields</Button>
        <Button small variant="ghost" onClick={() => void onDone()}>Cancel</Button>
      </div>
    </div>
  );
}

function SourceRow({ source, onChanged }: { source: DataSource; onChanged: () => Promise<void> }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function act(key: string, action: () => Promise<unknown>, reload = true) {
    setBusy(key); setError("");
    try { await action(); if (reload) await onChanged(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(""); }
  }
  const sampleKeys = preview?.sample?.records[0] ? Object.keys(preview.sample.records[0]).slice(0, 6) : [];
  return (
    <div className="list-row">
      <Badge tone={source.status === "approved" ? "green" : source.status === "rejected" ? "red" : "amber"}>{source.status}</Badge>
      <div className="grow">
        <h4 className="row">
          <span className="chip">{KIND_LABEL[source.kind]}</span>
          <a href={source.url} target="_blank" rel="noreferrer" className="mono">{source.url.replace(/^https?:\/\//, "")}</a>
          {source.urlPattern && <span className="mono muted">{source.urlPattern}</span>}
        </h4>
        {source.rationale && <p>{source.rationale}</p>}
        <p className="small">
          {source.recordCount > 0 && <>{formatNumber(source.recordCount)} records · </>}
          up to {formatNumber(source.maxPages)} pages
          {source.robotsAllowed === false && <> · <span style={{ color: "#9f3e31" }}>blocked by robots.txt</span></>}
          {source.error && <> · <span style={{ color: "#9a6a16" }}>{source.error}</span></>}
        </p>
        {error && <p className="small" style={{ color: "#9f3e31" }}>{error}</p>}
        {preview && (
          <div className="callout" style={{ marginTop: 8 }}>
            <div><strong>{formatNumber(preview.matched)}</strong> matching pages{preview.blocked ? `, ${preview.blocked} blocked by robots.txt` : ""}{preview.total !== undefined && preview.total < preview.matched ? ` (${formatNumber(preview.total)} within this source's page budget)` : ""}.</div>
            {preview.notes.map((note) => <div key={note} className="small">{note}</div>)}
            {preview.urls.length > 0 && <details className="disclosure" style={{ marginTop: 6 }}><summary>Example pages</summary>{preview.urls.map((url) => <div key={url} className="small mono">{url}</div>)}</details>}
            {preview.sampleError && <div className="small" style={{ marginTop: 6, color: "#9a6a16" }}>Sample extraction: {preview.sampleError}</div>}
            {preview.sample && (
              <div style={{ marginTop: 8 }}>
                <div className="small">From <span className="mono">{preview.sample.url}</span>: {preview.sample.summary} — {preview.sample.records.length} record{preview.sample.records.length === 1 ? "" : "s"} extracted.</div>
                {preview.sample.records.length > 0 && (
                  <div className="table-wrap" style={{ marginTop: 6 }}>
                    <table className="table"><thead><tr>{sampleKeys.map((key) => <th key={key}>{key}</th>)}</tr></thead>
                      <tbody>{preview.sample.records.slice(0, 5).map((record, index) => <tr key={index}>{sampleKeys.map((key) => <td key={key}>{display(record[key])}</td>)}</tr>)}</tbody></table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <Button small variant="secondary" busy={busy === "preview"} onClick={() => act("preview", async () => setPreview(await api<Preview>(`/api/sources/${source.id}/preview`, { method: "POST" })), false)}>Preview</Button>
        {source.status !== "approved" && <Button small busy={busy === "approve"} onClick={() => act("approve", () => api(`/api/sources/${source.id}`, { method: "PATCH", json: { status: "approved" } }))}>Approve</Button>}
        {source.status === "approved" && <Button small variant="ghost" onClick={() => act("reject", () => api(`/api/sources/${source.id}`, { method: "PATCH", json: { status: "rejected" } }))}>Pause</Button>}
        <Button small variant="danger" onClick={() => act("delete", () => api(`/api/sources/${source.id}`, { method: "DELETE" }))}>Remove</Button>
      </div>
    </div>
  );
}

function AddSourceForm({ datasetId, siteBaseUrl, onAdded }: { datasetId: string; siteBaseUrl: string; onAdded: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<DataSource["kind"]>("own_site");
  const [url, setUrl] = useState("");
  const [pattern, setPattern] = useState("");
  const [maxPages, setMaxPages] = useState("300");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!open) return <Button small variant="ghost" onClick={() => setOpen(true)}>+ Add source</Button>;
  async function add() {
    setBusy(true); setError("");
    try {
      await api(`/api/datasets/${datasetId}/sources`, { method: "POST", json: { kind, url, urlPattern: pattern, maxPages: Number(maxPages) } });
      setOpen(false); setUrl(""); setPattern("");
      await onAdded();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  return (
    <div className="callout" style={{ marginTop: 8, background: "#fbfdfc" }}>
      <div className="form-grid">
        <Field label="Source type">
          <select className="select" value={kind} onChange={(event) => setKind(event.target.value as DataSource["kind"])}>
            <option value="own_site">Pages on your own site (via sitemap)</option>
            <option value="listing">A directory or listing page</option>
            <option value="sitemap">A sitemap.xml</option>
            <option value="page">A page that lists records (table or list, follows pagination)</option>
          </select>
        </Field>
        {kind === "own_site"
          ? <Field label="Site"><input className="input" value={siteBaseUrl} disabled /></Field>
          : <Field label="URL"><input className="input" value={url} placeholder="https://directory.example.com/malls" onChange={(event) => setUrl(event.target.value)} /></Field>}
        {kind !== "page" && (
          <Field label="Detail page pattern" hint="Which links are individual records. * matches one path segment, ** any number.">
            <input className="input mono" value={pattern} placeholder="/malls/*" onChange={(event) => setPattern(event.target.value)} />
          </Field>
        )}
        <Field label={kind === "page" ? "List pages to read" : "Max pages per run"} hint={kind === "page" ? "Follows the list's pager (up to 50 pages)." : undefined}>
          <input className="input" type="number" min={1} max={kind === "page" ? 50 : 5000} value={maxPages} onChange={(event) => setMaxPages(event.target.value)} />
        </Field>
      </div>
      {error && <p className="small" style={{ color: "#9f3e31" }}>{error}</p>}
      <div className="row" style={{ marginTop: 10 }}><Button small busy={busy} onClick={add}>Add source</Button><Button small variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></div>
      <p className="small muted" style={{ marginBottom: 0 }}>Eumon identifies itself as EumonBot, follows robots.txt, and paces requests. Only collect facts you are allowed to republish.</p>
    </div>
  );
}

function RecordsTable({ dataset, onChanged }: { dataset: Dataset; onChanged: () => Promise<void> }) {
  const [records, setRecords] = useState<DataRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const columns = dataset.fields.slice(0, 6);
  const load = useCallback(async () => {
    const data = await api<{ records: DataRecord[]; total: number }>(`/api/datasets/${dataset.id}/records?limit=25&offset=${offset}&q=${encodeURIComponent(search)}`);
    setRecords(data.records); setTotal(data.total);
  }, [dataset.id, offset, search]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div style={{ marginTop: 12 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <input className="input" style={{ maxWidth: 280 }} placeholder="Search records" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { setOffset(0); setSearch(query); } }} />
        <span className="small muted">{formatNumber(total)} records</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr>{columns.map((field) => <th key={field.key}>{field.label}</th>)}<th>Source</th><th /></tr></thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.id}>
                {columns.map((field) => <td key={field.key}>{display(record.data[field.key])}</td>)}
                <td className="small muted">{record.sourceUrl?.startsWith("http") ? <a href={record.sourceUrl} target="_blank" rel="noreferrer">{new URL(record.sourceUrl).hostname}</a> : record.sourceUrl ?? ""}</td>
                <td><Button small variant="danger" onClick={async () => { await api(`/api/records/${record.id}`, { method: "DELETE" }); await load(); await onChanged(); }}>Delete</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <Button small variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous</Button>
        <span className="small muted">{total ? `${offset + 1}–${Math.min(offset + 25, total)} of ${formatNumber(total)}` : ""}</span>
        <Button small variant="secondary" disabled={offset + 25 >= total} onClick={() => setOffset(offset + 25)}>Next</Button>
      </div>
    </div>
  );
}
