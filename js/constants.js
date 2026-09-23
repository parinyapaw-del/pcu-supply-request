// Global constants for the phase-1 prototype.
// Phase 1 only activates two of the seven steps in form2569.json.
export const ACTIVE_STEPS = ["P1", "LAB"];

// Fixed demo rounds (months a PCU can currently fill). CE (Gregorian) monthKey "YYYY-MM".
// Labels/deadlines use the Buddhist-era year printed on the form (BE = CE + 543).
export const DEMO_ROUNDS = [
  { monthKey: "2026-09", label: "ก.ย. 2569", fy: 2569, deadline: "2026-09-25", deadlineLabel: "25 ก.ย. 2569" },
  { monthKey: "2026-10", label: "ต.ค. 2569", fy: 2570, deadline: "2026-10-25", deadlineLabel: "25 ต.ค. 2569" },
];

// Item codes that carry a simulated demand ceiling in data/limits_demo.json.
export const LIMIT_ITEM_CODES = ["P1-01", "LAB-03", "LAB-04"];

export const STORAGE_PREFIX = "pcuSupply2569:v1:";

export const LIMIT_MODE_KEY = STORAGE_PREFIX + "limitMode";
export const LAST_PCU_KEY = STORAGE_PREFIX + "lastPcu";

export const DEFAULT_LIMIT_MODE = "warn"; // "warn" | "enforce"

// Phase 2 (Google Identity Services admin sign-in) OAuth Web Client ID.
// Not a secret — client IDs are public identifiers, safe to ship in a static
// site. Unused in phase 1; reserved so phase 2 doesn't need this file touched.
export const GOOGLE_CLIENT_ID = "572074800379-jtl1af4cat6v8vk8u4r3o868r7lskfab.apps.googleusercontent.com";
