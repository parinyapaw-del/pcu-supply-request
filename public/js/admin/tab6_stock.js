// Tab 6 — คงเหลือ [จำลอง] — phase 1.5.md §4 item 6 / §2.3.
import { formatMonthKeyThai, formatInt } from "../format.js";
import { escapeHtml, tableScroll, fmt1 } from "./util.js";
import { stockSummaryPerPcu, stockTableForPcu } from "./compute.js";

const FLAG_FILTERS = [
  { key: "all", label: "ทั้งหมด" },
  { key: "over", label: "คงคลังเกินแต่ยังเบิก" },
  { key: "short", label: "ใกล้หมด" }
];

function monthOptionsMarkup(state, selectedValue) {
  const parts = ['<optgroup label="ข้อมูลจริง (ปีงบ 2568)">'];
  state.bootstrap.months.forEach((m) => {
    const v = "real:" + m;
    parts.push(`<option value="${v}" ${v === selectedValue ? "selected" : ""}>${escapeHtml(formatMonthKeyThai(m))}</option>`);
  });
  parts.push('</optgroup><optgroup label="รอบทดลอง">');
  state.bootstrap.rounds.forEach((r) => {
    const v = "trial:" + r.month;
    parts.push(`<option value="${v}" ${v === selectedValue ? "selected" : ""}>รอบทดลอง ${escapeHtml(r.label)}</option>`);
  });
  parts.push("</optgroup>");
  return parts.join("");
}

export function renderTab6(container, ctx) {
  const { state } = ctx;
  if (!state.selectedMonth) {
    const months = state.bootstrap.months;
    state.selectedMonth = { type: "real", key: months[months.length - 1] };
  }
  if (!state.tab6Pcu) state.tab6Pcu = state.bootstrap.pcus[0].code;
  if (!state.tab6Filter) state.tab6Filter = "all";

  container.innerHTML = "";
  const banner = document.createElement("p");
  banner.className = "admin-note";
  banner.innerHTML = '<span class="tag-sim">[จำลอง]</span> คงเหลือเป็นค่าจำลองที่สอดคล้องกับยอดเบิกจริง ไม่ใช่ของจริงในคลัง · ธงคิดเฉพาะรายการที่เบิกสม่ำเสมอ (≥ 6 จาก 12 เดือนปี 68)';
  container.appendChild(banner);

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
  container.appendChild(toolbar);

  const summaryHost = document.createElement("div");
  container.appendChild(summaryHost);

  const detailToolbar = document.createElement("div");
  detailToolbar.className = "admin-toolbar";
  const pcuLabel = document.createElement("label");
  pcuLabel.textContent = "รพ.สต.:";
  const pcuSelect = document.createElement("select");
  pcuSelect.className = "select-input";
  state.bootstrap.pcus.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.code; opt.textContent = `${p.code} ${p.name}`;
    if (p.code === state.tab6Pcu) opt.selected = true;
    pcuSelect.appendChild(opt);
  });
  pcuLabel.appendChild(pcuSelect);
  detailToolbar.appendChild(pcuLabel);

  const filterLabel = document.createElement("label");
  filterLabel.textContent = "ธง:";
  const filterSelect = document.createElement("select");
  filterSelect.className = "select-input";
  FLAG_FILTERS.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f.key; opt.textContent = f.label;
    if (f.key === state.tab6Filter) opt.selected = true;
    filterSelect.appendChild(opt);
  });
  filterLabel.appendChild(filterSelect);
  detailToolbar.appendChild(filterLabel);
  container.appendChild(detailToolbar);

  const detailHost = document.createElement("div");
  container.appendChild(detailHost);

  monthSelect.addEventListener("change", () => {
    const [type, key] = monthSelect.value.split(":");
    state.selectedMonth = { type, key };
    draw();
  });
  pcuSelect.addEventListener("change", () => { state.tab6Pcu = pcuSelect.value; drawDetail(); });
  filterSelect.addEventListener("change", () => { state.tab6Filter = filterSelect.value; drawDetail(); });

  function drawSummary() {
    const sel = state.selectedMonth;
    const summary = stockSummaryPerPcu(state.bootstrap, state.items, sel);
    const rows = summary.map((s) => `<tr>
      <td class="left">${s.pcu.code} ${escapeHtml(s.pcu.name)}${s.pcu.group === "พิเศษ" ? ' <span class="pcu-group-tag">(พิเศษ)</span>' : ""}</td>
      <td class="num">${s.over > 0 ? `<span class="badge badge-flag-over">${s.over}</span>` : "0"}</td>
      <td class="num">${s.short > 0 ? `<span class="badge badge-flag-short">${s.short}</span>` : "0"}</td>
    </tr>`).join("");
    summaryHost.innerHTML = tableScroll(`<table class="admin-table">
      <thead><tr><th class="left">รพ.สต.</th><th>คงคลังเกินแต่ยังเบิก</th><th>ใกล้หมด</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`);
  }

  function drawDetail() {
    const sel = state.selectedMonth;
    let rows = stockTableForPcu(state.bootstrap, state.items, state.tab6Pcu, sel);
    if (state.tab6Filter === "over") rows = rows.filter((r) => r.flag === "over");
    else if (state.tab6Filter === "short") rows = rows.filter((r) => r.flag === "short");

    const body = rows.map((r) => {
      let flagHtml = "";
      if (r.flag === "over") flagHtml = '<span class="badge badge-flag-over">คงคลังเกินแต่ยังเบิก</span>';
      else if (r.flag === "short") flagHtml = '<span class="badge badge-flag-short">ใกล้หมด</span>';
      else if (!r.regular && (r.stock !== null || r.withdrawal > 0)) flagHtml = '<span class="muted" title="เบิกน้อยกว่า 6 จาก 12 เดือนในปี 68 — ไม่คิดธง">เบิกไม่สม่ำเสมอ</span>';
      return `<tr>
        <td class="left">${escapeHtml(r.item.name)}</td>
        <td class="num">${r.stock === null ? "–" : formatInt(r.stock)}</td>
        <td class="num">${formatInt(r.withdrawal)}</td>
        <td class="num">${fmt1(r.avg3)}</td>
        <td class="num">${r.cover === null ? "–" : fmt1(r.cover)}</td>
        <td>${flagHtml}</td>
      </tr>`;
    }).join("");

    detailHost.innerHTML = tableScroll(`<table class="admin-table">
      <thead><tr><th class="left">รายการ</th><th>คงเหลือ</th><th>เบิกเดือนนั้น</th><th>เฉลี่ยเบิก 3 เดือน</th><th>พอใช้อีก (เดือน)</th><th>ธง</th></tr></thead>
      <tbody>${body || `<tr><td colspan="6" class="left muted">ไม่มีรายการตามเงื่อนไข</td></tr>`}</tbody>
    </table>`);
  }

  function draw() {
    monthSelect.value = state.selectedMonth.type + ":" + state.selectedMonth.key;
    drawSummary();
    drawDetail();
  }

  draw();
}
