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
  proposed: "amber", draft: "amber", queued: "amber", running: "green", pending: "amber",
  thin: "red", duplicate: "red", failed: "red", rejected: "red", blocked: "red",
  unpublished: "gray", retired: "gray", archived: "gray",
};

/** Colour for a status word (published, thin, failed, …). */
export const toneFor = (status: string) => BADGE_TONE[status] ?? "gray";

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  const key = tone ?? (typeof children === "string" ? BADGE_TONE[children] : undefined) ?? "gray";
  return <span className={`badge badge-${key}`}>{children}</span>;
}

type ThemeChoice = "system" | "light" | "dark";
const icon = (path: React.ReactNode) => <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">{path}</svg>;
const THEMES: Array<{ value: ThemeChoice; label: string; icon: React.ReactNode }> = [
  { value: "system", label: "Match this device", icon: icon(<><rect x="1.5" y="2" width="11" height="7.5" rx="1.5" /><path d="M5 12.5h4M7 9.5v3" /></>) },
  { value: "light", label: "Light", icon: icon(<><circle cx="7" cy="7" r="2.6" /><path d="M7 1v1.4M7 11.6V13M1 7h1.4M11.6 7H13M2.8 2.8l1 1M10.2 10.2l1 1M2.8 11.2l1-1M10.2 3.8l1-1" /></>) },
  { value: "dark", label: "Dark", icon: icon(<path d="M11.8 8.6A5 5 0 0 1 5.4 2.2 5 5 0 1 0 11.8 8.6Z" />) },
];

/** Light, dark, or the device's choice; saved per browser, applied with a cross-fade. */
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  useEffect(() => {
    try { setChoice((localStorage.getItem("eumon-theme") as ThemeChoice | null) ?? "system"); } catch { /* storage may be blocked; follow the device */ }
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const next = choice === "system" ? (media.matches ? "dark" : "light") : choice;
      if (document.documentElement.dataset.theme === next) return;
      const swap = () => { document.documentElement.dataset.theme = next; };
      const transition = (document as Document & { startViewTransition?: (update: () => void) => unknown }).startViewTransition;
      if (transition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) transition.call(document, swap);
      else swap();
    };
    apply();
    if (choice !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [choice]);
  const pick = (next: ThemeChoice) => {
    setChoice(next);
    try { if (next === "system") localStorage.removeItem("eumon-theme"); else localStorage.setItem("eumon-theme", next); } catch { /* the choice still applies to this visit */ }
  };
  return (
    <div className="theme-toggle" role="group" aria-label="Appearance">
      {THEMES.map((theme) => (
        <button key={theme.value} type="button" aria-pressed={choice === theme.value} aria-label={theme.label} title={theme.label} onClick={() => pick(theme.value)}>{theme.icon}</button>
      ))}
    </div>
  );
}

/** Eases a number toward its new value, so counts climb instead of jumping between polls. */
export function useTweened(target: number, ms = 900) {
  const [value, setValue] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    const origin = current.current;
    if (origin === target || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      current.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / ms);
      current.current = origin + (target - origin) * (1 - (1 - progress) ** 3);
      setValue(current.current);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return Math.round(value);
}

/** Drawn icons in one stroke weight; text glyphs never stand in for them. */
export const CheckIcon = () => <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 5.2 4 7.7 8.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
export const ArrowUpIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.5M3.8 7.6 8 3.4l4.2 4.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
export const StopIcon = () => <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" fill="currentColor" /></svg>;
export const LeafIcon = () => <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 10.5C2 5 5.5 2 10.5 1.5 10.5 7 7 10.5 2 10.5ZM2 10.5 6.5 6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
export const CrossIcon = () => <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2 2 8" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>;

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

/** A titled part of a longer view, such as Connections and On your site within Setup. */
export function PartHead({ id, title, description }: { id: string; title: string; description?: ReactNode }) {
  return (
    <div className="part-head" id={id}>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
    </div>
  );
}

export function ViewHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="view-header">
      <div>
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
  return <div className="progress" role="progressbar" aria-valuenow={width} aria-valuemin={0} aria-valuemax={100}><i style={{ transform: `scaleX(${width / 100})` }} /></div>;
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
        }}>{copied ? "Copied" : "Copy"}</Button>
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
