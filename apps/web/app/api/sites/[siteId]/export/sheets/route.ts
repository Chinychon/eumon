import { env } from "cloudflare:workers";
import { createSpreadsheet, type SheetTable } from "@organic-growth/agents";
import { getSite } from "@organic-growth/db";
import { DRIVE_FILE_SCOPE } from "../../../../../../src/gsc-auth";
import { googleAccess } from "../../../../../../src/results-access";
import { fail, json, readJson } from "../../../../../../src/server";

/** Big enough for any report, small enough to stay one quick request. */
const MAX_CELLS = 200_000;

/** Creates a Google Sheet from an export, with the site's Google connection; 403 when it lacks the Sheets permission. */
export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return fail("Site not found.", 404);
  const body = await readJson<{ title?: unknown; sheets?: unknown }>(request, 8_000_000);
  const sheets = Array.isArray(body?.sheets) ? (body!.sheets as SheetTable[]).filter((sheet) => sheet && typeof sheet.name === "string" && Array.isArray(sheet.columns) && Array.isArray(sheet.rows)) : [];
  if (!sheets.length || sheets.length > 40) return fail("Send between 1 and 40 tables.", 400);
  const cells = sheets.reduce((total, sheet) => total + (sheet.rows.length + 1) * sheet.columns.length, 0);
  if (cells > MAX_CELLS) return fail("That export is too large for one Google Sheet; download it as Excel instead.", 413);
  let access: { token: string; scopes: string[] };
  try {
    access = await googleAccess(env, siteId).connect();
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Connect Google first.", 403);
  }
  if (!access.scopes.includes(DRIVE_FILE_SCOPE)) return fail("Reconnect Google in Setup to allow creating Google Sheets.", 403);
  const title = typeof body?.title === "string" && body.title.trim() ? body.title.slice(0, 200) : "Eumon export";
  try {
    return json({ url: await createSpreadsheet(access.token, title, sheets) });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Google Sheets failed.", 502);
  }
}
