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
        {rows.map((row) => (
          <li key={row.label}>
            <span className="chart-bar-label" title={row.label}>{row.label}</span>
            <span className="chart-bar-track"><i style={{ width: `${Math.max(0, (row.value / max) * 100)}%` }} /></span>
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
              <span className="chart-bar-track"><i style={{ width: `${Math.max(0, (step.value / first) * 100)}%` }} /></span>
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
export function LineChart({ points, series }: { points: Array<{ x: string; values: Array<number | null> }>; series: string[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...points.flatMap((point) => point.values.filter((value): value is number => value !== null)), 0);
  const top = max > 0 ? niceCeiling(max) : 1;
  const x = (index: number) => (points.length > 1 ? (index / (points.length - 1)) * 100 : 50);
  const y = (value: number) => 100 - (value / top) * 100;
  const incomplete = points.length > 1 && points.at(-1)?.x === TODAY();
  const path = (pairs: Array<[number, number]>) => pairs.map(([px, py], index) => `${index ? "L" : "M"}${px},${py}`).join("");
  const current = hover === null ? undefined : points[hover];

  return (
    <div className="chart-line">
      <div
        className="chart-plot"
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setHover(Math.round(((event.clientX - box.left) / box.width) * (points.length - 1)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {[0, 0.5, 1].map((fraction) => <line key={fraction} x1="0" x2="100" y1={y(top * fraction)} y2={y(top * fraction)} className="chart-grid" />)}
          {series.map((name, index) => {
            const pairs = points.flatMap((point, at): Array<[number, number]> => (point.values[index] === null || point.values[index] === undefined ? [] : [[x(at), y(point.values[index]!)]]));
            return (
              <g key={name} className={`chart-series s${index}`}>
                <path d={path(incomplete ? pairs.slice(0, -1) : pairs)} />
                {incomplete && pairs.length > 1 && <path d={path(pairs.slice(-2))} className="chart-tail" />}
              </g>
            );
          })}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1="0" y2="100" className="chart-cursor" />}
        </svg>
        {[1, 0.5, 0].map((fraction) => <span key={fraction} className="chart-tick" style={{ top: `${y(top * fraction)}%` }}>{compact(top * fraction)}</span>)}
        {current && (
          <div className={`chart-readout${hover! > points.length / 2 ? " left" : ""}`} style={{ left: `${x(hover!)}%` }}>
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
