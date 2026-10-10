import { env } from "cloudflare:workers";
import { deleteAssistantThread, getAssistantThread, listAssistantMessages } from "@organic-growth/db";
import { requireSite } from "../../../../../../../src/guard";
import { fail, json } from "../../../../../../../src/server";

type Params = { params: Promise<{ siteId: string; threadId: string }> };

export async function GET(request: Request, context: Params) {
  const { siteId, threadId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const thread = await getAssistantThread(env.DB, siteId, threadId);
  if (!thread) return fail("That conversation no longer exists.", 404);
  return json({ thread, messages: await listAssistantMessages(env.DB, threadId) });
}

export async function DELETE(request: Request, context: Params) {
  const { siteId, threadId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  await deleteAssistantThread(env.DB, siteId, threadId);
  return json({ deleted: true });
}
