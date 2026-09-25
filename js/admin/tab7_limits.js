// Tab 7 — เพดานเบิก — phase 1.5.md §4 item 7 / §2.4 / §9 criterion 4.
import { formatInt } from "../format.js";
import { escapeHtml, tableScroll, formatBangkokDateTime } from "./util.js";
import { STEP_CODES, limitsRowsForPcu } from "./compute.js";

function numOrNull(v) {
  const s = String(v).trim();
  if (s === "") return null;
  const n = Number(s);
  return isFinite(n) ? Math.round(n) : NaN;
}

export function renderTab7(container, ctx) {
  const { state } = ctx;
  if (!state.tab7Pcu) state.tab7Pcu = state.bootstrap.pcus[0].code;

  container.innerHTML = "";

  // ---- global mode switch ----
  const modeCard = document.createElement("div");
  modeCard.className = "admin-card";
  const mode = state.bootstrap.config.limit_mode;
  modeCard.innerHTML = `<h2>โหมดเพดานทั้งระบบ</h2>
    <label class="radio-row"><input type="radio" name="limit-mode" value="warn" ${mode === "warn" ? "checked" : ""}> เตือน (ส่งได้แม้เกินเพดาน) — ค่าเริ่มต้น</label>
    <label class="radio-row"><input type="radio" name="limit-mode" value="enforce" ${mode === "enforce" ? "checked" : ""}> บังคับ (ส่งไม่ได้ถ้าเกินเพดาน)</label>`;
  container.appendChild(modeCard);

  modeCard.querySelectorAll('input[name="limit-mode"]').forEach((radio) => {
    radio.addEventListener("change", async (ev) => {
      const newMode = ev.target.value;
      if (newMode === "enforce" && !window.confirm("เปลี่ยนเป็นโหมดบังคับ? รพ.สต. จะส่งใบไม่ได้ถ้าเกินเพดานรายการใด ๆ")) {
        ev.target.checked = false;
        modeCard.querySelector(`input[value="${mode}"]`).checked = true;
        return;
      }
      try {
        const data = await ctx.adminCall("adminSetMode", { mode: newMode });
        state.bootstrap.config = data.config;
      } catch (err) {
        alert("เปลี่ยนโหมดไม่สำเร็จ: " + (err.message || err));
        renderTab7(container, ctx);
      }
    });
  });

  // ---- PCU picker ----
  const toolbar = document.createElement("div");
  toolbar.className = "admin-toolbar";
  const pcuLabel = document.createElement("label");
  pcuLabel.textContent = "รพ.สต.:";
  const pcuSelect = document.createElement("select");
  pcuSelect.className = "select-input";
  state.bootstrap.pcus.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.code; opt.textContent = `${p.code} ${p.name}`;
    if (p.code === state.tab7Pcu) opt.selected = true;
    pcuSelect.appendChild(opt);
  });
  pcuLabel.appendChild(pcuSelect);
  toolbar.appendChild(pcuLabel);
  container.appendChild(toolbar);

  const tableHost = document.createElement("div");
  container.appendChild(tableHost);

  pcuSelect.addEventListener("change", () => { state.tab7Pcu = pcuSelect.value; draw(); });

  function draw() {
    const pcu = state.tab7Pcu;
    const rows = limitsRowsForPcu(state.bootstrap, state.items, pcu);
    const bySt = {};
    rows.forEach((r) => { (bySt[r.item.step] = bySt[r.item.step] || []).push(r); });

    const html = [];
    STEP_CODES.forEach((step) => {
      const stepRows = bySt[step];
      if (!stepRows) return;
      html.push(`<tr class="group-row"><td colspan="9">${step}</td></tr>`);
      stepRows.forEach((r) => {
        const srcCls = r.source === "admin" ? "badge-src-admin" : "badge-src-stat68";
        const srcLabel = r.source === "admin" ? "admin" : "stat68";
        const srcTitle = r.updated_by ? `${r.updated_by} · ${formatBangkokDateTime(r.updated_at)}` : "";
        html.push(`<tr data-code="${r.item.code}">
          <td class="left">${escapeHtml(r.item.name)}</td>
          <td class="left">${escapeHtml(r.item.unit)}</td>
          <td class="num">${formatInt(r.median_m)}</td>
          <td class="num">${formatInt(r.p90_m)}</td>
          <td class="num">${formatInt(r.annual_qty)}</td>
          <td><input type="text" inputmode="numeric" class="limit-input" data-field="limit_month" value="${r.limit_month === null || r.limit_month === undefined ? "" : r.limit_month}"></td>
          <td><input type="text" inputmode="numeric" class="limit-input" data-field="limit_year" value="${r.limit_year === null || r.limit_year === undefined ? "" : r.limit_year}"></td>
          <td><span class="badge ${srcCls}" title="${escapeHtml(srcTitle)}">${srcLabel}</span><span class="cell-status" data-status></span></td>
          <td><button type="button" class="btn btn-link btn-sm" data-reset>คืนค่าสถิติ 68</button></td>
        </tr>`);
      });
    });

    tableHost.innerHTML = tableScroll(`<table class="admin-table admin-table-wide">
      <thead><tr>
        <th class="left">รายการ</th><th class="left">หน่วย</th>
        <th>median (เดือน)</th><th>P90 (เดือน)</th><th>ยอดปี</th>
        <th>เพดาน/เดือน</th><th>เพดาน/ปี</th><th>ที่มา</th><th></th>
      </tr></thead>
      <tbody>${html.join("")}</tbody>
    </table>`);

    tableHost.querySelectorAll("tr[data-code]").forEach((tr) => {
      const code = tr.dataset.code;
      const monthInput = tr.querySelector('input[data-field="limit_month"]');
      const yearInput = tr.querySelector('input[data-field="limit_year"]');
      const statusEl = tr.querySelector("[data-status]");
      const srcBadge = tr.querySelector(".badge");

      let prevMonth = monthInput.value, prevYear = yearInput.value;

      async function save() {
        const lm = numOrNull(monthInput.value);
        const ly = numOrNull(yearInput.value);
        if (Number.isNaN(lm) || Number.isNaN(ly) || (lm !== null && lm < 0) || (ly !== null && ly < 0)) {
          statusEl.textContent = "ค่าไม่ถูกต้อง"; statusEl.className = "cell-status err";
          monthInput.classList.add("save-error"); yearInput.classList.add("save-error");
          return;
        }
        const prevLm = prevMonth === "" ? null : Number(prevMonth);
        const prevLy = prevYear === "" ? null : Number(prevYear);
        if (lm === prevLm && ly === prevLy) return; // unchanged, skip the call
        statusEl.textContent = "กำลังบันทึก..."; statusEl.className = "cell-status";
        try {
          const data = await ctx.adminCall("adminSetLimit", { pcu, code, limit_month: lm, limit_year: ly });
          state.bootstrap.limits[pcu] = state.bootstrap.limits[pcu] || {};
          state.bootstrap.limits[pcu][code] = data.limit;
          prevMonth = lm === null ? "" : String(lm);
          prevYear = ly === null ? "" : String(ly);
          monthInput.classList.remove("save-error"); yearInput.classList.remove("save-error");
          statusEl.textContent = "บันทึกแล้ว ✓"; statusEl.className = "cell-status ok";
          srcBadge.textContent = "admin"; srcBadge.className = "badge badge-src-admin";
          srcBadge.title = `${data.limit.updated_by} · ${formatBangkokDateTime(data.limit.updated_at)}`;
          setTimeout(() => { if (statusEl.textContent === "บันทึกแล้ว ✓") statusEl.textContent = ""; }, 3000);
        } catch (err) {
          monthInput.value = prevMonth; yearInput.value = prevYear;
          monthInput.classList.add("save-error"); yearInput.classList.add("save-error");
          statusEl.textContent = "บันทึกไม่สำเร็จ"; statusEl.className = "cell-status err";
        }
      }

      [monthInput, yearInput].forEach((input) => {
        input.addEventListener("blur", save);
        input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); input.blur(); } });
      });

      tr.querySelector("[data-reset]").addEventListener("click", async () => {
        try {
          const data = await ctx.adminCall("adminResetLimit", { pcu, code });
          state.bootstrap.limits[pcu] = state.bootstrap.limits[pcu] || {};
          state.bootstrap.limits[pcu][code] = data.limit;
          monthInput.value = data.limit.limit_month === null ? "" : data.limit.limit_month;
          yearInput.value = data.limit.limit_year === null ? "" : data.limit.limit_year;
          prevMonth = monthInput.value; prevYear = yearInput.value;
          monthInput.classList.remove("save-error"); yearInput.classList.remove("save-error");
          srcBadge.textContent = "stat68"; srcBadge.className = "badge badge-src-stat68";
          srcBadge.title = "";
          statusEl.textContent = "คืนค่าแล้ว ✓"; statusEl.className = "cell-status ok";
          setTimeout(() => { if (statusEl.textContent === "คืนค่าแล้ว ✓") statusEl.textContent = ""; }, 3000);
        } catch (err) {
          alert("คืนค่าไม่สำเร็จ: " + (err.message || err));
        }
      });
    });
  }

  draw();
}
