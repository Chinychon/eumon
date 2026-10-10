import { env } from "cloudflare:workers";
import { countOpenFixes, getFixSettings, listFixes, setFixSettings, type D1Like } from "@organic-growth/db";
import { parseFixSettings } from "../../../../../src/fix-run";
import { requireSite } from "../../../../../src/guard";
import { fail } from "../../../../../src/server";
import { fixView } from "../../../../../src/fix-view";

type Ctx = { params: Promise<{ siteId: string }> };

export async function GET(request: Request, context: Ctx) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "read");
  if (access instanceof Response) return access;
  const db = env.DB as D1Like;
  const fixes = (await listFixes(db, siteId)).map(fixView);
  return Response.json({ fixes, settings: await getFixSettings(db, siteId), open: await countOpenFixes(db, siteId) });
}

export async function PUT(request: Request, context: Ctx) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const settings = parseFixSettings(await request.json().catch(() => null));
  if (typeof settings === "string") return fail(settings, 400);
  await setFixSettings(env.DB as D1Like, siteId, settings);
  return Response.json({ settings });
}
