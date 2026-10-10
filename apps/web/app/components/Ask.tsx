"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { AssistantPart, Block } from "@organic-growth/agents";
import type { SiteRecord } from "@organic-growth/core";
import { api, errorMessage, formatNumber } from "./api";
import { BarList, Funnel, LineChart } from "./charts";
import { Seedling } from "./pixel";
import { ArrowUpIcon, Button, CheckIcon, CrossIcon, Kpi, LeafIcon, StopIcon } from "./ui";

type Thread = { id: string; title: string; updatedAt: string };
type AnswerTurn = { id: string; role: "assistant"; question: string; parts: AssistantPart[]; error?: string; live?: boolean };
type Step = Extract<AssistantPart, { type: "step" }>;
type TracePart = Step | Extract<AssistantPart, { type: "note" }>;
type Turn = { id: string; role: "user"; text: string } | AnswerTurn;
type StoredMessage = { id: string; role: "user" | "assistant"; content: { text?: string; parts?: AssistantPart[]; error?: string } | null };
type Ask = (question: string) => void;

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

/** Runs a layout change as a view transition where supported, so the composer glides from the centre to its dock. */
function glide(update: () => void) {
  const start = (document as Document & { startViewTransition?: (callback: () => void) => unknown }).startViewTransition;
  if (!start || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return update();
  start.call(document, () => flushSync(update));
}

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

const KIND: Record<Block["kind"], string> = { kpis: "Numbers", bars: "Bars", line: "Trends", funnel: "Funnel", table: "Table" };

function RowsTable({ columns, rows }: { columns: string[]; rows: Block["rows"] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>{columns.map((column) => <th key={column} className={rows.some((row) => typeof row[column] === "number") ? "num" : undefined}>{columnName(column)}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => (
          <tr key={index}>{columns.map((column) => <td key={column} className={typeof row[column] === "number" ? "num" : undefined}>{cell(row[column])}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}

/** A chart or table the answer drew, from rows a tool returned: a tile that can show its rows as a table, or fold away. */
function BlockView({ block }: { block: Block }) {
  const [view, setView] = useState<"chart" | "table" | "hidden">("chart");
  const label = block.label ?? "";
  const value = block.values[0] ?? "";
  const number = (row: Block["rows"][number], column: string) => (typeof row[column] === "number" ? row[column] as number : 0);
  const chart = block.kind !== "table" && view === "chart";
  return (
    <figure className={`ask-tile${view === "hidden" ? " folded" : ""}`}>
      <figcaption className="ask-tile-head">
        <span className="ask-tile-kind">{KIND[block.kind]}</span>
        <span className="ask-tile-title">{block.title}</span>
        <span className="ask-tile-actions">
          {block.kind !== "table" && view !== "hidden" && <button type="button" onClick={() => setView(view === "table" ? "chart" : "table")}>{view === "table" ? "Chart" : "Rows"}</button>}
          <button type="button" aria-expanded={view !== "hidden"} onClick={() => setView(view === "hidden" ? "chart" : "hidden")}>{view === "hidden" ? "Show" : "Hide"}</button>
        </span>
      </figcaption>
      {view !== "hidden" && <div className="ask-tile-body">
      {view === "table" && <RowsTable columns={[label, ...block.values]} rows={block.rows} />}
      {chart && block.kind === "kpis" && (
        <div className="kpi-grid ask-kpis">{block.rows.map((row, index) => <Kpi key={index} label={cell(row[label])} value={cell(row[value])} />)}</div>
      )}
      {chart && block.kind === "bars" && <BarList rows={block.rows.map((row) => ({ label: cell(row[label]), value: number(row, value) }))} />}
      {chart && block.kind === "funnel" && <Funnel steps={block.rows.map((row) => ({ label: cell(row[label]), value: number(row, value) }))} />}
      {chart && block.kind === "line" && (
        <LineChart
          series={block.values}
          points={block.rows.map((row) => ({ x: cell(row[label]), values: block.values.map((column) => (typeof row[column] === "number" ? row[column] as number : null)) }))}
        />
      )}
      {block.kind === "table" && <RowsTable columns={block.values} rows={block.rows} />}
      {block.note && <p className="ask-block-note">{block.note}</p>}
      </div>}
    </figure>
  );
}

const StepIcon = ({ step }: { step: Step }) => (
  <span className={`ask-step-icon${step.summary === undefined ? " running" : step.failed ? " failed" : ""}`} aria-hidden="true">
    {step.summary === undefined ? null : step.failed ? <CrossIcon /> : <CheckIcon />}
  </span>
);

/** What the answer read and noted on the way, one row per step; folded into "N steps" once the answer is done. */
function Trace({ parts, live }: { parts: TracePart[]; live: boolean }) {
  const steps = parts.filter((part) => part.type === "step").length;
  const rows = (
    <ol className="ask-trace-rows">
      {parts.map((part, index) => (part.type === "note"
        ? <li key={index} className="ask-note">{inline(part.text)}</li>
        : (
          <li key={part.id} className="ask-step" title={part.summary}>
            <StepIcon step={part} />
            <span className="ask-step-label">{part.label}</span>
            {part.summary && <span className="ask-step-summary">{part.summary}</span>}
          </li>
        )))}
    </ol>
  );
  if (live) return <div className="ask-trace">{rows}</div>;
  return (
    <details className="ask-trace">
      <summary><span className="ask-step-icon"><CheckIcon /></span>{steps ? `${steps} ${steps === 1 ? "step" : "steps"}` : "Notes"}</summary>
      {rows}
    </details>
  );
}

/** An answer's parts in order, with each run of steps and notes drawn as one trace. */
function AnswerParts({ parts, live }: { parts: AssistantPart[]; live: boolean }) {
  const nodes: ReactNode[] = [];
  let trace: TracePart[] = [];
  const close = (key: string, last: boolean) => {
    if (trace.length) nodes.push(<Trace key={`t${key}`} parts={trace} live={live && last} />);
    trace = [];
  };
  parts.forEach((part, index) => {
    if (part.type === "step" || part.type === "note") return void trace.push(part);
    close(String(index), false);
    nodes.push(part.type === "text" ? <RichText key={index} text={part.text} /> : <BlockView key={index} block={part.block} />);
  });
  close("end", true);
  return <>{nodes}</>;
}

/** Three questions worth asking from where the user is. */
function suggestionsFor(site: SiteRecord, view: string | undefined, competitors: string[]) {
  if (view === "Data") return ["What data do we have for landing pages?", "Which datasets have the most records?", "Which page types have empty HTML?"];
  if (view === "Landing pages" || view === "Page results") {
    return ["Which landing pages bring enquiries?", "How have landing page views changed this month?", site.gscProperty ? "Which queries are close to page one?" : "What changed after the last page edits?"];
  }
  if (view === "Search" || view === "Enquiries") return [site.gscProperty ? "Which queries are close to page one?" : "How do I connect Search Console?", "How have Google clicks changed since the last month?", "Which pages bring enquiries?"];
  if (view === "Keywords") return ["Which keyword gaps are worth a page?", "Which of our keywords are closest to the top 3?", competitors[0] ? `Which searches does ${competitors[0]} win that we don't?` : "Which searches are worth the most to us?"];
  if (view === "AI visibility") return ["Which AI assistants read our pages most?", "How many visits came from ChatGPT this month?", "Are we blocking any AI crawlers?"];
  if (view === "Competitors") return [competitors[0] ? `How do we compare with ${competitors[0]}?` : "Who are our competitors in search?", "What kinds of pages do competitors publish that we don't?", "Where do we lead our competitors?"];
  return ["What should we fix first?", "Which page types have empty HTML?", competitors[0] ? `How do we compare with ${competitors[0]}?` : "Which issues did the last crawl find?"];
}

function Suggestions({ site, view, ask }: { site: SiteRecord; view?: string; ask: Ask }) {
  const [competitors, setCompetitors] = useState<string[]>([]);
  useEffect(() => {
    api<{ domains: string[] }>(`/api/sites/${site.id}/competitors`).then((data) => setCompetitors(data.domains)).catch(() => undefined);
  }, [site.id]);
  return (
    <div className="ask-chips">
      {suggestionsFor(site, view, competitors).map((question) => (
        <button key={question} type="button" className="ask-chip" onClick={() => ask(question)}><LeafIcon />{question}</button>
      ))}
    </div>
  );
}

/**
 * One Ask Eumon conversation. Empty, it shows `start` around the composer
 * (the centred home, or the drawer's intro); once a question is asked it is a
 * transcript with the composer docked below, and the composer glides there.
 */
function Conversation({ site, threadId, view, onThread, inDrawer, focusKey, start, header }: {
  site: SiteRecord;
  threadId?: string;
  view?: string;
  onThread?: (thread: { id: string; title: string }) => void;
  inDrawer?: boolean;
  /** Changing it moves focus to the composer (the drawer opening). */
  focusKey?: number;
  start: (composer: ReactNode, ask: Ask) => ReactNode;
  header?: ReactNode;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [thread, setThread] = useState(threadId ?? "");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    setThread(threadId ?? "");
    setTurns([]);
    setLoadError("");
    if (!threadId) return;
    let current = true;
    api<{ messages: StoredMessage[] }>(`/api/sites/${site.id}/assistant/threads/${threadId}`)
      .then((data) => {
        if (!current) return;
        let question = "";
        setTurns(data.messages.map((message): Turn => {
          if (message.role === "user") {
            question = message.content?.text ?? "";
            return { id: message.id, role: "user", text: question };
          }
          return { id: message.id, role: "assistant", question, parts: message.content?.parts ?? [], error: message.content?.error };
        }));
      })
      .catch((cause) => current && setLoadError(errorMessage(cause)));
    return () => { current = false; };
  }, [site.id, threadId]);

  useEffect(() => { if (focusKey) input.current?.focus(); }, [focusKey]);

  // Follow a streaming answer unless the reader has scrolled up to read.
  useEffect(() => {
    if (inDrawer) return;
    const track = () => { pinned.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160; };
    window.addEventListener("scroll", track, { passive: true });
    return () => window.removeEventListener("scroll", track);
  }, [inDrawer]);
  useLayoutEffect(() => {
    if (!pinned.current || !turns.length) return;
    if (inDrawer && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    else if (!inDrawer) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [turns, inDrawer]);

  const update = (change: (turn: AnswerTurn) => AnswerTurn) =>
    setTurns((items) => items.map((item, index) => (index === items.length - 1 && item.role === "assistant" ? change(item) : item)));

  // A conversation keeps going if the user leaves it: the server finishes and saves the answer.
  async function ask(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    setDraft("");
    setBusy(true);
    setAnnouncement("");
    pinned.current = true;
    const stamp = Date.now();
    const add = () => setTurns((items) => [...items, { id: `q${stamp}`, role: "user", text }, { id: `a${stamp}`, role: "assistant", question: text, parts: [], live: true }]);
    if (!turns.length && !inDrawer) glide(add);
    else add();
    const controller = new AbortController();
    abort.current = controller;
    let failed = false;
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
        } else if (event === "step") {
          const step = data as unknown as Step;
          update((turn) => {
            const at = turn.parts.findIndex((part) => part.type === "step" && part.id === step.id);
            return { ...turn, parts: at >= 0 ? turn.parts.map((part, index) => (index === at ? step : part)) : [...turn.parts, step] };
          });
        } else if (event === "note") update((turn) => ({ ...turn, parts: [...turn.parts, { type: "note", text: String(data.text) }] }));
        else if (event === "text") update((turn) => ({ ...turn, parts: appendText(turn.parts, String(data.text)) }));
        else if (event === "block") update((turn) => ({ ...turn, parts: [...turn.parts, { type: "block", block: data.block as Block }] }));
        else if (event === "error") { failed = true; update((turn) => ({ ...turn, error: String(data.message) })); }
      }
    } catch (cause) {
      failed = true;
      update((turn) => ({ ...turn, error: controller.signal.aborted ? "Stopped." : errorMessage(cause) }));
    } finally {
      update((turn) => ({ ...turn, live: false }));
      setBusy(false);
      abort.current = null;
      if (!failed) setAnnouncement("Answer ready.");
    }
  }

  const composer = (
    <form className="ask-composer" onSubmit={(event) => { event.preventDefault(); void ask(draft); }}>
      <textarea
        ref={input}
        rows={1}
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
      {busy
        ? <button type="button" className="ask-send stop" aria-label="Stop the answer" onClick={() => abort.current?.abort()}><StopIcon /></button>
        : <button type="submit" className="ask-send" aria-label="Ask" disabled={!draft.trim()}><ArrowUpIcon /></button>}
    </form>
  );

  const Question = inDrawer ? "h3" : "h2";
  return (
    <div className={`ask${inDrawer ? " ask-in-drawer" : ""}`}>
      <p className="sr-only" aria-live="polite">{announcement}</p>
      {!turns.length && !threadId && !loadError ? start(composer, (question) => void ask(question)) : (
        <>
          {header}
          <div className="ask-scroll" ref={scroller} onScroll={(event) => {
            const box = event.currentTarget;
            pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
          }}>
            <div className="ask-conversation">
              {!inDrawer && <h1 className="sr-only">Ask Eumon</h1>}
              {loadError && <div className="callout error" role="alert">{loadError}</div>}
              <div className="ask-log">
                {turns.map((turn) => (turn.role === "user"
                  ? <Question key={turn.id} className="ask-question">{turn.text}</Question>
                  : (
                    <div key={turn.id} className="ask-answer" aria-busy={turn.live || undefined}>
                      <AnswerParts parts={turn.parts} live={Boolean(turn.live)} />
                      {turn.live && !(turn.parts.at(-1)?.type === "step" && (turn.parts.at(-1) as Step).summary === undefined) && (
                        <p className="ask-status" role="status">
                          <Seedling growing scale={2} />
                          <span className="ask-status-text">{turn.parts.at(-1)?.type === "text" ? "Writing" : "Thinking"}</span>
                        </p>
                      )}
                      {turn.error && (turn.error === "Stopped."
                        ? <p className="ask-stopped">Stopped</p>
                        : <div className="callout error" role="alert">{turn.error}</div>)}
                      {turn.error && !busy && <Button small variant="secondary" className="ask-retry" onClick={() => void ask(turn.question)}>Ask again</Button>}
                    </div>
                  )))}
              </div>
            </div>
          </div>
          <div className="ask-dock">
            <div className="ask-conversation">
              {composer}
              <p className="ask-hint">Enter to send · Shift+Enter for a new line · answers use this site's data only</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** The last few conversations, quietly; the rest one click away, deletion confirmed. */
function Recent({ threads, onOpen, onDelete }: { threads: Thread[]; onOpen: (id: string) => void; onDelete: (thread: Thread) => void }) {
  const [all, setAll] = useState(false);
  const [confirming, setConfirming] = useState("");
  if (!threads.length) return null;
  return (
    <section className="ask-recent" aria-label="Recent conversations">
      {(all ? threads : threads.slice(0, 3)).map((thread) => (
        <div key={thread.id} className="ask-recent-row">
          {confirming === thread.id ? (
            <div className="ask-recent-confirm">
              <span>Delete this conversation?</span>
              <Button small variant="danger" onClick={() => onDelete(thread)}>Delete</Button>
              <Button small variant="ghost" onClick={() => setConfirming("")}>Keep</Button>
            </div>
          ) : (
            <>
              <button type="button" onClick={() => onOpen(thread.id)}><span>{thread.title}</span><small>{ago(thread.updatedAt)}</small></button>
              <button type="button" className="ask-recent-delete" aria-label={`Delete "${thread.title}"`} onClick={() => setConfirming(thread.id)}><CrossIcon /></button>
            </>
          )}
        </div>
      ))}
      {threads.length > 3 && (
        <Button small variant="ghost" className="ask-recent-more" onClick={() => setAll((value) => !value)}>
          {all ? "Show fewer" : `Show all ${threads.length} conversations`}
        </Button>
      )}
    </section>
  );
}

/** The Ask view: a calm, centred start, and the site's conversations kept a step back. */
export function AskView({ site, threadId, onThreadChange }: { site: SiteRecord; threadId: string; onThreadChange: (threadId: string) => void }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  // What the conversation loads. It changes only on explicit navigation: a
  // thread the conversation creates itself must not remount it mid-answer.
  const [opened, setOpened] = useState({ threadId, key: 0 });
  const open = (id: string) => {
    setOpened((current) => ({ threadId: id, key: current.key + 1 }));
    setTitle("");
    onThreadChange(id);
  };

  useEffect(() => {
    api<{ threads: Thread[] }>(`/api/sites/${site.id}/assistant/threads`).then((data) => setThreads(data.threads)).catch((cause) => setError(errorMessage(cause)));
  }, [site.id, threadId]);

  async function remove(thread: Thread) {
    try {
      await api(`/api/sites/${site.id}/assistant/threads/${thread.id}`, { method: "DELETE" });
      setThreads((items) => items.filter((item) => item.id !== thread.id));
      if (thread.id === threadId) open("");
    } catch (cause) { setError(errorMessage(cause)); }
  }

  const heading = title || threads.find((thread) => thread.id === threadId)?.title || "";
  return (
    <div>
      {error && <div className="callout error" role="alert" style={{ marginBottom: 14 }}>{error}</div>}
      <Conversation
        key={`${site.id}:${opened.key}`}
        site={site}
        threadId={opened.threadId || undefined}
        view="Ask"
        onThread={(thread) => { setTitle(thread.title); onThreadChange(thread.id); }}
        header={(
          <div className="ask-thread-head ask-conversation">
            <Button small variant="secondary" onClick={() => open("")}>New conversation</Button>
            <p title={heading}>{heading}</p>
          </div>
        )}
        start={(composer, ask) => (
          <div className="ask-home">
            <Seedling className="ask-seedling" scale={6} />
            <h1 className="ask-greeting">What would you like to know about {hostname(site)}?</h1>
            {composer}
            <Suggestions site={site} view="Ask" ask={ask} />
            <Recent threads={threads} onOpen={open} onDelete={(thread) => void remove(thread)} />
          </div>
        )}
      />
    </div>
  );
}

/** Ask Eumon from any view: a side panel that keeps its conversation while it is closed. */
export function AskDrawer({ site, view, open, modal, onClose, onOpenInAsk }: {
  site: SiteRecord;
  view: string;
  open: boolean;
  /** On phones the drawer covers the page and behaves as a modal dialog. */
  modal?: boolean;
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
    <aside className="ask-drawer" hidden={!open} role={modal ? "dialog" : "complementary"} aria-modal={modal || undefined} aria-label="Ask Eumon">
      <header className="ask-drawer-head">
        <h2><Seedling scale={1} />Ask Eumon</h2>
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
        start={(composer, ask) => (
          <>
            <div className="ask-scroll">
              <div className="ask-drawer-intro">
                <Seedling scale={3} />
                <p>What would you like to know about {hostname(site)}?</p>
                <Suggestions site={site} view={view} ask={ask} />
              </div>
            </div>
            <div className="ask-dock">{composer}</div>
          </>
        )}
      />
    </aside>
  );
}
