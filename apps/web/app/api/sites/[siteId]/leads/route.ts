import { env } from "cloudflare:workers";
import { createId, findRef } from "@organic-growth/core";
import { createLead, getLead, getLeadByRef, getSite, listLeads, syncLeadOutcomes } from "@organic-growth/db";
import { fail, json, readJson, settingsFor } from "../../../../../src/server";

type Context = { params: Promise<{ siteId: string }> };

/**
 * The site's leads. `?find=` takes a code, or a whole pasted message with
 * "(ref K7M2Q)" in it, and returns that lead; otherwise the latest 50
 * (`?open=1` for those not yet won or lost).
 */
export async function GET(request: Request, context: Context) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  const params = new URL(request.url).searchParams;
  const find = params.get("find");
  if (find !== null) {
    const ref = findRef(find);
    if (!ref) return fail("No reference code found: it is five letters and digits, as in “(ref K7M2Q)”.");
    const lead = await getLeadByRef(env.DB, siteId, ref);
    return lead ? json({ lead }) : fail(`No WhatsApp click with the code ${ref}. It may have come from a page without Eumon's tracking.`, 404);
  }
  const [leads, settings] = await Promise.all([listLeads(env.DB, siteId, { limit: 50, open: params.get("open") === "1" }), settingsFor(site)]);
  return json({ leads, currency: settings.currency ?? null });
}

const CHANNELS = new Set(["whatsapp", "phone", "email", "form", "walk-in", "other"]);

/** An enquiry without a code, entered by hand: it starts as a chat. */
export async function POST(request: Request, context: Context) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return fail("Site not found.", 404);
  const body = await readJson<{ channel?: unknown; note?: unknown }>(request);
  const channel = typeof body?.channel === "string" && CHANNELS.has(body.channel) ? body.channel : null;
  if (!channel) return fail(`Choose a channel: ${[...CHANNELS].join(", ")}.`);
  const id = createId("lead");
  await createLead(env.DB, { id, siteId, channel, note: typeof body?.note === "string" ? body.note.slice(0, 500) : undefined, at: new Date().toISOString() });
  await syncLeadOutcomes(env.DB, siteId);
  return json({ lead: await getLead(env.DB, siteId, id) }, 201);
}
