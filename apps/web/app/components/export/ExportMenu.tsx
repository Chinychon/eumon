"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { fileName, toCsv, toCsvZip, toTsv, toXlsx, type Sheet } from "./workbook";

/** The site an export belongs to: its name for file names, and its id for Google Sheets (left out on the client link, which can't create sheets). */
export const ExportContext = createContext<{ siteId?: string; siteName: string }>({ siteName: "eumon" });

const today = () => new Date().toISOString().slice(0, 10);

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Export for one card or one tab: CSV (a .zip when there are several
 * tables), an Excel workbook with a sheet per table, a new Google Sheet, or
 * the cells on the clipboard. `sheets` runs only when chosen.
 */
export function ExportMenu({ title, sheets, label = "Export" }: { title: string; sheets: () => Sheet[]; label?: string }) {
  const { siteId, siteName } = useContext(ExportContext);
  const menu = useRef<HTMLDetailsElement>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!status) return; const timer = setTimeout(() => setStatus(""), 5000); return () => clearTimeout(timer); }, [status]);
  // A click anywhere else closes the menu.
  useEffect(() => {
    const close = (event: MouseEvent) => { if (menu.current?.open && !menu.current.contains(event.target as Node)) menu.current.open = false; };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  const name = `${title} · ${siteName}`;
  const tables = () => sheets().filter((sheet) => sheet.rows.length > 0);
  const done = (message: string) => { setStatus(message); if (menu.current) menu.current.open = false; };

  function csv() {
    const list = tables();
    if (!list.length) return done("Nothing to export yet");
    if (list.length === 1) download(fileName(name, today(), "csv"), `﻿${toCsv(list[0]!)}`, "text/csv;charset=utf-8");
    else download(fileName(name, today(), "zip"), toCsvZip(list) as BlobPart, "application/zip");
    done(list.length === 1 ? "CSV downloaded" : `${list.length} CSVs downloaded as a .zip`);
  }

  function xlsx() {
    const list = tables();
    if (!list.length) return done("Nothing to export yet");
    download(fileName(name, today(), "xlsx"), toXlsx(list) as BlobPart, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    done("Excel file downloaded");
  }

  async function copy(list = tables()) {
    if (!list.length) return done("Nothing to copy yet");
    await navigator.clipboard.writeText(toTsv(list));
    done("Copied: paste into any spreadsheet");
  }

  async function googleSheets() {
    const list = tables();
    if (!list.length) return done("Nothing to export yet");
    // Opened now, while the click still counts as the user's: a window opened after the request would be blocked.
    const opened = window.open("about:blank", "_blank");
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>(`/api/sites/${siteId}/export/sheets`, { method: "POST", json: { title: `${name} · ${today()}`, sheets: list } });
      if (opened) opened.location.href = url; else window.open(url, "_blank");
      done("Google Sheet created");
    } catch (cause) {
      // Without the Sheets permission (or the API), the cells go on the clipboard and a blank sheet opens to paste into.
      await navigator.clipboard.writeText(toTsv(list)).catch(() => undefined);
      if (opened) opened.location.href = "https://sheets.new"; else window.open("https://sheets.new", "_blank");
      const needsReconnect = cause instanceof ApiError && cause.status === 403;
      done(needsReconnect ? "Copied. Paste into the new sheet (Ctrl/⌘+V). Reconnect Google in Setup to create sheets directly." : `Copied. Paste into the new sheet: ${cause instanceof Error ? cause.message : "Google Sheets failed"}`);
    } finally { setBusy(false); }
  }

  return (
    <div className="export">
      <details className="export-menu" ref={menu}>
        <summary className="btn btn-ghost btn-small" aria-label={`${label} ${title}`}>{busy ? "Exporting…" : label}</summary>
        <div className="export-options" role="menu">
          <button role="menuitem" onClick={csv}>CSV</button>
          <button role="menuitem" onClick={xlsx}>Excel (.xlsx)</button>
          {siteId && <button role="menuitem" onClick={() => void googleSheets()}>Google Sheets</button>}
          <button role="menuitem" onClick={() => void copy()}>Copy to clipboard</button>
        </div>
      </details>
      {status && <span className="export-status" role="status">{status}</span>}
    </div>
  );
}
