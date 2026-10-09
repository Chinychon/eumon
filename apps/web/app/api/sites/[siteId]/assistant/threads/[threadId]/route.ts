import { env } from "cloudflare:workers";
import { deleteAssistantThread, getAssistantThread, listAssistantMessages } from "@organic-growth/db";
import { fail, json } from "../../../../../../../src/server";

type Params = { params: Promise<{ siteId: string; threadId: string }> };

export async function GET(_request: Request, context: Params) {
  const { siteId, threadId } = await context.params;
  const thread = await getAssistantThread(env.DB, siteId, threadId);
  if (!thread) return fail("That conversation no longer exists.", 404);
  return json({ thread, messages: await listAssistantMessages(env.DB, threadId) });
}

export async function DELETE(_request: Request, context: Params) {
  const { siteId, threadId } = await context.params;
  await deleteAssistantThread(env.DB, siteId, threadId);
  return json({ deleted: true });
}
