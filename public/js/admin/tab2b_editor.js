// tab2b_editor.js — the line editor + cell renderers shared by the three modes of the "จ่ายจริง" tab (tab2b_issue.js). 2ak D8: split out of
// renderTab2b, no behaviour change. OP-first split of the issued total is shown live (compute.js splitIssued); the server applies the same rule.
import { formatInt } from "../format.js";
import { escapeHtml } from "./util.js";
import { ISSUE_REASONS, splitIssued } from "./compute.js";

export const STATUS_LABEL = { draft: "แบบร่าง", submitted: "ส่งแล้ว", issued: "จ่ายแล้ว" };

export function whoLabel(who) {
  if (!who) return "–";
  return who === "backup" ? "รหัสสำรอง" : who;
}

export function numOrNull(v) {
  return v === null || v === undefined || v === "" ? null : Number(v);
}

// ---- line editor (shared by both modes) -------------------------------------------------------------
// rows: [{key, label, op, pp, req, base:{total, reason, note}, disabled}]. Rows are <tr data-key="…"> rendered by
// the caller with inputCell / gotCells / reasonCell; wire(host) attaches the listeners.
export function createEditor(rows, { onChange } = {}) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const draft = new Map(rows.map((r) => [r.key, { ...r.base }]));
  let host = null;

  const isShort = (d, r) => d.total !== null && d.total < r.req;
  function norm(d, r) {
    if (!isShort(d, r)) return { total: d.total, reason: null, note: null };
    const reason = d.reason || null;
    return { total: d.total, reason, note: reason ? ((d.note || "").trim() || null) : null }; // 2ae: a note rides with "ของหมด" too (optional there)
  }
  const same = (a, b) => a.total === b.total && a.reason === b.reason && a.note === b.note;
  function isChanged(key) {
    const r = byKey.get(key);
    return !same(norm(draft.get(key), r), norm(r.base, r));
  }
  function changedKeys() { return rows.filter((r) => !r.disabled && isChanged(r.key)).map((r) => r.key); }

  const q = (key, sel) => host && host.querySelector(`tr[data-key="${CSS.escape(key)}"] ${sel}`);

  function refreshRow(key) {
    const r = byKey.get(key);
    const d = draft.get(key);
    const got = splitIssued(r.op, r.pp, d.total);
    const gop = q(key, ".t2b-gop"), gpp = q(key, ".t2b-gpp");
    if (gop) gop.textContent = got ? formatInt(got.op) : "—";
    if (gpp) gpp.textContent = got ? formatInt(got.pp) : "—";
    const short = isShort(d, r);
    const sel = q(key, ".t2b-reason"), note = q(key, ".t2b-note");
    if (sel) { sel.disabled = r.disabled || !short; sel.value = short ? (d.reason || "") : ""; }
    if (note) {
      note.hidden = !(short && d.reason);
      note.disabled = r.disabled;
      note.placeholder = notePlaceholder(d.reason);
    }
    const tr = host && host.querySelector(`tr[data-key="${CSS.escape(key)}"]`);
    if (tr) {
      tr.classList.toggle("t2b-changed", !r.disabled && isChanged(key));
      tr.classList.toggle("t2b-short", short);
    }
  }

  function setHint(key, text) {
    const h = q(key, ".t2b-hint");
    if (!h) return;
    h.textContent = text || "";
    clearTimeout(h._t);
    if (text) h._t = setTimeout(() => { h.textContent = ""; }, 3000);
  }

  function wire(container) {
    host = container;
    rows.forEach((r) => {
      const input = q(r.key, ".t2b-in");
      const sel = q(r.key, ".t2b-reason");
      const note = q(r.key, ".t2b-note");
      if (input) {
        input.addEventListener("input", () => {
          let digits = input.value.replace(/[^0-9]/g, "").slice(0, 5);
          let v = digits === "" ? null : parseInt(digits, 10);
          if (v !== null && v > r.req) {
            v = r.req; digits = String(r.req);
            setHint(r.key, `จ่ายเกินขอไม่ได้ (ขอ ${formatInt(r.req)})`);
          }
          if (digits !== input.value) input.value = digits;
          input.classList.remove("input-error");
          draft.get(r.key).total = v;
          refreshRow(r.key);
          if (onChange) onChange();
        });
        input.addEventListener("keydown", (ev) => {
          if (ev.key !== "Enter") return;
          ev.preventDefault();
          const all = Array.from(host.querySelectorAll(".t2b-in:not([disabled])"));
          const next = all[all.indexOf(input) + 1];
          if (next) next.focus();
        });
      }
      if (sel) sel.addEventListener("change", () => {
        sel.classList.remove("input-error");
        draft.get(r.key).reason = sel.value || null;
        refreshRow(r.key);
        if (sel.value === "other" && note) note.focus();
        if (onChange) onChange();
      });
      if (note) note.addEventListener("input", () => {
        note.classList.remove("input-error");
        draft.get(r.key).note = note.value;
        refreshRow(r.key);
        if (onChange) onChange();
      });
      refreshRow(r.key);
    });
  }

  // First problem among changed rows (in row order) -> {key, msg, el} or null.
  function validate() {
    for (const key of changedKeys()) {
      const r = byKey.get(key), d = draft.get(key);
      if (d.total !== null && d.total > r.req) return { key, msg: `${r.label}: จ่ายเกินขอไม่ได้ (ขอ ${r.req})`, el: q(key, ".t2b-in") };
      if (!isShort(d, r)) continue;
      if (!d.reason) return { key, msg: `${r.label}: จ่ายไม่ครบ — เลือกเหตุผล`, el: q(key, ".t2b-reason") };
      const n = (d.note || "").trim();
      if (d.reason === "other" && !n) return { key, msg: `${r.label}: ระบุเหตุผล (อื่น ๆ)`, el: q(key, ".t2b-note") };
      if (n.length > 200) return { key, msg: `${r.label}: หมายเหตุยาวเกิน 200 ตัวอักษร`, el: q(key, ".t2b-note") };
    }
    return null;
  }

  function payload() {
    const out = {};
    changedKeys().forEach((key) => {
      const n = norm(draft.get(key), byKey.get(key));
      out[key] = { issued_total: n.total, reason: n.reason, note: n.note };
    });
    return out;
  }

  function setValue(key, total, reason, note) {
    const r = byKey.get(key);
    if (!r || r.disabled) return;
    draft.set(key, { total, reason, note: note || "" });
    const input = q(key, ".t2b-in");
    if (input) input.value = total === null ? "" : String(total);
    const n = q(key, ".t2b-note");
    if (n) n.value = note || "";
    refreshRow(key);
  }

  return {
    wire, validate, payload, changedKeys,
    dirtyCount: () => changedKeys().length,
    draftOf: (key) => draft.get(key),
    setAllZero() { rows.forEach((r) => setValue(r.key, 0, r.req > 0 ? "out_of_stock" : null, "")); if (onChange) onChange(); },
    setAllReq() { rows.forEach((r) => setValue(r.key, r.req, null, "")); if (onChange) onChange(); },
    revert() { rows.forEach((r) => setValue(r.key, r.base.total, r.base.reason, r.base.note)); if (onChange) onChange(); }
  };
}

