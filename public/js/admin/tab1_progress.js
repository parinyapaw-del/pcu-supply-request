// Tab 1 — ความคืบหน้ารอบทดลอง (phase 1.5.md §4 item 1 / API.md adminRequests).
import { escapeHtml, tableScroll, statusBadgeInfo, displayStatus, formatBangkokDateTime, fmtPct } from "./util.js";
import { lastStepIndex } from "./compute.js";

const AUTO_REFRESH_MS = 60000;

export function renderTab1(container, ctx) {
  const { state } = ctx;
  const rounds = state.bootstrap.rounds;
  if (!state.tab1Round) state.tab1Round = (rounds.find((r) => r.default) || rounds[0]).month;

  container.innerHTML = "";
  const toolbar = document.createElement("div");
  toolbar.className = "admin-toolbar";

  const label = document.createElement("label");
  label.textContent = "รอบทดลอง:";
  const select = document.createElement("select");
  select.className = "select-input";
  rounds.forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r.month;
    opt.textContent = `รอบทดลอง ${r.label}`;
    if (r.month === state.tab1Round) opt.selected = true;
    select.appendChild(opt);
  });
  label.appendChild(select);
  toolbar.appendChild(label);

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "btn btn-secondary btn-sm";
  refreshBtn.textContent = "รีเฟรช";
  toolbar.appendChild(refreshBtn);

  const statusLine = document.createElement("span");
  statusLine.className = "muted";
  statusLine.style.fontSize = "0.85rem";
  toolbar.appendChild(statusLine);

  container.appendChild(toolbar);
  const tableHost = document.createElement("div");
  container.appendChild(tableHost);

  select.addEventListener("change", () => {
    state.tab1Round = select.value;
    load();
  });
  refreshBtn.addEventListener("click", load);

  async function load() {
    tableHost.innerHTML = '<div class="admin-loading-block"><div class="admin-spinner"></div>กำลังโหลดความคืบหน้า...</div>';
    try {
      const data = await ctx.adminCall("adminRequests", {});
      draw(data.requests, data.server_time);
    } catch (err) {
      tableHost.innerHTML = `<p class="admin-err-text">โหลดไม่สำเร็จ: ${escapeHtml(err.message || String(err))}</p>`;
    }
  }

  function draw(requests, serverTime) {
    const roundMonth = state.tab1Round;
    const byPcu = {};
    requests.filter((r) => r.month === roundMonth).forEach((r) => { byPcu[r.pcu] = r; });
    const hidden = state.bootstrap.hidden || {};
    const totalItems = state.items.length;

    const rows = state.bootstrap.pcus.map((pcu) => {
      const req = byPcu[pcu.code] || null;
      const status = displayStatus(req);
      const badge = statusBadgeInfo(status);
      const progress = req ? req.progress : {
        last_step: "", stock_filled: 0,
        stock_required: totalItems - ((hidden[pcu.code] || []).length),
        items_requested: 0, baht_2569: 0
      };
      const stepIdx = lastStepIndex(progress.last_step);
      const stockPct = progress.stock_required > 0 ? (progress.stock_filled / progress.stock_required) * 100 : null;
      const canReceive = req && req.status === "submitted";
      const canReturn = req && req.status === "submitted";
      const printUrl = `index.html#/print?pcu=${encodeURIComponent(pcu.code)}&month=${encodeURIComponent(roundMonth)}&as=admin`;
      return `<tr>
        <td class="left">${pcu.code}</td>
        <td class="left">${escapeHtml(pcu.name)}${pcu.group === "พิเศษ" ? ' <span class="pcu-group-tag">(พิเศษ)</span>' : ""}</td>
        <td><span class="badge ${badge.cls}">${badge.label}</span>${req && req.return_reason ? `<div class="ghost-line" title="${escapeHtml(req.return_reason)}">เหตุผล: ${escapeHtml(req.return_reason.slice(0, 40))}${req.return_reason.length > 40 ? "…" : ""}</div>` : ""}</td>
        <td class="num">${stepIdx}/8</td>
        <td class="num">${progress.stock_filled}/${progress.stock_required} (${fmtPct(stockPct)})</td>
        <td class="num">${progress.items_requested}</td>
        <td class="num">${(progress.baht_2569 || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td class="left">${formatBangkokDateTime(req ? req.updated_at : "")}</td>
        <td class="left">${escapeHtml((req && req.submitter_name) || "-")}</td>
        <td class="left">
          <button type="button" class="btn btn-secondary btn-sm" data-act="receive" data-pcu="${pcu.code}" ${canReceive ? "" : "disabled"}>รับเรื่องแล้ว</button>
          <button type="button" class="btn btn-secondary btn-sm" data-act="return" data-pcu="${pcu.code}" ${canReturn ? "" : "disabled"}>ส่งกลับแก้ไข</button>
          <a class="btn btn-link btn-sm" href="${printUrl}" target="_blank" rel="noopener">พิมพ์ใบ</a>
        </td>
      </tr>`;
    }).join("");

    tableHost.innerHTML = tableScroll(`<table class="admin-table admin-table-wide">
      <thead><tr>
        <th class="left">รหัส</th><th class="left">รพ.สต.</th><th>สถานะ</th><th>Step</th>
        <th>คงเหลือครบ</th><th>รายการที่ขอ</th><th>บาท (2569)</th>
        <th class="left">บันทึกล่าสุด</th><th class="left">ผู้กรอก</th><th class="left">การดำเนินการ</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`);

    statusLine.textContent = `เซิร์ฟเวอร์เวลา ${formatBangkokDateTime(serverTime)}`;

    tableHost.querySelectorAll('button[data-act="receive"]').forEach((btn) => {
      btn.addEventListener("click", () => doReceive(btn.dataset.pcu));
    });
    tableHost.querySelectorAll('button[data-act="return"]').forEach((btn) => {
      btn.addEventListener("click", () => doReturn(btn.dataset.pcu));
    });
  }

  async function doReceive(pcu) {
    try {
      const data = await ctx.adminCall("adminReceive", { pcu, month: state.tab1Round });
      ctx.upsertRequest(data.request);
      load();
    } catch (err) {
      alert("รับเรื่องไม่สำเร็จ: " + (err.message || err));
    }
  }

  async function doReturn(pcu) {
    const reason = window.prompt("เหตุผลที่ส่งกลับแก้ไข (จำเป็นต้องกรอก):", "");
    if (reason === null) return;
    if (!reason.trim()) { alert("กรุณาระบุเหตุผล"); return; }
    try {
      const data = await ctx.adminCall("adminReturn", { pcu, month: state.tab1Round, reason: reason.trim() });
      ctx.upsertRequest(data.request);
      load();
    } catch (err) {
      alert("ส่งกลับไม่สำเร็จ: " + (err.message || err));
    }
  }

  load();

  return {
    onShow() {
      this._interval = setInterval(load, AUTO_REFRESH_MS);
    },
    onHide() {
      if (this._interval) clearInterval(this._interval);
    }
  };
}
