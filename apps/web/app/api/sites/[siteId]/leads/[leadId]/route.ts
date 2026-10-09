import { env } from "cloudflare:workers";
import { LEAD_STATUSES, type LeadStatus } from "@organic-growth/core";
import { getLead, syncLeadOutcomes, updateLead } from "@organic-growth/db";
import { fail, json, readJson } from "../../../../../../src/server";

/** Moves a lead on (chat, qualified, customer, lost), and sets its value or note; the ledger follows at once. */
export async function PATCH(request: Request, context: { params: Promise<{ siteId: string; leadId: string }> }) {
  const { siteId, leadId } = await context.params;
  if (!(await getLead(env.DB, siteId, leadId))) return fail("Lead not found.", 404);
  const body = await readJson<{ status?: unknown; value?: unknown; note?: unknown }>(request);
  if (!body) return fail("Send the change as JSON.");
  if (body.status !== undefined && !LEAD_STATUSES.includes(body.status as LeadStatus)) return fail(`Status must be one of: ${LEAD_STATUSES.join(", ")}.`);
  if (body.value !== undefined && body.value !== null && (typeof body.value !== "number" || !Number.isFinite(body.value) || body.value < 0 || body.value > 1e10)) {
    return fail("Value must be a positive amount in the site's currency, or empty.");
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") return fail("Note must be text.");
  await updateLead(env.DB, siteId, leadId, {
    status: body.status as LeadStatus | undefined,
    value: body.value as number | null | undefined,
    note: body.note === undefined ? undefined : body.note === null ? null : String(body.note).slice(0, 500),
  });
  await syncLeadOutcomes(env.DB, siteId);
  return json({ lead: await getLead(env.DB, siteId, leadId) });
}
