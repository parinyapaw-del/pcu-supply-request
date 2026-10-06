// Loads the static form layout (data/form2569.json — public, non-sensitive: item names/units/
// prices/step layout only, no PCU data). Fetched once, cached in module state.
// NOTE: loadFormData / getStep / getItemRows are imported by the admin frontend too (checkpoint
// C4) — keep these three exported with the same signatures even when adding/removing others.
import { FORM_STEPS } from "./constants.js";

let formDataPromise = null;

export function loadFormData() {
  if (!formDataPromise) {
    formDataPromise = fetch("data/form2569.json").then((r) => {
      if (!r.ok) throw new Error("โหลด data/form2569.json ไม่สำเร็จ (" + r.status + ")");
      return r.json();
    });
  }
  return formDataPromise;
}

export function getStep(form, code) {
  return form.steps.find((s) => s.code === code) || null;
}

export function getFormSteps(form) {
  return FORM_STEPS.map((code) => getStep(form, code)).filter(Boolean);
}

export function getItemRows(step) {
  return step.rows.filter((r) => r.type === "item");
}

export function getAllItemRows(form) {
  const out = [];
  form.steps.forEach((step) => {
    getItemRows(step).forEach((item) => out.push({ item, step }));
  });
  return out;
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