// 2ae: "ของหมด" takes an optional note (e.g. "ใช้รายการ … แทนได้") · "อื่น ๆ" needs one
export const notePlaceholder = (reason) => (reason === "out_of_stock" ? "หมายเหตุ (ถ้ามี)" : "ระบุเหตุผล");

// 2af: what the รพ.สต. reported it received (rcv_qty) — yellow "ไม่ตรง" when it differs from the recorded issue (server `mismatch`)
export function rcvHtml(l) {
  if (!l || l.rcv_qty === undefined || l.rcv_qty === null) return "";
  const t = [l.rcv_date ? `รับ ${l.rcv_date}` : "", l.rcv_note || ""].filter(Boolean).join(" · ");
  return `<div class="t2b-rcv small" data-role="rcv"${t ? ` title="${escapeHtml(t)}"` : ""}>รพ.สต. แจ้งได้รับ <strong>${formatInt(l.rcv_qty)}</strong>`
    + (l.mismatch ? ` <span class="badge badge-warn" data-role="mismatch">ไม่ตรง</span>` : "") + (l.rcv_note ? ` <span class="muted">— ${escapeHtml(l.rcv_note)}</span>` : "") + `</div>`;
}
export function inputCell(r) {
  const d = r.base;
  return `<td class="t2b-in-cell"><input class="t2b-in" type="text" inputmode="numeric" maxlength="5" autocomplete="off"
    placeholder="${r.req}" value="${d.total === null ? "" : d.total}" aria-label="จ่ายจริง ${escapeHtml(r.label)}" ${r.disabled ? "disabled" : ""}>
    <div class="t2b-hint" aria-live="polite"></div></td>`;
}
export function gotCells() {
  return `<td class="num t2b-gop">—</td><td class="num t2b-gpp">—</td>`;
}
export function reasonCell(r) {
  const opts = [`<option value="">—</option>`]
    .concat(Object.entries(ISSUE_REASONS).map(([v, label]) => `<option value="${v}">${escapeHtml(label)}</option>`)).join("");
  return `<td class="left t2b-reason-cell"><select class="t2b-reason select-input" aria-label="เหตุผล ${escapeHtml(r.label)}" disabled>${opts}</select>
    <input class="t2b-note" type="text" maxlength="200" placeholder="${notePlaceholder(r.base.reason)}" value="${escapeHtml(r.base.note || "")}" hidden ${r.disabled ? "disabled" : ""}></td>`;
}
