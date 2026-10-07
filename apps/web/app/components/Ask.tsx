"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AssistantPart, Block } from "@organic-growth/agents";
import type { SiteRecord } from "@organic-growth/core";
import { api, errorMessage, formatNumber } from "./api";
import { BarList, Funnel, LineChart } from "./charts";
import { Button, CrossIcon, Kpi, ViewHeader } from "./ui";

type Thread = { id: string; title: string; updatedAt: string };
type AnswerTurn = { id: string; role: "assistant"; parts: AssistantPart[]; status?: string; error?: string; live?: boolean };
type Turn = { id: string; role: "user"; text: string } | AnswerTurn;
type StoredMessage = { id: string; role: "user" | "assistant"; content: { text?: string; parts?: AssistantPart[]; error?: string } | null };

const hostname = (site: SiteRecord) => new URL(site.baseUrl).hostname;
const columnName = (column: string) => column.replace(/_/g, " ");
const cell = (value: unknown) => (typeof value === "number" ? formatNumber(value) : value === null || value === undefined || value === "" ? "—" : String(value));

export function ago(iso: string, now = Date.now()) {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return new Date(iso).toLocaleDateString("en", { day: "numeric", month: "short" });
}

/** Server-sent events from a fetch body (EventSource cannot POST). */
async function* serverEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (event && data) yield { event, data: JSON.parse(data) as Record<string, unknown> };
    }
  }
}

const appendText = (parts: AssistantPart[], text: string): AssistantPart[] => {
  const last = parts.at(-1);
  return last?.type === "text" ? [...parts.slice(0, -1), { type: "text", text: last.text + text }] : [...parts, { type: "text", text }];
};

