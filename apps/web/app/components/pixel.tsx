"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatNumber } from "./api";

/*
 * Hand-placed pixel art, drawn in code so it stays crisp at any size and
 * follows the theme: each character is a palette slot backed by a CSS
 * variable. "." is transparent.
 */
const PALETTE: Record<string, string> = {
  g: "var(--px-leaf)", G: "var(--px-leaf-2)", s: "var(--px-stem)", d: "var(--px-soil)", D: "var(--px-soil-2)",
  b: "var(--px-seed)", o: "var(--px-pot)", O: "var(--px-pot-2)", p: "var(--px-bloom)", y: "var(--px-bloom-2)",
  w: "var(--on-primary)",
};

/** Draws a sprite as one SVG rect per horizontal run of a colour. */
export function PixelArt({ rows, scale = 2, label, className }: { rows: string[]; scale?: number; label?: string; className?: string }) {
  const width = rows[0]?.length ?? 0;
  const rects: Array<{ x: number; y: number; w: number; fill: string }> = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const key = row[x]!;
      let end = x + 1;
      while (end < row.length && row[end] === key) end++;
      if (key !== ".") rects.push({ x, y, w: end - x, fill: PALETTE[key] ?? "currentColor" });
      x = end;
    }
  });
  return (
    <svg
      className={`pixel${className ? ` ${className}` : ""}`}
      width={width * scale}
      height={rows.length * scale}
      viewBox={`0 0 ${width} ${rows.length}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {rects.map((rect, index) => <rect key={index} x={rect.x} y={rect.y} width={rect.w} height={1} fill={rect.fill} />)}
    </svg>
  );
}

const POT = [
  "....dDddddDd....",
  "...oooooooooo...",
  "....ooooooOO....",
  "....ooooooOO....",
  ".....ooooOO.....",
];
const plant = (...rows: string[]) => [...Array.from({ length: 10 - rows.length }, () => "................"), ...rows, ...POT];

/** A seedling in a pot, from seed to bloom. */
export const SEEDLING = {
  seed: plant(".......bb......."),
  sprout: plant("........Gg......", ".......sg.......", ".......s........"),
  leaves: plant(".........Gg.....", "....Gg..gggg....", "....gggsgg......", ".......s........", ".......s........"),
  lifted: plant(".........Gg.....", "....Gg..gggg....", "....gggsgg......", ".......s........", ".......s........", ".......s........"),
  bloom: plant(
    "......ppp.......", ".....ppypp......", "......ppp.......", ".......s........", ".......s.Gg.....",
    "....Gg.sgggg....", "....gggs........", ".......s........", ".......s........",
  ),
};

const BRAND = [
  "......ww.",
  ".....wwww",
  ".ww.wwww.",
  "wwwwww...",
  ".wwww....",
  "....w....",
  "....w....",
  "..wwwww..",
];

export function BrandMark() {
  return <span className="brand-mark"><PixelArt rows={BRAND} scale={2} /></span>;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const change = () => setReduced(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return reduced;
}

/**
 * The Ask seedling. At rest its leaves lift and settle; while an answer is
 * being written it grows from seed to leaves; hovering it makes it bloom.
 */
export function Seedling({ growing = false, scale = 4, className }: { growing?: boolean; scale?: number; className?: string }) {
  const reduced = useReducedMotion();
  const [tick, setTick] = useState(0);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (reduced) return;
    setTick(0);
    const timer = window.setInterval(() => setTick((value) => value + 1), growing ? 520 : 900);
    return () => window.clearInterval(timer);
  }, [growing, reduced]);
  const frames = growing ? [SEEDLING.seed, SEEDLING.sprout, SEEDLING.leaves, SEEDLING.lifted] : [SEEDLING.leaves, SEEDLING.lifted];
  const frame = hover ? SEEDLING.bloom
    : reduced ? SEEDLING.leaves
    : growing ? frames[Math.min(tick, 2) + (tick > 2 ? tick % 2 : 0)]!
    : frames[tick % 2]!;
  return (
    <span className={className} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <PixelArt rows={frame} scale={scale} />
    </span>
  );
}

type Bed = { family: string; total: number; done: number; blocked: number; emptyShells: number; errors: number };

const PENDING = 0, HEALTHY = 1, EMPTY = 2, ERROR = 3, BLOCKED = 4, BLOOM = 5;
const STATE_NAMES = ["Waiting", "Served", "Empty HTML", "Error", "Blocked", "Blooming"];
const MAX_HEIGHT = 168;
const GROW_MS = 520;

/** Square size and URLs per square, so the garden fits in about 170px whatever the site's size. */
function plotFor(urls: number, beds: number, width: number) {
  for (let k = 1; ; k++) {
    const cells = Math.ceil(urls / k) + beds;
    for (const pitch of [14, 12, 10, 8, 7, 6, 5]) {
      const columns = Math.max(1, Math.floor(width / pitch));
      if (Math.ceil(cells / columns) * pitch <= MAX_HEIGHT) return { k, pitch, columns, gap: pitch >= 8 ? 2 : 1 };
    }
  }
}

/**
 * The crawl garden: one square per URL (or per few, on big sites), grouped
 * in beds by page type. A square sprouts when its URL is fetched, wilts amber
 * for empty HTML, turns red for errors, greys out when robots.txt blocks it,
 * and the healthy ones bloom when the analysis finishes. Counts are exact per
 * bed; where a problem sits inside its bed carries no meaning.
 */
export function CrawlGarden({ families, bloom = false, label }: { families: Bed[]; bloom?: boolean; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const beds = useRef(new Map<string, { states: Uint8Array; born: Float64Array }>());
  const bloomed = useRef(false);
  const frame = useRef(0);
  const [width, setWidth] = useState(0);
  const [tip, setTip] = useState<{ x: number; y: number; bed: Bed; state: number } | null>(null);
  const [theme, setTheme] = useState(0);
  const reduced = useReducedMotion();

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(element);
    const themeWatch = new MutationObserver(() => setTheme((value) => value + 1));
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { observer.disconnect(); themeWatch.disconnect(); };
  }, []);

  const urls = families.reduce((sum, bed) => sum + bed.total, 0);
  const plot = width ? plotFor(urls, families.length, width) : null;

  // Bring each bed's squares up to date: new squares take the states that appeared since the last poll.
  if (plot) {
    const now = performance.now();
    for (const bed of families) {
      const size = Math.ceil(bed.total / plot.k);
      let entry = beds.current.get(bed.family);
      if (!entry || entry.states.length !== size) {
        entry = { states: new Uint8Array(size), born: new Float64Array(size) };
        beds.current.set(bed.family, entry);
      }
      const owed = (count: number) => (count > 0 ? Math.max(1, Math.round(count / plot.k)) : 0);
      const done = Math.min(size, Math.ceil(bed.done / plot.k));
      const want = { [EMPTY]: owed(bed.emptyShells), [ERROR]: owed(bed.errors), [BLOCKED]: owed(bed.blocked) } as Record<number, number>;
      let have = 0;
      const tally: Record<number, number> = { [EMPTY]: 0, [ERROR]: 0, [BLOCKED]: 0 };
      for (let i = 0; i < size; i++) {
        const state = entry.states[i]!;
        if (state !== PENDING) have++;
        if (state in tally) tally[state]!++;
      }
      if (done < have) { entry.states.fill(PENDING); have = 0; tally[EMPTY] = tally[ERROR] = tally[BLOCKED] = 0; }
      const fresh = done - have;
      const problems = [EMPTY, ERROR, BLOCKED].flatMap((state) => Array.from({ length: Math.max(0, want[state]! - tally[state]!) }, () => state));
      for (let i = 0; i < fresh; i++) {
        const slot = have + i;
        // Spread the newly found problems evenly through the newly grown squares.
        const pick = problems.length && Math.floor((i * problems.length) / fresh) !== Math.floor(((i + 1) * problems.length) / fresh)
          ? problems[Math.floor((i * problems.length) / fresh)]!
          : HEALTHY;
        entry.states[slot] = pick;
        // A wave across the bed; on first sight the whole garden sprouts in about a second and a half.
        entry.born[slot] = reduced ? 0 : now + Math.min(i, 400) * 4;
      }
    }
    if (bloom && !bloomed.current) {
      bloomed.current = true;
      let index = 0;
      for (const entry of beds.current.values()) {
        for (let i = 0; i < entry.states.length; i++, index++) {
          if (entry.states[i] === HEALTHY && ((i * 2654435761) >>> 0) % 19 === 0) {
            entry.states[i] = BLOOM;
            entry.born[i] = now + 120 + (index % 900) * 1.4;
          }
        }
      }
    }
  }

  useEffect(() => {
    const element = canvas.current;
    if (!element || !plot || !box.current) return;
    const css = getComputedStyle(box.current);
    const colour = (name: string) => css.getPropertyValue(name).trim();
    const colours = {
      soil: colour("--px-soil"), leaf: colour("--px-leaf"), leaf2: colour("--px-leaf-2"), wilt: colour("--px-wilt"),
      error: colour("--px-error"), stone: colour("--px-stone"), bloom: colour("--px-bloom"), bloom2: colour("--px-bloom-2"),
    };
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const cells = families.reduce((sum, bed) => sum + Math.ceil(bed.total / plot.k) + 1, 0) - 1;
    const rows = Math.max(1, Math.ceil(cells / plot.columns));
    element.width = plot.columns * plot.pitch * dpr;
    element.height = rows * plot.pitch * dpr;
    element.style.height = `${rows * plot.pitch}px`;
    element.style.width = `${plot.columns * plot.pitch}px`;
    const context = element.getContext("2d");
    if (!context) return;
    const size = (plot.pitch - plot.gap) * dpr;

    const draw = () => {
      const now = performance.now();
      let animating = false;
      context.clearRect(0, 0, element.width, element.height);
      let index = 0;
      for (const bed of families) {
        const entry = beds.current.get(bed.family);
        if (!entry) continue;
        for (let i = 0; i < entry.states.length; i++, index++) {
          const x = (index % plot.columns) * plot.pitch * dpr;
          const y = Math.floor(index / plot.columns) * plot.pitch * dpr;
          const state = entry.states[i]!;
          if (state === PENDING) {
            const dot = Math.max(dpr, Math.round(size * .34));
            context.fillStyle = colours.soil;
            context.fillRect(x + Math.round((size - dot) / 2), y + size - dot, dot, dot);
            continue;
          }
          const age = now - entry.born[i]!;
          const grown = reduced || age >= GROW_MS ? 1 : age <= 0 ? 0 : 1 - (1 - age / GROW_MS) ** 3;
          if (grown < 1) animating = true;
          if (grown <= 0) {
            const dot = Math.max(dpr, Math.round(size * .34));
            context.fillStyle = colours.soil;
            context.fillRect(x + Math.round((size - dot) / 2), y + size - dot, dot, dot);
            continue;
          }
          const height = Math.max(dpr, Math.round(size * grown));
          const fill = state === HEALTHY ? colours.leaf : state === EMPTY ? colours.wilt : state === ERROR ? colours.error : state === BLOCKED ? colours.stone : colours.bloom;
          context.fillStyle = fill;
          context.fillRect(x, y + size - height, size, height);
          if (grown === 1 && size >= 3 * dpr) {
            const spot = Math.max(dpr, Math.round(size / 3));
            if (state === HEALTHY) { context.fillStyle = colours.leaf2; context.fillRect(x, y, spot, spot); }
            if (state === BLOOM) { context.fillStyle = colours.bloom2; context.fillRect(x + Math.round((size - spot) / 2), y + Math.round((size - spot) / 2), spot, spot); }
          }
        }
        index++; // the path between beds
      }
      if (animating) frame.current = requestAnimationFrame(draw);
    };
    cancelAnimationFrame(frame.current);
    draw();
    return () => cancelAnimationFrame(frame.current);
  });

  function hover(event: React.MouseEvent<HTMLCanvasElement>) {
    if (!plot) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const column = Math.floor((event.clientX - rect.left) / plot.pitch);
    const row = Math.floor((event.clientY - rect.top) / plot.pitch);
    let index = row * plot.columns + column;
    if (column >= plot.columns || index < 0) return setTip(null);
    for (const bed of families) {
      const entry = beds.current.get(bed.family);
      const size = entry?.states.length ?? 0;
      if (index < size) {
        const boxRect = box.current!.getBoundingClientRect();
        return setTip({ x: event.clientX - boxRect.left, y: event.clientY - boxRect.top, bed, state: entry!.states[index]! });
      }
      index -= size + 1;
      if (index < 0) return setTip(null);
    }
    setTip(null);
  }

  void theme;
  const familyName = (family: string) => (family === "home" ? "Homepage" : family === "page" ? "Top-level pages" : `/${family}/`);
  return (
    <div className="garden" ref={box}>
      <canvas ref={canvas} role="img" aria-label={label} onMouseMove={hover} onMouseLeave={() => setTip(null)} />
      {tip && (
        <div className="garden-tip" style={{ left: tip.x, top: tip.y }}>
          <strong>{familyName(tip.bed.family)} · {STATE_NAMES[tip.state]}</strong>
          {formatNumber(tip.bed.done)} of {formatNumber(tip.bed.total)} URLs checked
          {tip.bed.emptyShells > 0 && <> · {formatNumber(tip.bed.emptyShells)} empty HTML</>}
          {tip.bed.errors > 0 && <> · {formatNumber(tip.bed.errors)} errors</>}
          {tip.bed.blocked > 0 && <> · {formatNumber(tip.bed.blocked)} blocked</>}
        </div>
      )}
      <div className="garden-legend" aria-hidden="true">
        <span><i style={{ background: "var(--px-leaf)" }} />Served</span>
        <span><i style={{ background: "var(--px-wilt)" }} />Empty HTML</span>
        <span><i style={{ background: "var(--px-error)" }} />Error</span>
        <span><i style={{ background: "var(--px-stone)" }} />Blocked</span>
        <span><i style={{ background: "var(--px-soil)" }} />Waiting</span>
        {plot && plot.k > 1 && <span>1 square = {plot.k} URLs</span>}
      </div>
    </div>
  );
}
