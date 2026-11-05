// tab10_rows.js — แบบฟอร์ม editor: the rows table of the selected page (items / sections, links, order, prices).
// 2ak D8: split out of renderTab10 (tab10_form.js), no behaviour change. `core` = the editor's state + helpers (see renderTab10).
import { formatMoney } from "../format.js";
import { el, toast, formDialog, formatBangkokDateTime } from "./util.js";
import { MAX_ACTIVE_ITEMS, MAX_SECTIONS, isActive, linksOf, nextItemCode, stepCounts } from "./form_diff.js";

export function rowsPart(core) {
  const { ts, rowsCard, selStep, baseItemCodes, histText, touch, drawAll } = core;

  // ---- rows table ---------------------------------------------------------------------------------------------
  function drawRows() {
    rowsCard.innerHTML = "";
    const s = selStep();
    if (!s) return;
    const c = stepCounts(s);
    rowsCard.appendChild(el("div", { class: "t10-head-row" }, [
      el("h2", {}, `รายการในหน้า ${s.code}`),
      el("span", {
        class: "t10-counter" + (c.activeItems > MAX_ACTIVE_ITEMS || c.sections > MAX_SECTIONS ? " over" : ""), id: "t10-counter"
      }, `รายการเปิด ${c.activeItems}/${MAX_ACTIVE_ITEMS} · หัวหมวด ${c.sections}/${MAX_SECTIONS}`)
    ]));

    const table = el("table", { class: "admin-table t10-table", id: "t10-rows-tbl" });
    table.appendChild(el("thead", {}, el("tr", {}, [
      el("th", { class: "num" }, "ลำดับ"), el("th", { class: "left" }, "รหัส"), el("th", { class: "left" }, "รายการ"),
      el("th", { class: "left" }, "หน่วย"), el("th", { class: "num" }, "ราคา"), el("th", {}, "สถานะ"),
      el("th", {}, "เรียง"), el("th", { class: "left" }, "ย้ายไปหน้า")
    ])));
    const tbody = el("tbody");
    const baseCodes = baseItemCodes();
    const otherSteps = ts.draft.steps.filter((x) => x.code !== s.code && isActive(x));
    let seq = 0;
    s.rows.forEach((r, i) => {
      const upDown = el("td", { class: "t10-order-cell" }, [
        el("button", { type: "button", class: "t10-icon-btn", title: "เลื่อนขึ้น", "data-act": "up", disabled: i === 0 }, "▲"),
        el("button", { type: "button", class: "t10-icon-btn", title: "เลื่อนลง", "data-act": "down", disabled: i === s.rows.length - 1 }, "▼")
      ]);
      let tr;
      if (r.type === "section") {
        const title = el("input", { type: "text", class: "t10-in t10-in-section", value: r.title || "", maxlength: 80, placeholder: "ชื่อหัวหมวด", "aria-label": "ชื่อหัวหมวด" });
        title.addEventListener("input", () => { r.title = title.value; touch(); });
        const del = el("button", { type: "button", class: "btn btn-secondary btn-sm", "data-act": "del" }, "ลบ");
        tr = el("tr", { class: "t10-section-row", "data-idx": String(i) }, [
          el("td", { class: "num muted small" }, "หมวด"),
          el("td", { class: "left", colspan: "5" }, title),
          upDown,
          el("td", { class: "left" }, del)
        ]);
        del.addEventListener("click", () => { s.rows.splice(i, 1); ts.focusIdx = null; touch(); drawAll(); });
      } else {
        seq += 1;
        const active = isActive(r);
        const name = el("input", { type: "text", class: "t10-in t10-in-name", value: r.name || "", maxlength: 200, "data-code": r.code, "aria-label": "ชื่อรายการ " + r.code });
        name.addEventListener("input", () => { r.name = name.value; touch(); });
        const unit = el("input", { type: "text", class: "t10-in t10-in-unit", value: r.unit || "", maxlength: 30, "aria-label": "หน่วย " + r.code });
        unit.addEventListener("input", () => { r.unit = unit.value; touch(); });
        const price = el("input", { type: "number", class: "t10-in t10-in-price", step: "0.01", min: "0", inputmode: "decimal", value: Number.isFinite(Number(r.price)) ? String(r.price) : "", "aria-label": "ราคา " + r.code });
        price.addEventListener("input", () => {
          const v = price.value.trim();
          r.price = v === "" ? NaN : Number(v);
          price.classList.toggle("bad", !(Number.isFinite(r.price) && r.price >= 0));
          touch();
        });
        // 2ad: closing = cancelling the item for good — the PCU form keeps it greyed with this reason (required here, item.cancel_reason)
        const toggle = el("button", { type: "button", class: "btn btn-sm " + (active ? "btn-secondary" : "btn-primary"), "data-act": "toggle" }, active ? "ยกเลิกรายการถาวร" : "เปิดใช้อีกครั้ง");
        toggle.addEventListener("click", async () => {
          if (!active) {
            if (stepCounts(s).activeItems >= MAX_ACTIVE_ITEMS) { toast(`หน้านี้เปิดรายการครบ ${MAX_ACTIVE_ITEMS} แล้ว`, "err"); return; }
            r.active = true; delete r.cancel_reason; touch(); drawAll();
            return;
          }
          const res = await formDialog(`ยกเลิกรายการถาวร: ${r.name || r.code}`, [
            { key: "reason", label: "เหตุผล (รพ.สต. เห็นข้อความนี้ในหน้ากรอก)", required: true, maxlength: 200, placeholder: "เช่น เลิกผลิต ใช้รายการ … แทน", value: r.cancel_reason || "" },
          ], { okText: "ยกเลิกรายการ", intro: "รายการจะยังแสดงในหน้ากรอกของ รพ.สต. เป็นสีเทาพร้อมเหตุผล และขอเพิ่มไม่ได้ (บันทึก version ใหม่เพื่อให้มีผล)" });
          if (!res) return;
          r.active = false; r.cancel_reason = res.reason; touch(); drawAll();
        });
        const move = el("select", { class: "select-input t10-move", "aria-label": "ย้ายไปหน้า" });
        move.appendChild(el("option", { value: "" }, "—"));
        otherSteps.forEach((o) => move.appendChild(el("option", { value: o.code }, `${o.code} · ${o.sheet || ""}`)));
        move.addEventListener("change", () => {
          const target = ts.draft.steps.find((x) => x.code === move.value);
          if (!target) return;
          s.rows.splice(i, 1);
          target.rows.push(r);
          ts.focusIdx = null;
          touch(); drawAll();
          toast(`ย้าย ${r.code} ไปท้ายหน้า ${target.code} แล้ว`);
        });
        // 2al: close the OP or the PP column of this item (item.closed_cols) — the PCU can't request in it; old figures stay
        const colBtns = active ? el("div", { class: "t10-cols small" }, ["op", "pp"].map((c) => {
          const closed = Array.isArray(r.closed_cols) && r.closed_cols.includes(c);
          const label = c.toUpperCase();
          const b = el("button", {
            type: "button", class: "btn btn-sm t10-col-btn " + (closed ? "btn-danger" : "btn-secondary"), "data-act": "col-" + c, "aria-pressed": closed ? "true" : "false",
            title: closed ? `ช่อง ${label} ปิดอยู่ — กดเพื่อเปิดให้ รพ.สต. ขอเบิกเป็น ${label} ได้` : `กดเพื่อปิดช่อง ${label} (รายการนี้เบิกเป็น ${label} ไม่ได้)`
          }, closed ? `${label} ปิด` : `${label} เปิด`);
          b.addEventListener("click", () => {
            const other = c === "op" ? "pp" : "op";
            if (!closed && Array.isArray(r.closed_cols) && r.closed_cols.includes(other)) {
              toast(`ปิดทั้ง OP และ PP ไม่ได้ — ถ้าไม่ใช้รายการนี้แล้วให้กด "ยกเลิกรายการถาวร"`, "err");
              return;
            }
            if (closed) delete r.closed_cols; else r.closed_cols = [c];
            touch(); drawAll();
          });
          return b;
        })) : null;
        const statusCell = el("td", { class: "t10-status-cell" }, [
          el("span", { class: "badge " + (active ? "badge-success" : "badge-muted") }, active ? "เปิด" : "ยกเลิกแล้ว"), " ", toggle,
          !active && r.cancel_reason ? el("div", { class: "muted small t10-cancel-reason" }, "เหตุผล: " + r.cancel_reason) : null,
          colBtns
        ]);
        const moveCell = el("td", { class: "left" }, [move]);
        if (!baseCodes.has(r.code)) {
          const del = el("button", { type: "button", class: "btn btn-secondary btn-sm", "data-act": "del", title: "รายการใหม่ที่ยังไม่บันทึก — ลบได้" }, "ลบ");
          del.addEventListener("click", () => { s.rows.splice(i, 1); ts.focusIdx = null; touch(); drawAll(); });
          moveCell.appendChild(del);
        }
        tr = el("tr", { class: "t10-item-row" + (active ? "" : " t10-closed") + (baseCodes.has(r.code) ? "" : " t10-new"), "data-idx": String(i), "data-code": r.code }, [
          el("td", { class: "num" }, String(seq)),
          linkCell(r),
          el("td", { class: "left" }, histText(r.code)
            ? [name, el("div", { class: "t10-hist muted small", title: (ts.hist[r.code] || []).map((x) => `${formatMoney(x.price)}${x.set_at ? " ตั้งเมื่อ " + formatBangkokDateTime(x.set_at) : ""}${x.set_by ? " โดย " + x.set_by : ""}`).join("\n") }, histText(r.code))]
            : name),
          el("td", { class: "left" }, unit),
          el("td", { class: "num" }, price),
          statusCell,
          upDown,
          moveCell
        ]);
      }
      if (i === ts.focusIdx) tr.classList.add("t10-focus");
      tr.addEventListener("focusin", () => setFocusRow(i));
      tr.addEventListener("click", () => setFocusRow(i));
      upDown.querySelector('[data-act="up"]').addEventListener("click", (ev) => { ev.stopPropagation(); moveRow(i, -1); });
      upDown.querySelector('[data-act="down"]').addEventListener("click", (ev) => { ev.stopPropagation(); moveRow(i, 1); });
      tbody.appendChild(tr);
    });
    if (!s.rows.length) tbody.appendChild(el("tr", {}, el("td", { colspan: "8", class: "left muted" }, "ยังไม่มีรายการ — กด \"เพิ่มรายการ\"")));
    table.appendChild(tbody);
    const scroll = el("div", { class: "table-scroll t10-scroll" }, table);
    rowsCard.appendChild(scroll);

    const addItem = el("button", { type: "button", class: "btn btn-secondary", id: "t10-add-item", disabled: c.activeItems >= MAX_ACTIVE_ITEMS }, "เพิ่มรายการ");
    const addSec = el("button", { type: "button", class: "btn btn-secondary", id: "t10-add-section", disabled: c.sections >= MAX_SECTIONS }, "เพิ่มหัวหมวด");
    addItem.addEventListener("click", () => addItemRow(s));
    addSec.addEventListener("click", () => addSection(s));
    const hint = el("span", { class: "muted small" }, "หัวหมวดจะแทรกก่อนแถวที่เลือกอยู่ (ไม่ได้เลือก = บนสุด) · รายการลบไม่ได้ ให้ปิดแทน");
    rowsCard.appendChild(el("div", { class: "admin-toolbar t10-row-actions" }, [addItem, addSec, hint]));
  }

  // 2v: code cell + "เชื่อมรหัสเดิม" — link closed items (same thing, old code) so prior-year data counts under this item
  function linkCell(r) {
    const td = el("td", { class: "code-cell t10-code-cell" }, r.code);
    const links = linksOf(r);
    const takenBy = new Map();
    ts.draft.steps.forEach((x) => (x.rows || []).forEach((y) => { if (y.type === "item" && y !== r) linksOf(y).forEach((c) => takenBy.set(c, y.code)); }));
    links.forEach((c) => {
      const x = el("button", { type: "button", class: "t10-link-x", title: `ยกเลิกการเชื่อม ${c}`, "aria-label": `ยกเลิกการเชื่อม ${c}` }, "×");
      x.addEventListener("click", (ev) => { ev.stopPropagation(); r.links = links.filter((k) => k !== c); if (!r.links.length) delete r.links; touch(); drawAll(); });
      td.appendChild(el("div", { class: "t10-link muted small", title: "ข้อมูลปีก่อน/สถิติของรหัสเดิมนับรวมเป็นรายการนี้" }, ["← " + c + " ", x]));
    });
    const closed = [];
    ts.draft.steps.forEach((x) => (x.rows || []).forEach((y) => {
      if (y.type === "item" && y !== r && !(isActive(y) && isActive(x)) && !links.includes(y.code) && !takenBy.has(y.code)) closed.push(y);
    }));
    if (closed.length && links.length < 10) {
      const sel = el("select", { class: "select-input t10-link-sel", "aria-label": "เชื่อมรหัสเดิมของ " + r.code });
      sel.appendChild(el("option", { value: "" }, "เชื่อมรหัสเดิม…"));
      closed.forEach((y) => sel.appendChild(el("option", { value: y.code }, `${y.code} · ${String(y.name || "").slice(0, 40)}`)));
      sel.addEventListener("click", (ev) => ev.stopPropagation());
      sel.addEventListener("change", () => {
        if (!sel.value) return;
        r.links = [...links, sel.value].sort();
        touch(); drawAll();
        toast(`เชื่อม ${r.code} ← ${sel.value} แล้ว (ยังไม่บันทึก)`);
      });
      td.appendChild(sel);
    }
    return td;
  }

  function setFocusRow(i) {
    if (ts.focusIdx === i) return;
    ts.focusIdx = i;
    rowsCard.querySelectorAll("tr[data-idx]").forEach((tr) => tr.classList.toggle("t10-focus", Number(tr.dataset.idx) === i));
  }

  function moveRow(i, delta) {
    const s = selStep();
    const j = i + delta;
    if (!s || j < 0 || j >= s.rows.length) return;
    [s.rows[i], s.rows[j]] = [s.rows[j], s.rows[i]];
    ts.focusIdx = j;
    touch(); drawAll();
    const btn = rowsCard.querySelector(`tr[data-idx="${j}"] [data-act="${delta < 0 ? "up" : "down"}"]`);
    if (btn && !btn.disabled) btn.focus();
  }

  function addItemRow(s) {
    if (stepCounts(s).activeItems >= MAX_ACTIVE_ITEMS) { toast(`หน้านี้เปิดรายการครบ ${MAX_ACTIVE_ITEMS} แล้ว`, "err"); return; }
    const code = nextItemCode(ts.draft, s.code, ts.base);
    if (!code) { toast("สร้างรหัสรายการใหม่ไม่ได้", "err"); return; }
    s.rows.push({ type: "item", code, name: "", unit: "", price: 0, active: true });
    ts.focusIdx = s.rows.length - 1;
    touch(); drawAll();
    const input = rowsCard.querySelector(`input.t10-in-name[data-code="${CSS.escape(code)}"]`);
    if (input) { input.scrollIntoView({ block: "center" }); input.focus(); }
  }

  function addSection(s) {
    if (stepCounts(s).sections >= MAX_SECTIONS) { toast(`หัวหมวดได้ไม่เกิน ${MAX_SECTIONS} หัวต่อหน้า`, "err"); return; }
    const at = ts.focusIdx !== null && ts.focusIdx >= 0 && ts.focusIdx < s.rows.length ? ts.focusIdx : 0;
    s.rows.splice(at, 0, { type: "section", title: "" });
    ts.focusIdx = at;
    touch(); drawAll();
    const input = rowsCard.querySelector(`tr[data-idx="${at}"] input`);
    if (input) input.focus();
  }

  return { drawRows };
}