/** **bold** and `code` inside a line of answer text. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((piece, index) => (
    piece.startsWith("**") && piece.endsWith("**") && piece.length > 4 ? <strong key={index}>{piece.slice(2, -2)}</strong>
    : piece.startsWith("`") && piece.endsWith("`") && piece.length > 2 ? <code key={index}>{piece.slice(1, -1)}</code>
    : piece
  ));
}

/** Answer text: paragraphs, "- " lists, bold and code. Nothing from the model becomes HTML. */
function RichText({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  text.split(/\n{2,}/).forEach((block, blockIndex) => {
    let list: string[] = [];
    let lines: string[] = [];
    const flush = (key: string) => {
      if (lines.length) nodes.push(<p key={`p${key}`}>{lines.map((line, index) => <Fragment key={index}>{index > 0 && <br />}{inline(line)}</Fragment>)}</p>);
      if (list.length) nodes.push(<ul key={`u${key}`}>{list.map((item, index) => <li key={index}>{inline(item)}</li>)}</ul>);
      lines = [];
      list = [];
    };
    block.split("\n").forEach((line, lineIndex) => {
      const item = /^\s*[-*•]\s+(.*)$/.exec(line) ?? /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (item) {
        if (lines.length) flush(`${blockIndex}-${lineIndex}`);
        list.push(item[1]!);
      } else if (line.trim()) {
        if (list.length) flush(`${blockIndex}-${lineIndex}`);
        lines.push(line);
      }
    });
    flush(`${blockIndex}-end`);
  });
  return <>{nodes}</>;
}

/** A chart or table the answer drew, from rows a tool returned. */
function BlockView({ block }: { block: Block }) {
  const label = block.label ?? "";
  const value = block.values[0] ?? "";
  const number = (row: Block["rows"][number], column: string) => (typeof row[column] === "number" ? row[column] as number : 0);
  return (
    <figure className="ask-block">
      <figcaption>{block.title}</figcaption>
      {block.kind === "kpis" && (
        <div className="kpi-grid ask-kpis">{block.rows.map((row, index) => <Kpi key={index} label={cell(row[label])} value={cell(row[value])} />)}</div>
      )}
      {block.kind === "bars" && <BarList rows={block.rows.map((row) => ({ label: cell(row[label]), value: number(row, value) }))} />}
      {block.kind === "funnel" && <Funnel steps={block.rows.map((row) => ({ label: cell(row[label]), value: number(row, value) }))} />}
      {block.kind === "line" && (
        <LineChart
          series={block.values}
          points={block.rows.map((row) => ({ x: cell(row[label]), values: block.values.map((column) => (typeof row[column] === "number" ? row[column] as number : null)) }))}
        />
      )}
      {block.kind === "table" && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr>{block.values.map((column) => <th key={column} className={block.rows.some((row) => typeof row[column] === "number") ? "num" : undefined}>{columnName(column)}</th>)}</tr></thead>
            <tbody>{block.rows.map((row, index) => (
              <tr key={index}>{block.values.map((column) => <td key={column} className={typeof row[column] === "number" ? "num" : undefined}>{cell(row[column])}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {block.note && <p className="ask-block-note">{block.note}</p>}
    </figure>
  );
}

/**
 * One Ask Eumon conversation: the transcript, streaming as each answer
 * forms, and the composer. The Ask view and the drawer both use it.
 */
function Conversation({ site, threadId, view, onThread, intro, inDrawer, focusKey }: {
  site: SiteRecord;
  threadId?: string;
  view?: string;
  onThread?: (thread: { id: string; title: string }) => void;
  /** Shown under the composer while the conversation is empty; gets `ask` for suggestion clicks. */
  intro?: (ask: (question: string) => void) => ReactNode;
  inDrawer?: boolean;
  /** Changing it moves focus to the composer (the drawer opening). */
  focusKey?: number;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [thread, setThread] = useState(threadId ?? "");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    setThread(threadId ?? "");
    setTurns([]);
    setLoadError("");
    if (!threadId) return;
    let current = true;
    api<{ messages: StoredMessage[] }>(`/api/sites/${site.id}/assistant/threads/${threadId}`)
      .then((data) => current && setTurns(data.messages.map((message): Turn => (message.role === "user"
        ? { id: message.id, role: "user", text: message.content?.text ?? "" }
        : { id: message.id, role: "assistant", parts: message.content?.parts ?? [], error: message.content?.error }))))
      .catch((cause) => current && setLoadError(errorMessage(cause)));
    return () => { current = false; };
  }, [site.id, threadId]);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { if (focusKey) input.current?.focus(); }, [focusKey]);

  // The drawer follows a streaming answer unless the reader has scrolled up.
  useLayoutEffect(() => {
    const box = log.current;
    if (inDrawer && box && pinned.current) box.scrollTop = box.scrollHeight;
  }, [turns, inDrawer]);

  const update = (change: (turn: AnswerTurn) => AnswerTurn) =>
    setTurns((items) => items.map((item, index) => (index === items.length - 1 && item.role === "assistant" ? change(item) : item)));

  async function ask(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    setDraft("");
    setBusy(true);
    pinned.current = true;
    const stamp = Date.now();
    setTurns((items) => [...items, { id: `q${stamp}`, role: "user", text }, { id: `a${stamp}`, role: "assistant", parts: [], live: true, status: "Thinking" }]);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const response = await fetch(`/api/sites/${site.id}/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, threadId: thread || undefined, view }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(data?.error ?? `The request failed (${response.status}).`);
      }
      for await (const { event, data } of serverEvents(response.body)) {
        if (event === "thread") {
          setThread(String(data.threadId));
          onThread?.({ id: String(data.threadId), title: String(data.title) });
        } else if (event === "status") update((turn) => ({ ...turn, status: String(data.label) }));
        else if (event === "text") update((turn) => ({ ...turn, status: undefined, parts: appendText(turn.parts, String(data.text)) }));
        else if (event === "block") update((turn) => ({ ...turn, status: undefined, parts: [...turn.parts, { type: "block", block: data.block as Block }] }));
        else if (event === "error") update((turn) => ({ ...turn, error: String(data.message) }));
      }
    } catch (cause) {
      update((turn) => ({ ...turn, error: controller.signal.aborted ? "Stopped." : errorMessage(cause) }));
    } finally {
      update((turn) => ({ ...turn, live: false, status: undefined }));
      setBusy(false);
      abort.current = null;
    }
  }

  return (
    <div className={`ask${inDrawer ? " ask-in-drawer" : ""}`}>
      <div className="ask-log" ref={log} onScroll={(event) => {
        const box = event.currentTarget;
        pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
      }}>
        {loadError && <div className="callout error" role="alert">{loadError}</div>}
        {turns.map((turn) => (turn.role === "user"
          ? <h3 key={turn.id} className="ask-question">{turn.text}</h3>
          : (
            <div key={turn.id} className="ask-answer" aria-busy={turn.live || undefined}>
              {turn.parts.map((part, index) => (part.type === "text" ? <RichText key={index} text={part.text} /> : <BlockView key={index} block={part.block} />))}
              {turn.live && <p className="ask-status" role="status">{turn.status ?? "Writing"}</p>}
              {turn.error && <div className={turn.error === "Stopped." ? "ask-stopped" : "callout error"} role={turn.error === "Stopped." ? undefined : "alert"}>{turn.error}</div>}
            </div>
          )))}
      </div>
      <form className="ask-composer" onSubmit={(event) => { event.preventDefault(); void ask(draft); }}>
        <textarea
          ref={input}
          className="textarea"
          rows={inDrawer ? 2 : 3}
          value={draft}
          aria-label="Question"
          placeholder={`Ask about ${hostname(site)}…`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter breaks the line; never mid-composition (IME input for Chinese, Malay, …).
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void ask(draft);
            }
          }}
        />
        <div className="ask-composer-row">
          <span className="ask-hint">Answers use Eumon's data for this site only. Enter to send, Shift+Enter for a new line.</span>
          {busy
            ? <Button variant="secondary" onClick={() => abort.current?.abort()}>Stop</Button>
            : <Button type="submit" disabled={!draft.trim()}>Ask</Button>}
        </div>
      </form>
      {!turns.length && !loadError && intro?.((question) => void ask(question))}
    </div>
  );
}

/** Questions worth asking about this site, from what is connected. */
function suggestionsFor(site: SiteRecord, competitors: string[]) {
  return [
    "What should we fix first?",
    "Which page types have empty HTML?",
    competitors[0] ? `How do we compare with ${competitors[0]}?` : "Which issues did the last crawl find?",
    site.gscProperty ? "Which queries are close to page one?" : "What data do we have for landing pages?",
    "Which landing pages bring enquiries?",
  ];
}

function Suggestions({ site, ask }: { site: SiteRecord; ask: (question: string) => void }) {
  const [competitors, setCompetitors] = useState<string[]>([]);
  useEffect(() => {
    api<{ domains: string[] }>(`/api/sites/${site.id}/competitors`).then((data) => setCompetitors(data.domains)).catch(() => undefined);
  }, [site.id]);
  return (
    <div className="ask-suggestions">
      {suggestionsFor(site, competitors).map((question) => <button key={question} type="button" className="chip" onClick={() => ask(question)}>{question}</button>)}
    </div>
  );
}

/** The Ask view: prompt first, suggested questions, and the site's conversations. */
export function AskView({ site, threadId, onThreadChange }: { site: SiteRecord; threadId: string; onThreadChange: (threadId: string) => void }) {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [error, setError] = useState("");
  // What the conversation loads. It changes only on explicit navigation: a
  // thread the conversation creates itself must not remount it mid-answer.
  const [opened, setOpened] = useState({ threadId, key: 0 });
  const open = (id: string) => {
    setOpened((current) => ({ threadId: id, key: current.key + 1 }));
    onThreadChange(id);
  };

  useEffect(() => {
    api<{ threads: Thread[] }>(`/api/sites/${site.id}/assistant/threads`).then((data) => setThreads(data.threads)).catch((cause) => setError(errorMessage(cause)));
  }, [site.id, threadId]);

  async function remove(thread: Thread) {
    try {
      await api(`/api/sites/${site.id}/assistant/threads/${thread.id}`, { method: "DELETE" });
      setThreads((items) => items?.filter((item) => item.id !== thread.id) ?? null);
      if (thread.id === threadId) open("");
    } catch (cause) { setError(errorMessage(cause)); }
  }


  return (
    <div>
      <ViewHeader
        title="Ask Eumon"
        description={<>Ask anything about {hostname(site)}: the crawl, competitors, search, landing pages, and enquiries. Answers come from Eumon's own data for this site, with charts where the numbers need them.</>}
        actions={threadId ? <Button variant="secondary" onClick={() => open("")}>New conversation</Button> : undefined}
      />
      {error && <div className="callout error" role="alert" style={{ marginBottom: 14 }}>{error}</div>}
      <Conversation
        key={`${site.id}:${opened.key}`}
        site={site}
        threadId={opened.threadId || undefined}
        view="Ask"
        onThread={(thread) => onThreadChange(thread.id)}
        intro={(ask) => (
          <>
            <Suggestions site={site} ask={ask} />
            {threads && threads.length > 0 && (
              <section className="ask-threads" aria-label="Conversations">
                {threads.map((thread, index) => (
                  <div key={thread.id} className="ask-thread">
                    <button type="button" onClick={() => open(thread.id)}>
                      <span>{index === 0 && <strong>Continue your last conversation. </strong>}{thread.title}</span>
                      <small>{ago(thread.updatedAt)}</small>
                    </button>
                    <button type="button" className="ask-thread-delete" aria-label={`Delete "${thread.title}"`} onClick={() => void remove(thread)}><CrossIcon /></button>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      />
    </div>
  );
}

/** Ask Eumon from any view: a side panel that keeps its conversation while it is closed. */
export function AskDrawer({ site, view, open, onClose, onOpenInAsk }: {
  site: SiteRecord;
  view: string;
  open: boolean;
  onClose: () => void;
  onOpenInAsk: (threadId: string) => void;
}) {
  const [threadId, setThreadId] = useState("");
  const [fresh, setFresh] = useState(0);
  const [focus, setFocus] = useState(0);

  useEffect(() => {
    if (!open) return;
    setFocus((value) => value + 1);
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, onClose]);
  useEffect(() => { setThreadId(""); }, [site.id]);

  return (
    <aside className="ask-drawer" hidden={!open} aria-label="Ask Eumon">
      <header className="ask-drawer-head">
        <h2>Ask Eumon</h2>
        <div className="row">
          {threadId && <Button small variant="ghost" onClick={() => onOpenInAsk(threadId)}>Open in Ask</Button>}
          {threadId && <Button small variant="ghost" onClick={() => { setThreadId(""); setFresh((value) => value + 1); }}>New</Button>}
          <button type="button" className="ask-close" aria-label="Close Ask Eumon" onClick={onClose}><CrossIcon /></button>
        </div>
      </header>
      <Conversation
        key={`${site.id}:${fresh}`}
        site={site}
        view={view}
        inDrawer
        focusKey={focus}
        onThread={(thread) => setThreadId(thread.id)}
        intro={(ask) => <Suggestions site={site} ask={ask} />}
      />
    </aside>
  );
}
