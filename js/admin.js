// Fake read-only admin dashboard (spec §2 / §5.2, phase-1 scope only).
// Every number here except the limit-mode toggle is cosmetic random data —
// deterministic (seeded), never real, and clearly labelled as such.
import { ACTIVE_STEPS, DEMO_ROUNDS } from "./constants.js";
import { loadAll, getStep, getItemRows } from "./data.js";
import * as store from "./store.js";
import { formatInt, formatMoney } from "./format.js";
import { _internal } from "./sim.js";

function rngFor(...parts) {
  return _internal.mulberry32(_internal.hashStringToSeed("admin|" + parts.join("|")));
}

const STATUS_OPTIONS = ["ยังไม่เริ่ม", "แบบร่าง", "ส่งแล้ว", "ส่งช้า", "รับเรื่องแล้ว"];

function randomStatus(pcuCode, monthKey) {
  const rand = rngFor("status", pcuCode, monthKey);
  const idx = Math.floor(rand() * STATUS_OPTIONS.length);
  return STATUS_OPTIONS[idx];
}

async function main() {
  const { form, limits } = await loadAll();
  const tabs = document.querySelectorAll(".admin-tab");
  const panels = document.querySelectorAll(".admin-panel");

  tabs.forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));
      tabBtn.classList.add("active");
      document.getElementById(tabBtn.dataset.panel).classList.add("active");
    });
  });

  renderRoundStatus(form);
  renderItemTotals(form);
  renderStockTable(form);
  renderLimitModeToggle();
}

function renderRoundStatus(form) {
  const host = document.getElementById("panel-status");
  const roundSelect = document.createElement("select");
  roundSelect.className = "select-input";
  DEMO_ROUNDS.forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r.monthKey;
    opt.textContent = `${r.label} (กำหนดส่ง ${r.deadlineLabel})`;
    roundSelect.appendChild(opt);
  });

  const tableHost = document.createElement("div");
  tableHost.className = "table-scroll";

  function draw() {
    const monthKey = roundSelect.value;
    const rows = form.pcus.map((pcu) => {
      const real = store.getRequest(pcu.code, monthKey);
      const status = real ? (real.status === "submitted" ? (real.late ? "ส่งช้า" : "ส่งแล้ว") : "แบบร่าง") : randomStatus(pcu.code, monthKey);
      return `<tr>
        <td>${pcu.code}</td>
        <td>${escapeHtml(pcu.name)}${pcu.group === "พิเศษ" ? " (พิเศษ)" : ""}</td>
        <td><span class="badge ${statusBadgeClass(status)}">${status}</span></td>
        <td>
          <button type="button" class="btn btn-secondary btn-sm" disabled title="ใช้ได้ใน phase 2">รับเรื่องแล้ว</button>
          <button type="button" class="btn btn-secondary btn-sm" disabled title="ใช้ได้ใน phase 2">ส่งกลับแก้ไข</button>
        </td>
      </tr>`;
    }).join("");
    tableHost.innerHTML = `<table class="admin-table">
      <thead><tr><th>รหัส</th><th>รพ.สต.</th><th>สถานะ</th><th>การดำเนินการ</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  roundSelect.addEventListener("change", draw);
  draw();

  host.innerHTML = "";
  const label = document.createElement("label");
  label.className = "field-label";
  label.textContent = "รอบเดือน: ";
  label.appendChild(roundSelect);
  host.appendChild(label);
  host.appendChild(tableHost);
}

function statusBadgeClass(status) {
  if (status === "ส่งแล้ว" || status === "รับเรื่องแล้ว") return "badge-success";
  if (status === "ส่งช้า") return "badge-danger";
  if (status === "แบบร่าง") return "badge-warn";
  return "badge-muted";
}

function renderItemTotals(form) {
  const host = document.getElementById("panel-totals");
  host.innerHTML = "";
  const tableHost = document.createElement("div");
  tableHost.className = "table-scroll";

  const stepSelect = document.createElement("select");
  stepSelect.className = "select-input";
  ACTIVE_STEPS.forEach((code) => {
    const step = getStep(form, code);
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = step.title;
    stepSelect.appendChild(opt);
  });

  function draw() {
    const step = getStep(form, stepSelect.value);
    const rows = getItemRows(step).map((item) => {
      const rand = rngFor("totals", item.code);
      const op = Math.floor(rand() * 200);
      const pp = Math.floor(rand() * 150);
      const qty = op + pp;
      const money = qty * item.price;
      return `<tr><td>${item.seq}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.unit || "")}</td><td>${formatInt(op)}</td><td>${formatInt(pp)}</td><td>${formatInt(qty)}</td><td>${formatMoney(money)}</td></tr>`;
    }).join("");
    tableHost.innerHTML = `<table class="admin-table">
      <thead><tr><th>ลำดับ</th><th>รายการ</th><th>หน่วย</th><th>OP</th><th>PP</th><th>รวม</th><th>เป็นเงิน</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  stepSelect.addEventListener("change", draw);
  draw();

  const label = document.createElement("label");
  label.className = "field-label";
  label.textContent = "ขั้นตอน: ";
  label.appendChild(stepSelect);
  host.appendChild(label);
  host.appendChild(tableHost);
}

