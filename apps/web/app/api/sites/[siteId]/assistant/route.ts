import { env, waitUntil } from "cloudflare:workers";
import { describeModelError, LlmError, type LlmEnv } from "@organic-growth/ai";
import { historyMessages, runAssistantTurn } from "@organic-growth/agents";
import { createId } from "@organic-growth/core";
import { appendAssistantMessage, createAssistantThread, getAssistantThread, getSite, listAssistantMessages } from "@organic-growth/db";
import { fail, readJson } from "../../../../../src/server";

/**
 * Answers one Ask Eumon question as server-sent events: `thread` first, then
 * `status`, `text`, and `block` as the answer forms, `error` if it fails, and
 * `done`. The question and the answer (or as much as was said) are saved to
 * the conversation, even when the browser goes away mid-answer.
 */
export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  const body = await readJson<{ message?: unknown; threadId?: unknown; view?: unknown }>(request);
  const question = typeof body?.message === "string" ? body.message.trim().slice(0, 4000) : "";
  if (!question) return fail("Ask a question first.");
  const view = typeof body?.view === "string" ? body.view.slice(0, 40) : undefined;
  let thread = typeof body?.threadId === "string" && body.threadId ? await getAssistantThread(env.DB, siteId, body.threadId) : null;
  if (body?.threadId && !thread) return fail("That conversation no longer exists.", 404);
  const history = thread ? historyMessages(await listAssistantMessages(env.DB, thread.id)) : [];
  thread ??= await createAssistantThread(env.DB, { id: createId("thread"), siteId, title: question.replace(/\s+/g, " ").slice(0, 300) });
  await appendAssistantMessage(env.DB, { id: createId("msg"), threadId: thread.id, role: "user", content: { text: question } });

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (event: string, data: unknown) => {
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => undefined);
  };
  const threadId = thread.id;
  send("thread", { threadId, title: thread.title });

  waitUntil((async () => {
    const turn = await runAssistantTurn({
      env: env as unknown as LlmEnv, db: env.DB, site, history, question, view, signal: request.signal,
      emit: (event) => send(event.type, event),
    });
    const error = turn.error === undefined ? undefined
      : request.signal.aborted ? "Stopped."
      : turn.error instanceof LlmError ? turn.error.message
      : describeModelError(turn.error);
    if (error) send("error", { message: error });
    await appendAssistantMessage(env.DB, { id: createId("msg"), threadId, role: "assistant", content: { parts: turn.parts, tools: turn.tools, ...(error ? { error } : {}) } });
    send("done", {});
    await writer.close().catch(() => undefined);
  })());

  return new Response(readable, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" } });
}
