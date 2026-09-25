// Tab 2 — ยอดรวมต่อรายการ (ใบจัดของ) — phase 1.5.md §4 item 2.
import { formatMonthKeyThai, formatInt, formatMoney } from "../format.js";
import { escapeHtml, tableScroll } from "./util.js";
import {
  STEP_CODES, DISPENSE_UNITS, EXTRA_ITEM_CODE,
  actualTotalsByItem, trialTotalsByItem, price2568For, extraItemDescriptor
} from "./compute.js";

function monthOptionsMarkup(state, selectedValue) {
  const parts = [];
  parts.push('<optgroup label="ข้อมูลจริง (ปีงบ 2568)">');
  state.bootstrap.months.forEach((m) => {
    const v = "real:" + m;
    parts.push(`<option value="${v}" ${v === selectedValue ? "selected" : ""}>${escapeHtml(formatMonthKeyThai(m))}</option>`);
  });
  parts.push("</optgroup><optgroup label=\"รอบทดลอง\">");
  state.bootstrap.rounds.forEach((r) => {
    const v = "trial:" + r.month;
    parts.push(`<option value="${v}" ${v === selectedValue ? "selected" : ""}>รอบทดลอง ${escapeHtml(r.label)}</option>`);
  });
  parts.push("</optgroup>");
  return parts.join("");
}

function buildRows(state, sel) {
  const bootstrap = state.bootstrap;
  const monthIdx = sel.type === "real" ? bootstrap.months.indexOf(sel.key) : -1;
  const totals = sel.type === "real" ? actualTotalsByItem(bootstrap, monthIdx) : trialTotalsByItem(bootstrap, sel.key);

  const rows = state.items.map((item) => {
    const t = totals[item.code] || { op: 0, pp: 0, pcuCount: 0 };
    const total = t.op + t.pp;
    const price = sel.type === "real" ? price2568For(bootstrap, item.code) : item.price2569;
    return { item, op: t.op, pp: t.pp, total, pcuCount: t.pcuCount, money: total * price };
  });

  let extraRow = null;
  if (sel.type === "real") {
    const t = totals[EXTRA_ITEM_CODE];
    const desc = extraItemDescriptor(bootstrap);
    if (t && desc) {
      const total = t.op + t.pp;
      extraRow = { extra: true, desc, op: t.op, pp: t.pp, total, pcuCount: t.pcuCount, money: total * desc.price2568 };
    }
  }
  return { rows, extraRow };
}

function groupKeyFor(item, groupMode) { return groupMode === "unit" ? item.dispenseUnit : item.step; }
function groupOrder(groupMode) { return groupMode === "unit" ? DISPENSE_UNITS : STEP_CODES; }

