// csv.js — CSV text + browser downloads shared by the PCU dashboard, the admin feedback / received tabs and the XLSX exports (2ak D3).

const BOM = "﻿"; // UTF-8 BOM so Excel opens Thai text correctly

/** One CSV field (RFC 4180 quoting). */
export function csvField(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV text (BOM first, CRLF line ends) from a header row and data rows (arrays of values). */
export function buildCsvText(head, rows) {
  return BOM + [head, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/** Starts the browser download of `blob` as `filename`. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function downloadCsvFile(text, filename) {
  downloadBlob(new Blob([text], { type: "text/csv;charset=utf-8" }), filename);
}
