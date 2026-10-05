import { env } from "cloudflare:workers";
import { createId, type ConversionEventName } from "@organic-growth/core";
import { getSite, insertConversionEvent } from "@organic-growth/db";

const events = new Set<ConversionEventName>([
  "page_view", "cta_click", "whatsapp_click", "phone_click", "email_click", "form_start", "form_submit",
  "booking_start", "booking_complete", "lead_created", "lead_qualified", "customer_created",
]);

async function allowedSite(siteId: string, origin: string | null) {
  const site = await getSite(env.DB, siteId);
  if (!site || !origin) return null;
  try { return new URL(site.baseUrl).origin === new URL(origin).origin ? site : null; } catch { return null; }
}

export async function OPTIONS(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await allowedSite(siteId, request.headers.get("Origin"));
  if (!site) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: {
    "Access-Control-Allow-Origin": new URL(site.baseUrl).origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  } });
}

export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await allowedSite(siteId, request.headers.get("Origin"));
  if (!site) return Response.json({ error: "Event origin does not match the connected website." }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: "Send a valid event payload." }, { status: 400 });
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > 4096) { await reader.cancel(); return Response.json({ error: "Event payload is too large." }, { status: 413 }); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch { return Response.json({ error: "Send a valid event payload." }, { status: 400 }); }
  if (typeof body.event !== "string" || !events.has(body.event as ConversionEventName)) return Response.json({ error: "Unsupported conversion event." }, { status: 400 });
  let pageUrl: string | undefined;
  if (typeof body.pageUrl === "string") {
    try {
      const parsed = new URL(body.pageUrl);
      if (parsed.origin !== new URL(site.baseUrl).origin) return Response.json({ error: "Page URL must belong to the connected site." }, { status: 400 });
      pageUrl = `${parsed.origin}${parsed.pathname}`.slice(0, 2048);
    } catch { return Response.json({ error: "Page URL is invalid." }, { status: 400 }); }
  }
  const destination = typeof body.destination === "string" ? body.destination.slice(0, 120) : undefined;
  const sessionId = typeof body.sessionId === "string" && /^[a-zA-Z0-9_-]{16,64}$/.test(body.sessionId) ? body.sessionId : undefined;
  await insertConversionEvent(env.DB, { id: createId("event"), siteId, event: body.event, destination, pageUrl, sessionId, occurredAt: new Date().toISOString() });
  return Response.json({ accepted: true }, { status: 202, headers: { "Access-Control-Allow-Origin": new URL(site.baseUrl).origin, "Vary": "Origin" } });
}
