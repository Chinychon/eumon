"use client";

import { useCallback, useEffect, useState } from "react";
import { LEAD_STATUS_LABELS, LEAD_STATUSES, type Compare, type LeadStatus } from "@organic-growth/core";
import { api, errorMessage, formatDay, formatNumber } from "../api";
import { LineChart } from "../charts";
import type { Payload } from "../site-data";
import { Button, Card, Kpi } from "../ui";

/*
 * What enquiries became. Every WhatsApp link Eumon tracks writes a short code
 * into the visitor's message; staff match a chat by its code here and mark it
 * chat, qualified, customer (with its value) or lost. The outcomes card is on
 * the client link too; the desk where leads are marked is the dashboard's.
 */

type Lead = {
  id: string; ref: string | null; channel: string; status: LeadStatus; pageUrl: string | null; placement: string | null;
  value: number | null; note: string | null; createdAt: string;
  landing: { path: string; template: string | null; source: string | null } | null;
};

/** A sum of money in the site's currency, or a plain number before one is set. */
export function money(value: number | null, currency: string | null): string {
  if (value === null) return "—";
  if (!currency) return formatNumber(Math.round(value));
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${currency} ${formatNumber(Math.round(value))}`;
  }
}

const before = (compare: Compare, format: (value: number) => string = formatNumber) =>
  compare.previous === null ? "First 28 days of data" : `${format(compare.previous)} in the 28 days before`;

const SOURCE_LABEL = (source: string | null) => (source === "search" ? "Search" : source?.startsWith("ai:") ? `AI (${source.slice(3)})` : source ? "Other" : "—");

/** Enquiries through to customers and their value, per week, and by the kind of page visitors landed on. */
export function OutcomesCard({ data, operator }: { data: Payload; operator: boolean }) {
  const { outcomes } = data.results;
  const subtitle = "WhatsApp chats matched to the visit that started them, and what they became. 28 days to yesterday.";
  if (!outcomes.since) {
    return (
      <Card title="From enquiry to customer" subtitle={subtitle}>
        <p className="empty-state">{operator
          ? "Point your call to action at WhatsApp (https://wa.me/…): each click writes a short code into the visitor's message, and the code matches the chat to the visit here."
          : "Not measured yet."}</p>
      </Card>
    );
  }
  const total = outcomes.byPageType.reduce((sum, row) => ({ leads: sum.leads + row.leads, won: sum.won + row.won, revenue: sum.revenue + row.revenue }), { leads: 0, won: 0, revenue: 0 });
  return (
    <Card title="From enquiry to customer" subtitle={subtitle}>
      <div className="metrics-grid">
        <Kpi label="WhatsApp clicks · 28 days" value={formatNumber(outcomes.clicks.current ?? 0)} caption={`with a code, since ${formatDay(outcomes.since)}`} />
        <Kpi label="Chats matched" value={formatNumber(outcomes.chats.current ?? 0)} caption={outcomes.clicks.current ? `${Math.round(((outcomes.chats.current ?? 0) / outcomes.clicks.current) * 100)}% of clicks` : before(outcomes.chats)} />
        <Kpi label="Customers" value={formatNumber(outcomes.customers.current ?? 0)} caption={`${formatNumber(outcomes.qualified.current ?? 0)} qualified`} />
        <Kpi label="Value won" value={money(outcomes.revenue.current, outcomes.currency)} caption={before(outcomes.revenue, (value) => money(value, outcomes.currency))} />
      </div>
      {outcomes.weeks.length > 1 && (
        <>
          <div className="section-title">Chats and customers per week</div>
          <LineChart series={["chats", "customers"]} partialFrom={outcomes.weeks.find((week) => week.partial)?.week} points={outcomes.weeks.map((week) => ({ x: week.week, values: [week.chats, week.customers] }))} />
        </>
      )}
      <div className="section-title">Which pages bring customers · last 90 days</div>
      {outcomes.byPageType.length ? (
        <div className="table-wrap">
          <table className="table top-queries">
            <thead><tr><th>Where visitors landed</th><th className="num">Leads</th><th className="num">Chats</th><th className="num">Qualified</th><th className="num">Customers</th><th className="num">Value</th><th className="num">Value per lead</th></tr></thead>
            <tbody>{outcomes.byPageType.map((row) => (
              <tr key={row.pageType}>
                <td>{row.pageType}</td>
                <td className="num">{formatNumber(row.leads)}</td>
                <td className="num">{formatNumber(row.chats)}</td>
                <td className="num">{formatNumber(row.qualified)}</td>
                <td className="num">{formatNumber(row.won)}</td>
                <td className="num">{money(row.revenue, outcomes.currency)}</td>
                <td className="num">{row.leads ? money(row.revenue / row.leads, outcomes.currency) : "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className="empty-state">No leads in the last 90 days.</p>}
      <p className="small muted">
        {total.won ? `${formatNumber(total.won)} customers worth ${money(total.revenue, outcomes.currency)} from ${formatNumber(total.leads)} leads. ` : ""}
        A chat counts once staff match its code; leads started on a page whose visitor never landed on an Eumon page count under the rest of the site.
        {operator && !outcomes.currency ? " Set the currency in Setup so values read as money." : ""}
      </p>
    </Card>
  );
}

/** One lead's row: its code, where the visitor landed and came from, and controls to move it on. */
function LeadRow({ lead, currency, onSave }: { lead: Lead; currency: string | null; onSave: (lead: Lead, change: { status?: LeadStatus; value?: number | null }) => Promise<void> }) {
  const [value, setValue] = useState(lead.value === null ? "" : String(lead.value));
  const [busy, setBusy] = useState(false);
  const save = async (change: { status?: LeadStatus; value?: number | null }) => { setBusy(true); try { await onSave(lead, change); } finally { setBusy(false); } };
  return (
    <tr>
      <td className="mono">{lead.ref ?? <span className="muted">{lead.channel}</span>}<span className="was">{formatDay(lead.createdAt.slice(0, 10))}</span></td>
      <td>{lead.landing ? <>{lead.landing.template ?? lead.landing.path}<span className="was">{lead.landing.path}</span></> : <span className="muted">{lead.pageUrl ? "Rest of the site" : "—"}</span>}</td>
      <td>{SOURCE_LABEL(lead.landing?.source ?? null)}</td>
      <td>
        <select className="select" style={{ minWidth: 150 }} value={lead.status} disabled={busy} onChange={(event) => void save({ status: event.target.value as LeadStatus })}>
          {LEAD_STATUSES.filter((status) => status !== "clicked" || lead.ref).map((status) => <option key={status} value={status}>{LEAD_STATUS_LABELS[status]}</option>)}
        </select>
      </td>
      <td className="num">
        {lead.status === "won" ? (
          <input className="input" style={{ width: 110, textAlign: "right" }} inputMode="decimal" placeholder={currency ?? "Value"} value={value} disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => { const next = value.trim() === "" ? null : Number(value.replace(/,/g, "")); if (next === null || Number.isFinite(next)) void save({ value: next }); }} />
        ) : <span className="muted">—</span>}
      </td>
    </tr>
  );
}

/**
 * Where staff record what each enquiry became: paste the WhatsApp message (or
 * type its code) to find the click, then mark it. Enquiries without a code can
 * be added by hand so the counts stay whole.
 */
export function LeadsDesk({ siteId, onChanged }: { siteId: string; onChanged?: () => void }) {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [found, setFound] = useState<Lead | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [channel, setChannel] = useState("phone");
  const [all, setAll] = useState(false);

  const load = useCallback(() => api<{ leads: Lead[]; currency: string | null }>(`/api/sites/${siteId}/leads`)
    .then((data) => { setLeads(data.leads); setCurrency(data.currency); }).catch((cause) => setError(errorMessage(cause))), [siteId]);
  useEffect(() => { setLeads(null); setFound(null); void load(); }, [load]);

  async function lookUp() {
    setError(""); setMessage(""); setFound(null);
    try {
      setFound((await api<{ lead: Lead }>(`/api/sites/${siteId}/leads?find=${encodeURIComponent(find)}`)).lead);
    } catch (cause) { setError(errorMessage(cause)); }
  }

  async function save(lead: Lead, change: { status?: LeadStatus; value?: number | null }) {
    setError("");
    try {
      const { lead: next } = await api<{ lead: Lead }>(`/api/sites/${siteId}/leads/${lead.id}`, { method: "PATCH", json: change });
      setLeads((list) => list?.map((entry) => (entry.id === next.id ? next : entry)) ?? null);
      setFound((current) => (current?.id === next.id ? next : current));
      if (change.status === "won") setMessage(`Marked ${next.ref ?? "the lead"} as a customer. Add the value it brought.`);
      onChanged?.();
    } catch (cause) { setError(errorMessage(cause)); }
  }

  async function addLead() {
    setError("");
    try {
      const { lead } = await api<{ lead: Lead }>(`/api/sites/${siteId}/leads`, { method: "POST", json: { channel } });
      setLeads((list) => [lead, ...(list ?? [])]);
      onChanged?.();
    } catch (cause) { setError(errorMessage(cause)); }
  }

  const table = (rows: Lead[]) => (
    <div className="table-wrap">
      <table className="table top-queries">
        <thead><tr><th>Code</th><th>Landed on</th><th>Came from</th><th>Status</th><th className="num">Value</th></tr></thead>
        <tbody>{rows.map((lead) => <LeadRow key={`${lead.id}:${lead.status}`} lead={lead} currency={currency} onSave={save} />)}</tbody>
      </table>
    </div>
  );

  return (
    <Card title="Match a chat" subtitle="WhatsApp messages from your pages end with a code like “(ref K7M2Q)”. Paste the message or type the code to find the visit, then mark what it became.">
      {error && <div className="callout error" role="alert">{error}</div>}
      {message && <div className="callout">{message}</div>}
      <div className="row">
        <input className="input" style={{ maxWidth: 420 }} placeholder="Hi, I would like to ask about braces (ref K7M2Q)" value={find}
          onChange={(event) => setFind(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && find.trim()) void lookUp(); }} />
        <Button small variant="secondary" disabled={!find.trim()} onClick={lookUp}>Find</Button>
      </div>
      {found && table([found])}
      <div className="section-title">Latest leads</div>
      {!leads ? <p className="empty-state">Loading…</p> : leads.length ? (
        <>
          {table(all ? leads : leads.slice(0, 12))}
          {!all && leads.length > 12 && <Button small variant="ghost" onClick={() => setAll(true)}>Show the latest {leads.length}</Button>}
        </>
      ) : <p className="empty-state">No leads yet. They appear here as visitors tap WhatsApp on your pages.</p>}
      <div className="row" style={{ marginTop: 10 }}>
        <span className="small muted">An enquiry without a code:</span>
        <select className="select" style={{ maxWidth: 160 }} value={channel} onChange={(event) => setChannel(event.target.value)}>
          {["phone", "whatsapp", "email", "form", "walk-in", "other"].map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </select>
        <Button small variant="ghost" onClick={addLead}>Add enquiry</Button>
      </div>
      <p className="small muted">No phone number or message is stored: only the code, the visit it came from, and what you mark.</p>
    </Card>
  );
}
