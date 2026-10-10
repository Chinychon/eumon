"use client";

import { use, useState } from "react";
import { authClient } from "../../components/auth-client";
import { Button } from "../../components/ui";

export default function Invite({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const session = authClient.useSession();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (session.isPending) return null;
  if (!session.data) {
    return (
      <main className="signin">
        <h1>You're invited to Eumon</h1>
        <p>Sign in with the email address the invitation was sent to, then come back to this link.</p>
        <a className="btn btn-primary" href={`/sign-in?next=${encodeURIComponent(`/invite/${id}`)}`}>Sign in</a>
      </main>
    );
  }
  return (
    <main className="signin">
      <h1>Join the workspace</h1>
      <p>Signed in as {session.data.user.email}.</p>
      <Button busy={busy} onClick={async () => {
        setBusy(true); setError("");
        const accepted = await authClient.organization.acceptInvitation({ invitationId: id });
        if (accepted.error) { setBusy(false); setError(accepted.error.message ?? "This invitation can't be accepted. Ask for a new one."); return; }
        await authClient.organization.setActive({ organizationId: accepted.data!.invitation.organizationId });
        window.location.assign("/");
      }}>Accept invitation</Button>
      {error && <p className="callout error" role="alert">{error}</p>}
    </main>
  );
}