export function renderTab2(container, ctx) {
  const { state } = ctx;
  if (!state.tab2Group) state.tab2Group = "step";
  if (state.tab2HideZero === undefined) state.tab2HideZero = true;
  if (!state.selectedMonth) {
    const months = state.bootstrap.months;
    state.selectedMonth = { type: "real", key: months[months.length - 1] };
  }

  container.innerHTML = "";
  const toolbar = document.createElement("div");
  toolbar.className = "admin-toolbar";

  const monthLabel = document.createElement("label");
  monthLabel.textContent = "เดือน/รอบ:";
  const monthSelect = document.createElement("select");
  monthSelect.className = "select-input";
  const curValue = state.selectedMonth.type + ":" + state.selectedMonth.key;
  monthSelect.innerHTML = monthOptionsMarkup(state, curValue);
  monthLabel.appendChild(monthSelect);
  toolbar.appendChild(monthLabel);

  const seg = document.createElement("div");
  seg.className = "admin-seg";
  const btnStep = document.createElement("button");
  btnStep.type = "button"; btnStep.textContent = "ตาม step";
  const btnUnit = document.createElement("button");
  btnUnit.type = "button"; btnUnit.textContent = "ตามหน่วยจ่าย";
  seg.appendChild(btnStep); seg.appendChild(btnUnit);
  toolbar.appendChild(seg);

  const hideZeroLabel = document.createElement("label");
  hideZeroLabel.className = "admin-inline-check";
  const hideZeroCheck = document.createElement("input");
  hideZeroCheck.type = "checkbox";
  hideZeroCheck.checked = state.tab2HideZero;
  hideZeroLabel.appendChild(hideZeroCheck);
  hideZeroLabel.appendChild(document.createTextNode("ซ่อนรายการยอด 0"));
  toolbar.appendChild(hideZeroLabel);

  container.appendChild(toolbar);
  const tableHost = document.createElement("div");
  container.appendChild(tableHost);

  function setSegActive() {
    btnStep.classList.toggle("active", state.tab2Group === "step");
    btnUnit.classList.toggle("active", state.tab2Group === "unit");
  }
  setSegActive();

  monthSelect.addEventListener("change", () => {
    const [type, key] = monthSelect.value.split(":");
    state.selectedMonth = { type, key };
    draw();
  });
  btnStep.addEventListener("click", () => { state.tab2Group = "step"; setSegActive(); draw(); });
  btnUnit.addEventListener("click", () => { state.tab2Group = "unit"; setSegActive(); draw(); });
  hideZeroCheck.addEventListener("change", () => { state.tab2HideZero = hideZeroCheck.checked; draw(); });

  function draw() {
    const sel = state.selectedMonth;
    const { rows, extraRow } = buildRows(state, sel);
    const groupMode = state.tab2Group;
    const order = groupOrder(groupMode);
    const hideZero = state.tab2HideZero;

    let grandOp = 0, grandPp = 0, grandTotal = 0, grandMoney = 0;
    const html = [];
    order.forEach((groupKey) => {
      const groupRows = rows.filter((r) => groupKeyFor(r.item, groupMode) === groupKey);
      if (!groupRows.length) return;
      let gOp = 0, gPp = 0, gTotal = 0, gMoney = 0;
      const bodyRows = [];
      groupRows.forEach((r) => {
        gOp += r.op; gPp += r.pp; gTotal += r.total; gMoney += r.money;
        if (hideZero && r.total === 0) return;
        bodyRows.push(`<tr>
          <td class="num">${r.item.seq}</td>
          <td class="left">${escapeHtml(r.item.name)}</td>
          <td class="left">${escapeHtml(r.item.unit)}</td>
          <td class="num">${formatInt(r.op)}</td>
          <td class="num">${formatInt(r.pp)}</td>
          <td class="num">${formatInt(r.total)}</td>
          <td class="num">${formatInt(r.pcuCount)}</td>
          <td class="num">${formatMoney(r.money)}</td>
        </tr>`);
      });
      grandOp += gOp; grandPp += gPp; grandTotal += gTotal; grandMoney += gMoney;
      html.push(`<tr class="group-row"><td colspan="8">${escapeHtml(groupKey)}</td></tr>`);
      html.push(...bodyRows);
      html.push(`<tr class="subtotal-row">
        <td colspan="3" class="left">รวม ${escapeHtml(groupKey)}</td>
        <td class="num">${formatInt(gOp)}</td><td class="num">${formatInt(gPp)}</td>
        <td class="num">${formatInt(gTotal)}</td><td></td><td class="num">${formatMoney(gMoney)}</td>
      </tr>`);
    });

    if (extraRow) {
      grandOp += extraRow.op; grandPp += extraRow.pp; grandTotal += extraRow.total; grandMoney += extraRow.money;
      if (!hideZero || extraRow.total !== 0) {
        html.push(`<tr class="group-row"><td colspan="8">ไม่อยู่ในฟอร์ม 2569</td></tr>`);
        html.push(`<tr>
          <td class="num">-</td>
          <td class="left">${escapeHtml(extraRow.desc.name)}</td>
          <td class="left">${escapeHtml(extraRow.desc.unit)}</td>
          <td class="num">${formatInt(extraRow.op)}</td>
          <td class="num">${formatInt(extraRow.pp)}</td>
          <td class="num">${formatInt(extraRow.total)}</td>
          <td class="num">${formatInt(extraRow.pcuCount)}</td>
          <td class="num">${formatMoney(extraRow.money)}</td>
        </tr>`);
      }
    }

    html.push(`<tr class="grand-row">
      <td colspan="3" class="left">รวมทั้งหมด</td>
      <td class="num">${formatInt(grandOp)}</td><td class="num">${formatInt(grandPp)}</td>
      <td class="num">${formatInt(grandTotal)}</td><td></td><td class="num">${formatMoney(grandMoney)}</td>
    </tr>`);

    tableHost.innerHTML = tableScroll(`<table class="admin-table admin-table-wide">
      <thead><tr>
        <th>ลำดับ</th><th class="left">รายการ</th><th class="left">หน่วย</th>
        <th>OP</th><th>PP</th><th>รวม</th><th>จำนวน รพ.สต. ที่เบิก</th><th>เป็นเงิน</th>
      </tr></thead>
      <tbody>${html.join("")}</tbody>
    </table>`);
  }

  draw();
}
