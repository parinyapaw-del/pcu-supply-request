// Loads the static JSON data (form + demo limits). Fetched once, cached in module state.
import { ACTIVE_STEPS } from "./constants.js";

let formDataPromise = null;
let limitsDataPromise = null;

export function loadFormData() {
  if (!formDataPromise) {
    formDataPromise = fetch("data/form2569.json").then((r) => {
      if (!r.ok) throw new Error("โหลด data/form2569.json ไม่สำเร็จ (" + r.status + ")");
      return r.json();
    });
  }
  return formDataPromise;
}

export function loadLimitsData() {
  if (!limitsDataPromise) {
    limitsDataPromise = fetch("data/limits_demo.json").then((r) => {
      if (!r.ok) throw new Error("โหลด data/limits_demo.json ไม่สำเร็จ (" + r.status + ")");
      return r.json();
    });
  }
  return limitsDataPromise;
}

export async function loadAll() {
  const [form, limits] = await Promise.all([loadFormData(), loadLimitsData()]);
  return { form, limits };
}

export function getStep(form, code) {
  return form.steps.find((s) => s.code === code) || null;
}

export function getActiveSteps(form) {
  return ACTIVE_STEPS.map((code) => getStep(form, code)).filter(Boolean);
}

export function getItemRows(step) {
  return step.rows.filter((r) => r.type === "item");
}

export function findItem(form, itemCode) {
  for (const step of form.steps) {
    const found = step.rows.find((r) => r.type === "item" && r.code === itemCode);
    if (found) return { item: found, step };
  }
  return null;
}

export function getPcu(form, code) {
  return form.pcus.find((p) => p.code === code) || null;
}
