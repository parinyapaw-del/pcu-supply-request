// js/admin/compute.js — pure aggregation over the adminBootstrap / adminGetRequest payloads.
// No DOM, no API calls. The form arrives in adminBootstrap.form (functions/API.md §5.1).

export const DISPENSE_UNITS = ["พัสดุ", "จ่ายกลาง", "LAB"];
export const DISPENSE_FALLBACK = { P: "พัสดุ", CS: "จ่ายกลาง", LAB: "LAB" };

function unitFromStepCode(code) {
  if (/^P\d/.test(code)) return "พัสดุ";
  if (code === "CS") return "จ่ายกลาง";
  if (code === "LAB") return "LAB";
  return "พัสดุ";
}

// Catalogue of the form: ordered steps + flat items + lookup by code.
// Item = { code, name, unit, price, active, stepCode, stepOrder, pageNo, sheet, title, section, dispenseUnit }
export function buildCatalog(form) {
  const cat = { steps: [], items: [], byCode: {}, stepByCode: {} };
  if (form) addForm(cat, form);
  return cat;
}

// Merge another form version (e.g. the one a request is bound to) — only adds unknown codes/steps.
export function addForm(cat, form) {
  const steps = (form.steps || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  steps.forEach((s) => {
    let stepInfo = cat.stepByCode[s.code];
    if (!stepInfo) {
      stepInfo = {
        code: s.code, order: s.order || cat.steps.length + 1, sheet: s.sheet || s.code, pageNo: s.page_no || s.order,
        title: s.title || "", dispenseUnit: s.dispense_unit || unitFromStepCode(s.code)
      };
      cat.steps.push(stepInfo);
      cat.stepByCode[s.code] = stepInfo;
    }
    let section = "";
    (s.rows || []).forEach((r) => {
      if (r.type === "section") { section = r.title || ""; return; }
      if (r.type !== "item" || cat.byCode[r.code]) return;
      const item = {
        code: r.code, name: r.name || r.code, unit: r.unit || "", price: Number(r.price) || 0, active: r.active !== false,
        stepCode: s.code, stepOrder: stepInfo.order, pageNo: stepInfo.pageNo, sheet: stepInfo.sheet,
        title: stepInfo.title, section, dispenseUnit: stepInfo.dispenseUnit
      };
      cat.items.push(item);
      cat.byCode[r.code] = item;
    });
  });
  cat.steps.sort((a, b) => a.order - b.order);
  cat.items.sort((a, b) => a.stepOrder - b.stepOrder || a.code.localeCompare(b.code, "en", { numeric: true }));
  return cat;
}

export function itemOrPlaceholder(cat, code) {
  return cat.byCode[code] || {
    code, name: code + " (ไม่อยู่ในฟอร์มปัจจุบัน)", unit: "", price: 0, active: false, stepCode: "?", stepOrder: 99,
    pageNo: 99, sheet: "อื่น ๆ", title: "", section: "", dispenseUnit: ""
  };
}

export function isUsableStatus(status) { return status === "submitted" || status === "issued"; }

// ---- per-request / per-month aggregation -----------------------------------------------------------
// price used for a line: snapshot taken at submit, else the form price.
export function linePrice(line, item) {
  const p = line && line.price_snapshot;
  return p !== null && p !== undefined ? Number(p) : (item ? item.price : 0);
}

// requests: [{pcu, request:{status, lines}}] (only usable statuses are counted)
// -> { byItem: { code: { op, pp, total, baht, issued: number|null, pcuCount, byPcu: {pcu:{op,pp}} } }, baht, op, pp, bahtOp, bahtPp }
export function aggregateRequests(cat, entries) {
  const byItem = {};
  let op = 0, pp = 0, bahtOp = 0, bahtPp = 0;
  entries.forEach(({ pcu, request }) => {
    if (!request || !isUsableStatus(request.status)) return;
    Object.entries(request.lines || {}).forEach(([code, line]) => {
      const lop = Number(line.op) || 0, lpp = Number(line.pp) || 0;
      const issued = line.issued_total;
      if (lop === 0 && lpp === 0 && (issued === null || issued === undefined)) return;
      const item = itemOrPlaceholder(cat, code);
      const price = linePrice(line, item);
      const r = byItem[code] || (byItem[code] = { op: 0, pp: 0, total: 0, baht: 0, issued: null, pcuCount: 0, byPcu: {} });
      r.op += lop; r.pp += lpp; r.total += lop + lpp; r.baht += (lop + lpp) * price;
      if (lop + lpp > 0) r.pcuCount += 1;
      if (issued !== null && issued !== undefined) r.issued = (r.issued || 0) + Number(issued);
      r.byPcu[pcu] = { op: lop, pp: lpp };
      op += lop; pp += lpp; bahtOp += lop * price; bahtPp += lpp * price;
    });
  });
  return { byItem, op, pp, bahtOp, bahtPp, baht: bahtOp + bahtPp };
}

// ---- plans (fy_current) --------------------------------------------------------------------------
// plans: { pcu: { code: [op, pp] } } x form price -> { pcu: {op, pp, total} } baht
export function planBahtByPcu(plans, cat) {
  const out = {};
  Object.entries(plans || {}).forEach(([pcu, items]) => {
    let op = 0, pp = 0;
    Object.entries(items).forEach(([code, v]) => {
      const price = (cat.byCode[code] || { price: 0 }).price;
      op += (v[0] || 0) * price;
      pp += (v[1] || 0) * price;
    });
    out[pcu] = { op, pp, total: op + pp };
  });
  return out;
}

// ---- previous fiscal year (read-only tab) -----------------------------------------------------------
// prevEntry = { months, actual:{pcu:{code:{op:[],pp:[]}}}, plans:{pcu:{code:[op,pp]}}, prices:{code:price} }
export function prevHeatmap(prevEntry, pcus) {
  const nMonths = prevEntry.months.length;
  const matrix = {};
  let max = 0;
  pcus.forEach((p) => {
    const row = new Array(nMonths).fill(0);
    Object.entries((prevEntry.actual || {})[p.code] || {}).forEach(([code, a]) => {
      const price = Number((prevEntry.prices || {})[code]) || 0;
      for (let m = 0; m < nMonths; m++) row[m] += ((a.op[m] || 0) + (a.pp[m] || 0)) * price;
    });
    row.forEach((v) => { if (v > max) max = v; });
    matrix[p.code] = row;
  });
  return { matrix, max };
}

// rows per item for one PCU (or all PCUs when pcuCode === "*"): plan op/pp, actual op/pp (annual), baht.
export function prevPlanVsActual(prevEntry, cat, pcuCode, pcus) {
  const codes = pcuCode === "*" ? pcus.map((p) => p.code) : [pcuCode];
  const acc = {};
  const row = (code) => acc[code] || (acc[code] = { code, planOp: 0, planPp: 0, actOp: 0, actPp: 0 });
  codes.forEach((pc) => {
    Object.entries(((prevEntry.plans || {})[pc]) || {}).forEach(([code, v]) => {
      const r = row(code); r.planOp += v[0] || 0; r.planPp += v[1] || 0;
    });
    Object.entries(((prevEntry.actual || {})[pc]) || {}).forEach(([code, a]) => {
      const r = row(code);
      for (let m = 0; m < prevEntry.months.length; m++) { r.actOp += a.op[m] || 0; r.actPp += a.pp[m] || 0; }
    });
  });
  const rows = Object.values(acc).map((r) => {
    const item = itemOrPlaceholder(cat, r.code);
    const price = Number((prevEntry.prices || {})[r.code]) || 0;
    const plan = r.planOp + r.planPp, act = r.actOp + r.actPp;
    return {
      ...r, item, price, plan, act, planBaht: plan * price, actBaht: act * price,
      pct: plan > 0 ? (act / plan) * 100 : (act > 0 ? Infinity : null)
    };
  }).filter((r) => r.plan > 0 || r.act > 0);
  rows.sort((a, b) => a.item.stepOrder - b.item.stepOrder || a.code.localeCompare(b.code, "en", { numeric: true }));
  return rows;
}

// ---- limits (fy_current) ----------------------------------------------------------------------------
export function planFor(plans, pcu, code) {
  const v = ((plans || {})[pcu] || {})[code];
  return v ? [v[0] || 0, v[1] || 0] : [0, 0];
}

// ---- issue / จ่ายจริง (2c) --------------------------------------------------------------------------
export const ISSUE_REASONS = { out_of_stock: "ของหมด/รอจัดซื้อ", other: "อื่น ๆ" };

// OP-first split (phase 2.md §5.4): the shortfall is taken from OP first, then PP.
// Returns {op, pp} or null when issuedTotal is null/undefined (= not recorded yet).
export function splitIssued(op, pp, issuedTotal) {
  if (issuedTotal === null || issuedTotal === undefined || issuedTotal === "") return null;
  const o = Number(op) || 0, p = Number(pp) || 0;
  const short = Math.max(0, o + p - Number(issuedTotal));
  return { op: Math.max(0, o - short), pp: p - Math.max(0, short - o) };
}

// Issued baht of loaded requests (entries from requests.js loadMonth): Σ issued_op × price, issued_pp × price
// (price = price_snapshot ?? form price). Lines without issued data count as 0.
// -> { op, pp, total, recorded: n requests having ≥ 1 issued line, unrecorded: n requests with none }
export function aggregateIssued(cat, entries) {
  let op = 0, pp = 0, recorded = 0, unrecorded = 0;
  entries.forEach(({ request }) => {
    if (!request || !isUsableStatus(request.status)) return;
    let any = false, requested = false;
    Object.entries(request.lines || {}).forEach(([code, line]) => {
      if ((Number(line.op) || 0) + (Number(line.pp) || 0) > 0) requested = true;
      if (line.issued_total === null || line.issued_total === undefined) return;
      any = true;
      const price = linePrice(line, itemOrPlaceholder(cat, code));
      op += (Number(line.issued_op) || 0) * price;
      pp += (Number(line.issued_pp) || 0) * price;
    });
    if (any) recorded += 1; else if (requested) unrecorded += 1;
  });
  return { op, pp, total: op + pp, recorded, unrecorded };
}
