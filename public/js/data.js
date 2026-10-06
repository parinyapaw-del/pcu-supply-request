// Form-layout helpers (phase 2). The form (steps/items/prices) now arrives with the login bootstrap
// (`pcuBootstrap.form`, or `adminGetRequest.form` for the admin reprint) — there is no static JSON any more.
// The form object itself is `bootstrap.form` (app.boot.form); these are pure helpers over it. getStep / getItemRows keep their phase-1.5 signatures.

export function getStep(form, code) {
  return form.steps.find((s) => s.code === code) || null;
}

// Steps in wizard/print order (`order`, ties keep array order). Handles up to 10 steps.
export function getOrderedSteps(form) {
  return form.steps
    .map((step, i) => ({ step, i }))
    .sort((a, b) => (Number(a.step.order) || 0) - (Number(b.step.order) || 0) || a.i - b.i)
    .map((x) => x.step);
}

export function isItemActive(item) {
  return item.active !== false;
}

// All item rows (active or not) — kept as is for the admin frontend.
export function getItemRows(step) {
  return step.rows.filter((r) => r.type === "item");
}

// Only items shown to PCUs (active !== false).
export function getActiveItemRows(step) {
  return step.rows.filter((r) => r.type === "item" && isItemActive(r));
}
