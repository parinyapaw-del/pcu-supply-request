// PCU login/logout — thin wrapper around js/api.js for the login page + router guard.
import { call, ApiError, getPcuToken, setPcuToken, clearPcuToken, decodeTokenPayload } from "./api.js";
import * as store from "./store.js";

export function isLoggedIn() {
  return !!getPcuToken();
}

// The PCU code carried by the current token, WITHOUT re-verifying it server-side — for routing/UI
// only (which PCU's page to show before pcuBootstrap confirms it). Never trust for authorization.
export function tokenPcuCode() {
  const payload = decodeTokenPayload(getPcuToken());
  return payload && payload.t === "pcu" ? payload.pcu : null;
}

export async function fetchPcuList() {
  const data = await call("pcuList");
  return data.pcus;
}

export async function login(pcu, pin) {
  const data = await call("pcuLogin", { pcu, pin });
  setPcuToken(data.token, data.exp);
  store.setLastPcu(pcu);
  return data;
}

export function logout() {
  clearPcuToken();
}

export function isAuthError(err) {
  return err instanceof ApiError && String(err.code || "").indexOf("AUTH_") === 0;
}
