// Global constants for phase 1.5 (online, real backend). Mirrors backend Config.js ROUNDS —
// keep in sync with apps-script/Config.js if either changes (see API.md "Constants").
export const ROUNDS = [
  { month: "2025-09", label: "ก.ย. 2568", fy: 2568, deadlineLabel: "25 ก.ย. 2568", prevMonth: "2025-08", default: true },
  { month: "2025-10", label: "ต.ค. 2568", fy: 2569, deadlineLabel: "25 ต.ค. 2568", prevMonth: "2025-09", next: true },
];

// The 7 real form steps, in wizard order, plus the summary page (8 "steps" total for progress bars).
export const FORM_STEPS = ["P1", "P2", "P3", "P4", "P5", "CS", "LAB"];
export const WIZARD_STEPS = [...FORM_STEPS, "summary"];

// Items new for the 2569 form with no FY2568 history at all (spec §2.2).
export const NEW_2569_ITEMS = new Set(["P5-09", "CS-01"]);

export const STORAGE_PREFIX = "pcuSupply15:";
export const LAST_PCU_KEY = STORAGE_PREFIX + "lastPcu";

// Google Identity Services (Sign in with Google) OAuth Web Client ID — public identifier, safe to
// ship in a static site. Used by admin.html only.
export const GOOGLE_CLIENT_ID = "572074800379-jtl1af4cat6v8vk8u4r3o868r7lskfab.apps.googleusercontent.com";