function renderStockTable(form) {
  const host = document.getElementById("panel-stock");
  host.innerHTML = "";
  const tableHost = document.createElement("div");
  tableHost.className = "table-scroll";

  const stepSelect = document.createElement("select");
  stepSelect.className = "select-input";
  ACTIVE_STEPS.forEach((code) => {
    const step = getStep(form, code);
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = step.title;
    stepSelect.appendChild(opt);
  });

  function draw() {
    const step = getStep(form, stepSelect.value);
    const items = getItemRows(step);
    const headerRow = `<tr><th>รหัส รพ.สต.</th>${items.map((it) => `<th>${it.code}</th>`).join("")}</tr>`;
    const bodyRows = form.pcus.map((pcu) => {
      const cells = items.map((it) => {
        const rand = rngFor("stock", pcu.code, it.code);
        return `<td>${formatInt(Math.floor(rand() * 30))}</td>`;
      }).join("");
      return `<tr><td>${pcu.code}</td>${cells}</tr>`;
    }).join("");
    tableHost.innerHTML = `<table class="admin-table admin-table-wide">
      <thead>${headerRow}</thead>
      <tbody>${bodyRows}</tbody>
    </table>`;
  }

  stepSelect.addEventListener("change", draw);
  draw();

  const label = document.createElement("label");
  label.className = "field-label";
  label.textContent = "ขั้นตอน: ";
  label.appendChild(stepSelect);
  host.appendChild(label);
  host.appendChild(tableHost);
}

function renderLimitModeToggle() {
  const host = document.getElementById("panel-mode");
  host.innerHTML = "";
  const cur = store.getLimitMode();
  host.innerHTML = `
    <p>โหมดเพดานเบิกทั้งระบบ (มีผลจริงกับฝั่ง รพ.สต. ทันที):</p>
    <label class="radio-row"><input type="radio" name="limit-mode" value="warn" ${cur === "warn" ? "checked" : ""}> เตือน (ส่งได้แม้เกินเพดาน) — ค่าเริ่มต้น</label>
    <label class="radio-row"><input type="radio" name="limit-mode" value="enforce" ${cur === "enforce" ? "checked" : ""}> บังคับ (ส่งไม่ได้ถ้าเกินเพดาน)</label>
  `;
  host.querySelectorAll('input[name="limit-mode"]').forEach((r) => {
    r.addEventListener("change", (ev) => {
      store.setLimitMode(ev.target.value);
    });
  });
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

main().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<p style="color:red;padding:2rem">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(err.message)}</p>`;
});
