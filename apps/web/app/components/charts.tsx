"use client";

import { useState } from "react";
import { formatNumber } from "./api";

/*
 * Charts drawn from data rows, in the console's grays: lines and bars are
 * data, not progress, so they never use the brand green.
 */

/** 1,234 → "1.2K"; for axis ticks, where width matters more than precision. */
const compact = (value: number) => value.toLocaleString("en", { notation: "compact", maximumFractionDigits: 1 });

/** A ranked comparison: one bar per row, longest first as given. */
export function BarList({ rows }: { rows: Array<{ label: string; value: number }> }) {
  const max = Math.max(...rows.map((row) => row.value), 0) || 1;
  return (
    <div className="chart-box">
      <ol className="chart-bars">
        {rows.map((row, index) => (
          <li key={row.label}>
            <span className="chart-bar-label" title={row.label}>{row.label}</span>
            <span className="chart-bar-track"><i style={{ width: `${Math.max(0, (row.value / max) * 100)}%`, ["--i" as string]: index }} /></span>
            <span className="chart-bar-value">{formatNumber(row.value)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Ordered steps, each bar relative to the first, with the share kept from the step before. */
export function Funnel({ steps }: { steps: Array<{ label: string; value: number }> }) {
  const first = steps[0]?.value || 1;
  return (
    <div className="chart-box">
      <ol className="chart-bars chart-funnel">
        {steps.map((step, index) => {
          const previous = steps[index - 1]?.value;
          return (
            <li key={step.label}>
              <span className="chart-bar-label" title={step.label}>{step.label}</span>
              <span className="chart-bar-track"><i style={{ width: `${Math.max(0, (step.value / first) * 100)}%`, ["--i" as string]: index }} /></span>
              <span className="chart-bar-value">
                {formatNumber(step.value)}
                {previous ? <small>{Math.round((step.value / previous) * 100)}%</small> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const TODAY = () => new Date().toISOString().slice(0, 10);

/**
 * A trend over days. The segment into today is dashed because today is still
 * filling in; hovering reads out every series for the nearest day.
 */
export function LineChart({ points, series, marker, partialFrom }: {
  points: Array<{ x: string; values: Array<number | null> }>;
  series: string[];
  /** A vertical hairline at the first point on or after `x`, labeled (e.g. go-live). */
  marker?: { x: string; label: string };
  /** Points from this x on are still filling in and draw dashed. */
  partialFrom?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...points.flatMap((point) => point.values.filter((value): value is number => value !== null)), 0);
  const top = max > 0 ? niceCeiling(max) : 1;
  const x = (index: number) => (points.length > 1 ? (index / (points.length - 1)) * 100 : 50);
  const y = (value: number) => 100 - (value / top) * 100;
  const firstPartial = partialFrom ? points.findIndex((point) => point.x >= partialFrom) : points.at(-1)?.x === TODAY() ? points.length - 1 : -1;
  const incomplete = points.length > 1 && firstPartial > 0;
  const markerAt = marker ? points.findIndex((point) => point.x >= marker.x) : -1;
  const path = (pairs: Array<[number, number]>) => pairs.map(([px, py], index) => `${index ? "L" : "M"}${px},${py}`).join("");
  const current = hover === null ? undefined : points[hover];
  const last = points.at(-1);
  const summary = `${series.map((name) => name.replace(/_/g, " ")).join(", ")} by day from ${points[0]?.x ?? ""} to ${last?.x ?? ""}`
    + (last ? `; latest ${series.map((name, index) => `${name.replace(/_/g, " ")} ${last.values[index] === null ? "unknown" : formatNumber(last.values[index]!)}`).join(", ")}` : "")
    + ". Use the arrow keys to read each day.";

  return (
    <div className="chart-line">
      <div
        className="chart-plot"
        role="img"
        aria-label={summary}
        tabIndex={0}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setHover(Math.round(((event.clientX - box.left) / box.width) * (points.length - 1)));
        }}
        onMouseLeave={() => setHover(null)}
        onFocus={() => setHover(points.length - 1)}
        onBlur={() => setHover(null)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setHover((index) => Math.max(0, Math.min(points.length - 1, (index ?? points.length - 1) + (event.key === "ArrowLeft" ? -1 : 1))));
        }}
      >
        <svg className="chart-draw" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {[0, 0.5, 1].map((fraction) => <line key={fraction} x1="0" x2="100" y1={y(top * fraction)} y2={y(top * fraction)} className="chart-grid" />)}
          {series.map((name, index) => {
            const pairs = points.flatMap((point, at): Array<[number, number]> => (point.values[index] === null || point.values[index] === undefined ? [] : [[x(at), y(point.values[index]!)]]));
            const solid = incomplete ? pairs.filter(([px]) => px <= x(firstPartial - 1)) : pairs;
            const tail = incomplete ? pairs.filter(([px]) => px >= x(firstPartial - 1)) : [];
            return (
              <g key={name} className={`chart-series s${index}`}>
                <path d={path(solid)} />
                {tail.length > 1 && <path d={path(tail)} className="chart-tail" />}
              </g>
            );
          })}
          {markerAt >= 0 && <line x1={x(markerAt)} x2={x(markerAt)} y1="0" y2="100" className="chart-marker" />}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1="0" y2="100" className="chart-cursor" />}
        </svg>
        {[1, 0.5, 0].map((fraction) => <span key={fraction} className="chart-tick" style={{ top: `${y(top * fraction)}%` }}>{compact(top * fraction)}</span>)}
        {markerAt >= 0 && <span className="chart-marker-label" style={{ left: `${x(markerAt)}%` }}>{marker!.label}</span>}
        {current && (
          <div className={`chart-readout${hover! > points.length / 2 ? " left" : ""}`} style={{ left: `${x(hover!)}%` }} aria-live="polite">
            <strong>{current.x}{current.x === TODAY() ? " · so far" : ""}</strong>
            {series.map((name, index) => <span key={name} className={`s${index}`}>{name.replace(/_/g, " ")} {current.values[index] === null ? "—" : formatNumber(current.values[index]!)}</span>)}
          </div>
        )}
      </div>
      <div className="chart-x"><span>{points[0]?.x}</span><span>{points.at(-1)?.x}</span></div>
      {series.length > 1 && <div className="chart-legend">{series.map((name, index) => <span key={name} className={`s${index}`}>{name.replace(/_/g, " ")}</span>)}</div>}
    </div>
  );
}

/** The smallest 1, 2, 2.5, or 5 × 10ⁿ at or above `value`, so ticks read as round numbers. */
function niceCeiling(value: number) {
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 2.5, 5, 10].find((step) => step * power >= value) ?? 10) * power;
}

/**
 * Rows × columns, each cell shaded by its share (0–1) and labelled with its
 * count. A table underneath, so screen readers get the numbers as numbers.
 */
export function Heatmap({ columns, rows, caption }: {
  columns: string[];
  rows: Array<{ label: string; note?: string; cells: Array<{ count: number; share: number; applies?: boolean }> }>;
  caption: string;
}) {
  return (
    <div className="table-wrap heatmap-wrap">
      <table className="heatmap">
        <caption className="sr-only">{caption}</caption>
        <thead><tr><th scope="col"><span className="sr-only">Page type</span></th>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>{rows.map((row, rowIndex) => (
          <tr key={row.label}>
            <th scope="row"><code>{row.label}</code>{row.note && <small>{row.note}</small>}</th>
            {row.cells.map((cell, index) => (
              <td
                key={columns[index]}
                className={cell.applies === false ? "na" : cell.count ? undefined : "zero"}
                style={{ ["--share" as string]: Math.min(1, cell.share), ["--i" as string]: rowIndex + index }}
                title={cell.applies === false ? `${columns[index]} does not apply to ${row.label}` : `${row.label}: ${formatNumber(cell.count)} ${columns[index]!.toLowerCase()} (${Math.round(cell.share * 100)}%)`}
              >
                {cell.applies === false ? "—" : cell.count ? formatNumber(cell.count) : "0"}
              </td>
            ))}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

type Point = { label: string; x: number; y: number; detail?: string; highlight?: boolean };

/**
 * Search position (1 on the left, better) against impressions. A shaded band
 * marks the positions worth pushing; hover or arrow keys read out each point.
 */
export function Scatter({ points, band, xLabel, yLabel }: { points: Point[]; band?: [number, number]; xLabel: string; yLabel: string }) {
  const [active, setActive] = useState<number | null>(null);
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const xMax = Math.max(20, ...sorted.map((point) => Math.ceil(point.x)));
  const yTop = niceCeiling(Math.max(1, ...sorted.map((point) => point.y)));
  const px = (x: number) => ((x - 1) / (xMax - 1)) * 100;
  const py = (y: number) => 100 - (y / yTop) * 100;
  const current = active === null ? undefined : sorted[active];
  const summary = `${sorted.length} queries by ${xLabel} and ${yLabel}${band ? `; ${sorted.filter((point) => point.x >= band[0] && point.x <= band[1]).length} sit at positions ${band[0]}–${band[1]}` : ""}. Use the arrow keys to read each point.`;
  return (
    <div className="chart-line chart-scatter">
      <div
        className="chart-plot"
        role="img"
        aria-label={summary}
        tabIndex={0}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const mx = ((event.clientX - box.left) / box.width) * 100;
          const my = ((event.clientY - box.top) / box.height) * 100;
          let best = -1;
          let distance = Infinity;
          sorted.forEach((point, index) => {
            const d = (px(point.x) - mx) ** 2 + ((py(point.y) - my) * (box.height / box.width)) ** 2;
            if (d < distance) { distance = d; best = index; }
          });
          setActive(best >= 0 && distance < 60 ? best : null);
        }}
        onMouseLeave={() => setActive(null)}
        onFocus={() => setActive(0)}
        onBlur={() => setActive(null)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setActive((index) => Math.max(0, Math.min(sorted.length - 1, (index ?? 0) + (event.key === "ArrowLeft" ? -1 : 1))));
        }}
      >
        <svg className="chart-draw" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {band && <rect className="chart-band" x={px(band[0])} y="0" width={px(band[1]) - px(band[0])} height="100" />}
          {[0, 0.5, 1].map((fraction) => <line key={fraction} x1="0" x2="100" y1={py(yTop * fraction)} y2={py(yTop * fraction)} className="chart-grid" />)}
        </svg>
        {sorted.map((point, index) => (
          <i
            key={`${point.label}${index}`}
            className={`chart-dot${point.highlight ? " hot" : ""}${index === active ? " on" : ""}`}
            style={{ left: `${px(point.x)}%`, top: `${py(point.y)}%`, ["--i" as string]: index }}
          />
        ))}
        {[1, 0.5, 0].map((fraction) => <span key={fraction} className="chart-tick" style={{ top: `${py(yTop * fraction)}%` }}>{compact(yTop * fraction)}</span>)}
        {current && (
          <div className={`chart-readout${px(current.x) > 55 ? " left" : ""}`} style={{ left: `${px(current.x)}%`, top: `${Math.min(70, py(current.y))}%` }} aria-live="polite">
            <strong>{current.label}</strong>
            <span className="plain">position {current.x.toFixed(1)} · {formatNumber(current.y)} {yLabel}</span>
            {current.detail && <span className="plain">{current.detail}</span>}
          </div>
        )}
      </div>
      <div className="chart-x"><span>{xLabel} 1</span><span>{xMax}</span></div>
    </div>
  );
}

/** One group per row (a content section), one bar per series (you, then each competitor), on a shared scale. */
export function PairedBars({ groups, series }: { groups: Array<{ label: string; values: number[] }>; series: string[] }) {
  const max = Math.max(1, ...groups.flatMap((group) => group.values));
  return (
    <div className="chart-box">
      <ol className="paired-bars">
        {groups.map((group, groupIndex) => (
          <li key={group.label}>
            <span className="chart-bar-label" title={group.label}>{group.label}</span>
            <div className="paired-tracks">
              {group.values.map((value, index) => (
                <span key={series[index]} className={`paired-row s${index}`}>
                  <span className="chart-bar-track"><i style={{ width: `${(value / max) * 100}%`, ["--i" as string]: groupIndex * 2 + index }} /></span>
                  <span className="chart-bar-value" aria-label={`${series[index]}: ${formatNumber(value)}`}>{formatNumber(value)}</span>
                </span>
              ))}
            </div>
          </li>
        ))}
      </ol>
      <div className="chart-legend paired-legend">{series.map((name, index) => <span key={name} className={`s${index}`}>{name}</span>)}</div>
    </div>
  );
}
