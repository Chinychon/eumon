"use client";

import { useEffect, useState } from "react";
import { ApiError, api, errorMessage } from "../components/api";
import { Button, Card, Field } from "../components/ui";

type Limits = Record<string, number | boolean | null>;
type Row = { id: string; name: string; sites: number; members: number; usage: Record<string, number>; overrides: Limits };
const METERED = ["analysesPerDay", "scrapePagesPerDay", "askPerDay", "aiRunsPerDay"];
const NUMBERS = ["sites", "members", ...METERED];
const FEATURES = ["dataForSeo", "pullRequests", "sheetsExport"];

export default function Admin() {
  const [data, setData] = useState<{ defaults: Limits; workspaces: Row[] } | null>(null);
  const [error, setError] = useState("");
  const load = () => api<{ defaults: Limits; workspaces: Row[] }>("/api/admin/workspaces").then(setData, (caught) => setError(caught instanceof ApiError && caught.status === 404 ? "Not found." : errorMessage(caught)));
  useEffect(() => { void load(); }, []);
  if (error) return <main className="admin"><div className="callout error" role="alert">{error}</div></main>;
  if (!data) return null;
  return (
    <main className="admin">
      <h1>Workspaces</h1>
      {data.workspaces.map((row) => <WorkspaceLimits key={row.id} row={row} defaults={data.defaults} onSaved={load} />)}
    </main>
  );
}

function WorkspaceLimits({ row, defaults, onSaved }: { row: Row; defaults: Limits; onSaved: () => void }) {
  const effective = { ...defaults, ...row.overrides };
  const [draft, setDraft] = useState<Limits>(effective);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Card title={row.name} subtitle={`${row.sites} sites · ${row.members} people · today: ${METERED.map((m) => `${m} ${row.usage[m] ?? 0}/${effective[m] ?? "∞"}`).join(", ")}`}>
      <form onSubmit={async (event) => {
        event.preventDefault(); setBusy(true); setError("");
        try { await api(`/api/admin/workspaces/${row.id}/limits`, { method: "PUT", json: draft }); onSaved(); }
        catch (caught) { setError(errorMessage(caught)); }
        finally { setBusy(false); }
      }}>
        <div className="form-grid">
          {NUMBERS.map((key) => (
            <Field key={key} label={key} hint="Empty: unlimited">
              <input className="input" type="number" min={0} value={draft[key] === null ? "" : String(draft[key])} onChange={(event) => setDraft({ ...draft, [key]: event.target.value === "" ? null : Number(event.target.value) })} />
            </Field>
          ))}
        </div>
        {FEATURES.map((key) => (
          <label key={key} style={{ display: "block" }}><input type="checkbox" checked={Boolean(draft[key])} onChange={(event) => setDraft({ ...draft, [key]: event.target.checked })} /> {key}</label>
        ))}
        <Button type="submit" busy={busy}>Save limits</Button>
        {error && <div className="callout error" role="alert">{error}</div>}
      </form>
    </Card>
  );
}
