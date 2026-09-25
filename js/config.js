// config.js — API endpoint configuration (phase 1.5). API_URL_PROD = the Apps Script web-app
// deployment (same deployment ID is updated in place, so the URL is stable); localhost -> dev server.
export const API_URL_PROD = "https://script.google.com/macros/s/AKfycbxpH3ciSD_F3Wsnlk7WcqV6tGsqYmyDEryk3N-7xqYfL90-xqHCqpwLVVDEzq7n-mraZA/exec";

function resolveApiUrl() {
  try {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") return "/api";
  } catch (err) {
    // no `window` (e.g. running under Node for tooling) — fall through to prod URL
  }
  return API_URL_PROD;
}

export const API_URL = resolveApiUrl();
