import { env } from "cloudflare:workers";
import { deleteRecord } from "@organic-growth/db";
import { json } from "../../../../src/server";
import { requireOwned } from "../../../../src/guard";

export async function DELETE(request: Request, context: { params: Promise<{ recordId: string }> }) {
  const { recordId } = await context.params;
  const access = await requireOwned(request, "record", recordId, "write");
  if (access instanceof Response) return access;
  await deleteRecord(env.DB, recordId);
  return json({ deleted: true });
}
