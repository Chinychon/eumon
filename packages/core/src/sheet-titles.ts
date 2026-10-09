/**
 * Sheet titles a spreadsheet accepts: forbidden characters become spaces,
 * names fit the limit (31 for Excel, longer for Google Sheets), and a repeat
 * gets a number that still fits. One rule, so an export reads the same in both.
 */
export function sheetTitles(names: string[], maxLength: number, forbidden: RegExp = /[[\]:*?/\\]/g): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base = name.replace(forbidden, " ").replace(/\s+/g, " ").trim().slice(0, maxLength) || "Sheet";
    let title = base;
    for (let n = 2; used.has(title.toLowerCase()); n++) title = `${base.slice(0, maxLength - String(n).length - 1)} ${n}`;
    used.add(title.toLowerCase());
    return title;
  });
}
