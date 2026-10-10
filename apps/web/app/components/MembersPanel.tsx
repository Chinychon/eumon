"use client";

import { useEffect, useState } from "react";
import type { SiteRecord } from "@organic-growth/core";
import { api, errorMessage } from "./api";
import { authClient } from "./auth-client";
import { Badge, Button, Card, CopyBlock, Field } from "./ui";

type Org = { members: Array<{ id: string; role: string; user: { email: string; name: string } }>; invitations: Array<{ id: string; email: string; role: string | null; status: string }> };

/** Who is in the workspace, and inviting more (owners). Links are shown to copy while invitation email is off. */
export function MembersPanel({ site, sites, canInvite }: { site: SiteRecord; sites: SiteRecord[]; canInvite: boolean }) {
  const [org, setOrg] = useState<Org | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "client">("client");
  const [siteIds, setSiteIds] = useState<string[]>([site.id]);
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => authClient.organization.getFullOrganization().then((result) => setOrg((result.data as unknown as Org) ?? null));
  useEffect(() => { void load(); }, []);

  return (
    <Card title="People" subtitle="Members manage every site. Clients see only the sites you choose, read-only.">
      {org?.members.map((member) => (
        <div className="list-row" key={member.id}>
          <div className="grow"><h3>{member.user.email}</h3></div>
          <Badge>{member.role}</Badge>
          {canInvite && member.role !== "owner" && (
            <Button variant="ghost" small onClick={async () => { await authClient.organization.removeMember({ memberIdOrEmail: member.id }); await load(); }}>Remove</Button>
          )}
        </div>
      ))}
      {org?.invitations.filter((invitation) => invitation.status === "pending").map((invitation) => (
        <div className="list-row" key={invitation.id}>
          <div className="grow"><h3>{invitation.email}</h3><p>Invited, not yet accepted.</p></div>
          <Badge>{invitation.role}</Badge>
        </div>
      ))}
      {canInvite && (
        <form onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true); setError(""); setLink("");
          try {
            const result = await api<{ link: string }>("/api/workspace/invitations", { method: "POST", json: { email, role, siteIds } });
            setLink(result.link); setEmail(""); await load();
          } catch (caught) {
            setError(errorMessage(caught));
          } finally {
            setBusy(false);
          }
        }}>
          <Field label="Email"><input className="input" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
          <Field label="Role">
            <select className="select" value={role} onChange={(event) => setRole(event.target.value as "member" | "client")}>
              <option value="client">Client (read-only, chosen sites)</option>
              <option value="member">Member (every site)</option>
            </select>
          </Field>
          {role === "client" && (
            <Field label="Sites">
              <div>{sites.map((option) => (
                <label key={option.id} style={{ display: "block" }}><input type="checkbox" checked={siteIds.includes(option.id)} onChange={(event) => setSiteIds(event.target.checked ? [...siteIds, option.id] : siteIds.filter((id) => id !== option.id))} /> {option.name}</label>
              ))}</div>
            </Field>
          )}
          <Button type="submit" busy={busy}>Invite</Button>
        </form>
      )}
      {link && <div className="callout"><p style={{ margin: 0 }}>Send them this link.</p><CopyBlock code={link} /></div>}
      {error && <div className="callout error" role="alert">{error}</div>}
    </Card>
  );
}
