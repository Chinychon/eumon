"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export function Button({ children, busy, variant = "primary", small, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  small?: boolean;
}) {
  return (
    <button type="button" {...props} disabled={props.disabled || busy} className={`btn btn-${variant}${small ? " btn-small" : ""} ${props.className ?? ""}`}>
      {busy && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

const BADGE_TONE: Record<string, string> = {
  published: "green", active: "green", approved: "green", completed: "green", live: "green",
  proposed: "amber", draft: "amber", queued: "amber", running: "blue", pending: "amber",
  thin: "red", duplicate: "red", failed: "red", rejected: "red", blocked: "red",
  unpublished: "gray", retired: "gray", archived: "gray",
};

/** Colour for a status word (published, thin, failed, …). */
export const toneFor = (status: string) => BADGE_TONE[status] ?? "gray";

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  const key = tone ?? (typeof children === "string" ? BADGE_TONE[children] : undefined) ?? "gray";
  return <span className={`badge badge-${key}`}>{children}</span>;
}

export function Card({ title, subtitle, actions, children, id }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode; id?: string }) {
  return (
    <section className="card" id={id}>
      {(title || actions) && (
        <div className="card-header">
          <div className="grow">
            {title && <h2>{title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function ViewHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="view-header">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Kpi({ label, value, caption }: { label: string; value: ReactNode; caption?: ReactNode }) {
  return (
    <div className="kpi">
      <span>{label}</span>
      <strong>{value}</strong>
      {caption && <small>{caption}</small>}
    </div>
  );
}

export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`field${wide ? " span-2" : ""}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Progress({ done, total }: { done: number; total: number }) {
  const width = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return <div className="progress" role="progressbar" aria-valuenow={width} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${width}%` }} /></div>;
}

export function CopyBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="row spread" style={{ marginBottom: 6 }}>
        <span />
        <Button small variant="ghost" onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          } catch { /* clipboard may be unavailable; the code stays selectable */ }
        }}>{copied ? "Copied ✓" : "Copy"}</Button>
      </div>
      <pre className="code">{code}</pre>
    </div>
  );
}

/** Calls `tick` every `ms` while `active`; stops on unmount. */
export function usePolling(active: boolean, tick: () => Promise<boolean | void>, ms = 2500) {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const run = async () => {
      while (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, ms));
        if (stopped) return;
        try {
          if ((await latest.current()) === false) return;
        } catch {
          return;
        }
      }
    };
    void run();
    return () => { stopped = true; };
  }, [active, ms]);
}
