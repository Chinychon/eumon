import { env } from "cloudflare:workers";
import { deleteRecord } from "@organic-growth/db";
import { json } from "../../../../src/server";

export async function DELETE(_request: Request, context: { params: Promise<{ recordId: string }> }) {
  const { recordId } = await context.params;
  await deleteRecord(env.DB, recordId);
  return json({ deleted: true });
}
