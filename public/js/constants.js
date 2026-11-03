// Global constants (phase 2). FROZEN during checkpoint C3/C4 — shared by both frontends.
// Rounds are no longer constants: the backend decides the current/previous month (functions/API.md §1, §4.1).

export const STORAGE_PREFIX = "pcuSupply2:";
export const LAST_PCU_KEY = STORAGE_PREFIX + "lastPcu";

// Google Identity Services (Sign in with Google) OAuth Web Client ID — public identifier, safe to
// ship in a static site. Used by admin.html only.
export const GOOGLE_CLIENT_ID = "572074800379-jtl1af4cat6v8vk8u4r3o868r7lskfab.apps.googleusercontent.com";
