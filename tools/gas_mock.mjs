// gas_mock.mjs — in-memory/in-process mock of the Google Apps Script runtime, just enough of it
// for apps-script/*.js to run unmodified under Node (used by dev_server.mjs and test_api.mjs).
//
// Design: every apps-script/*.js file is concatenated (in a fixed, safe order — see ORDER below)
// into one Node vm Script and run once against a fresh sandbox object that plays the role of the
// GAS global object. Top-level function declarations (doPost, doGet, setup, ...) become
// properties of that sandbox, so callers just do `runtime.call('doPost', e)`.
//
// State model: `state = { sheets: { name: { data: [[...header]], [...row], ... ]] } }, properties: {} }`.
// A "sheet" is stored as ONE 2D array including the header row (row 0). Ranges auto-grow the grid
// on read or write, mirroring how a real Sheet silently expands. getLastRow()/getLastColumn()
// deliberately return the FULL grid size rather than tightly scanning for the true content edge —
// Db.js already treats trailing blank rows as absent (see readRaw_), so this is a safe
// simplification that keeps the mock small.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";

const FILE_ORDER = ["Config.js", "Db.js", "Auth.js", "Requests.js", "Pcu.js", "Admin.js", "Setup.js", "Main.js"];

// ---------------------------------------------------------------------------------------------
// Byte helpers (GAS returns Java-style SIGNED byte arrays from computeDigest / HMAC / base64Decode)
function toSignedBytes(buf) {
  const out = new Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    out[i] = b > 127 ? b - 256 : b;
  }
  return out;
}

function toUnsignedBuffer(byteArrayOrString) {
  if (typeof byteArrayOrString === "string") return Buffer.from(byteArrayOrString, "utf8");
  const arr = byteArrayOrString.map((b) => (b < 0 ? b + 256 : b) & 0xff);
  return Buffer.from(arr);
}

function b64Standard(input) {
  return toUnsignedBuffer(input).toString("base64");
}

function b64WebSafe(input) {
  return b64Standard(input).replace(/\+/g, "-").replace(/\//g, "_");
}

function fromB64WebSafe(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  return toSignedBytes(Buffer.from(s, "base64"));
}

function fromB64Standard(str) {
  return toSignedBytes(Buffer.from(str, "base64"));
}

// ---------------------------------------------------------------------------------------------
// Sheets / Spreadsheet mock

function blankRow(len) {
  return new Array(len).fill("");
}

function ensureGridSize(grid, rows, cols) {
  while (grid.length < rows) grid.push(blankRow(grid[0] ? grid[0].length : cols));
  for (let r = 0; r < grid.length; r++) {
    while (grid[r].length < cols) grid[r].push("");
  }
}

// Emulates Google Sheets parsing strings written via setValues into a column that is not
// formatted as plain text: numeric strings become numbers, date-like strings become Dates.
// (A real bug: "2024-10" month keys came back as Date objects.)
function sheetsAutoParse(v) {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(t)) return Number(t);
  if (/^\d{4}-\d{1,2}(-\d{1,2})?([T ][\d:.]+Z?)?$/.test(t)) {
    const d = new Date(/^\d{4}-\d{1,2}$/.test(t) ? t + "-01T00:00:00+07:00" : t);
    if (!isNaN(d.getTime())) return d;
  }
  return v;
}

const MOCK_NEW_SHEET_ROWS = 1000;

class MockRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row; this.col = col; this.numRows = numRows; this.numCols = numCols;
    // Real Sheets: a range past the grid's last row throws (columns auto-extend here for simplicity).
    if (row + numRows - 1 > sheet.grid.length) {
      throw new Error("The coordinates of the range are outside the dimensions of the sheet.");
    }
    ensureGridSize(sheet.grid, row + numRows - 1, col + numCols - 1);
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = this.sheet.grid[this.row - 1 + r][this.col - 1 + c];
        row.push(v === undefined ? "" : v);
      }
      out.push(row);
    }
    return out;
  }
  setValues(values) {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) {
        const v = values[r] ? values[r][c] : "";
        const col = this.col + c;
        this.sheet.grid[this.row - 1 + r][this.col - 1 + c] =
          v === undefined ? "" : this.sheet.isTextCol(col) ? v : sheetsAutoParse(v);
      }
    }
    this.sheet.touch();
    return this;
  }
  // Only "@" (plain text) matters to the mock: it disables Sheets' auto-parsing for those columns.
  setNumberFormat(fmt) {
    for (let c = 0; c < this.numCols; c++) this.sheet.setTextCol(this.col + c, fmt === "@");
    return this;
  }
  getValue() { return this.getValues()[0][0]; }
  setValue(v) { return this.setValues([[v]]); }
  clearContent() { return this.setValues(Array.from({ length: this.numRows }, () => blankRow(this.numCols))); }
  clear() { return this.clearContent(); }
}

class MockSheet {
  constructor(name, grid, onChange) {
    this.name = name;
    this.grid = grid || [];
    this._onChange = onChange || (() => {});
  }
  touch() { this._onChange(); }
  isTextCol(col) { return !!(this.textCols && this.textCols[col]); }
  setTextCol(col, on) { this.textCols = this.textCols || {}; if (on) this.textCols[col] = true; else delete this.textCols[col]; this.touch(); }
  getName() { return this.name; }
  getRange(row, col, numRows, numCols) {
    return new MockRange(this, row, col, numRows === undefined ? 1 : numRows, numCols === undefined ? 1 : numCols);
  }
  // Like Sheets: last row / column that has any content (grid itself may be larger).
  getLastRow() {
    for (let r = this.grid.length - 1; r >= 0; r--) if (this.grid[r].some((v) => v !== "" && v !== null)) return r + 1;
    return 0;
  }
  getLastColumn() {
    let last = 0;
    for (const row of this.grid) for (let c = row.length - 1; c >= last; c--) if (row[c] !== "" && row[c] !== null) { last = c + 1; break; }
    return last;
  }
  getMaxRows() { return this.grid.length; }
  getMaxColumns() { return this.getLastColumn(); }
  getDataRange() {
    const lastRow = Math.max(this.getLastRow(), 1);
    const lastCol = Math.max(this.getLastColumn(), 1);
    return this.getRange(1, 1, lastRow, lastCol);
  }
  appendRow(rowArray) {
    const cols = Math.max(this.getLastColumn(), rowArray.length);
    const r = this.getLastRow() + 1;
    if (r > this.grid.length) ensureGridSize(this.grid, r, cols);
    this.getRange(r, 1, 1, cols).setValues([rowArray]);
    return this;
  }
  insertRowsAfter(afterPosition, howMany) {
    const cols = Math.max(this.getLastColumn(), 1);
    for (let i = 0; i < howMany; i++) this.grid.splice(afterPosition, 0, blankRow(cols));
    this.touch();
    return this;
  }
  deleteRow(rowPos) { this.grid.splice(rowPos - 1, 1); this.touch(); return this; }
  deleteRows(rowPos, howMany) { this.grid.splice(rowPos - 1, howMany); this.touch(); return this; }
  clear() { this.grid = []; this.touch(); return this; }
  clearContents() {
    if (this.grid.length > 1) this.getRange(2, 1, this.grid.length - 1, this.getLastColumn()).clearContent();
    return this;
  }
  setFrozenRows() { return this; }
  autoResizeColumns() { return this; }
}

class MockSpreadsheet {
  constructor(state, onChange) {
    this._state = state;
    this._onChange = onChange;
    this._sheets = {};
    Object.keys(state.sheets).forEach((name) => this._wrap(name));
  }
  _wrap(name) {
    if (!this._sheets[name]) {
      this._state.sheets[name] = this._state.sheets[name] || { data: [] };
      const st = this._state.sheets[name];
      st.textCols = st.textCols || {};
      this._sheets[name] = new MockSheet(name, st.data, this._onChange);
      this._sheets[name].textCols = st.textCols;
    }
    return this._sheets[name];
  }
  getSheetByName(name) {
    if (!this._state.sheets[name]) return null;
    return this._wrap(name);
  }
  insertSheet(name) {
    // New sheets start with a 1000-row grid, like Google Sheets.
    this._state.sheets[name] = { data: Array.from({ length: MOCK_NEW_SHEET_ROWS }, () => blankRow(1)) };
    return this._wrap(name);
  }
  getSheets() { return Object.keys(this._state.sheets).map((n) => this._wrap(n)); }
}

// ---------------------------------------------------------------------------------------------
// PropertiesService / CacheService / LockService

function makePropertiesService(state) {
  state.properties = state.properties || {};
  const store = state.properties;
  const service = {
    getProperty: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setProperty: (k, v) => { store[k] = String(v); },
    deleteProperty: (k) => { delete store[k]; },
    getProperties: () => ({ ...store }),
    setProperties: (obj, deleteAllOthers) => {
      if (deleteAllOthers) Object.keys(store).forEach((k) => delete store[k]);
      Object.keys(obj).forEach((k) => { store[k] = String(obj[k]); });
    }
  };
  return { getScriptProperties: () => service };
}

function makeCacheService() {
  const cache = new Map(); // key -> { value, expiresAt }
  const MAX_BYTES = 100 * 1024;
  function put(key, value, ttlSeconds) {
    if (Buffer.byteLength(String(value), "utf8") > MAX_BYTES) {
      throw new Error("Argument too large: value (max 100KB per CacheService value)");
    }
    cache.set(key, { value: String(value), expiresAt: Date.now() + (ttlSeconds || 600) * 1000 });
  }
  function get(key) {
    const e = cache.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) { cache.delete(key); return null; }
    return e.value;
  }
  const service = {
    get, put,
    getAll: (keys) => {
      const out = {};
      keys.forEach((k) => { const v = get(k); if (v !== null) out[k] = v; });
      return out;
    },
    putAll: (obj, ttlSeconds) => { Object.keys(obj).forEach((k) => put(k, obj[k], ttlSeconds)); },
    remove: (key) => { cache.delete(key); },
    removeAll: (keys) => { keys.forEach((k) => cache.delete(k)); }
  };
  return { getScriptCache: () => service };
}

function makeLockService() {
  // Single-threaded Node process running one request at a time (our test/dev server never calls
  // doPost re-entrantly) — a real mutex isn't needed, just the same call shape as GAS.
  const lock = {
    _locked: false,
    waitLock() { this._locked = true; },
    tryLock() { this._locked = true; return true; },
    releaseLock() { this._locked = false; },
    hasLock() { return this._locked; }
  };
  return { getScriptLock: () => lock };
}

// ---------------------------------------------------------------------------------------------
// Utilities / ContentService / HtmlService / UrlFetchApp / Logger / Session

function makeBlob(input) {
  const buf = toUnsignedBuffer(input);
  return {
    getDataAsString: () => buf.toString("utf8"),
    getBytes: () => toSignedBytes(buf)
  };
}

function makeUtilities(appsScriptDir) {
  return {
    DigestAlgorithm: { SHA_256: "SHA_256" },
    Charset: { UTF_8: "UTF-8" },
    computeDigest: (_algorithm, str) => toSignedBytes(crypto.createHash("sha256").update(Buffer.from(String(str), "utf8")).digest()),
    computeHmacSha256Signature: (str, key) => toSignedBytes(crypto.createHmac("sha256", Buffer.from(String(key), "utf8")).update(Buffer.from(String(str), "utf8")).digest()),
    base64Encode: (input) => b64Standard(input),
    base64EncodeWebSafe: (input) => b64WebSafe(input),
    base64Decode: (str) => fromB64Standard(str),
    base64DecodeWebSafe: (str) => fromB64WebSafe(str),
    newBlob: (input) => makeBlob(input),
    getUuid: () => crypto.randomUUID(),
    // Minimal formatDate: supports the "yyyy-MM" pattern used by Db.js (Asia/Bangkok only).
    formatDate: (d, tz, fmt) => {
      const b = new Date(d.getTime() + 7 * 3600 * 1000);
      const y = b.getUTCFullYear(), m = String(b.getUTCMonth() + 1).padStart(2, "0");
      if (fmt === "yyyy-MM") return `${y}-${m}`;
      return b.toISOString();
    },
    sleep: (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* ignore */ } }
  };
}

function makeContentService() {
  return {
    MimeType: { JSON: "JSON", TEXT: "TEXT", HTML: "HTML" },
    createTextOutput: (text) => {
      const out = { _text: text, _mime: "TEXT" };
      out.setMimeType = function (m) { this._mime = m; return this; };
      out.getContent = function () { return this._text; };
      return out;
    }
  };
}

function makeHtmlService(appsScriptDir) {
  return {
    createHtmlOutputFromFile: (name) => {
      const file = path.join(appsScriptDir, name + ".html");
      if (!fs.existsSync(file)) throw new Error("HtmlService file not found: " + name + ".html");
      const content = fs.readFileSync(file, "utf8");
      return { getContent: () => content };
    }
  };
}

// GOOGLE_CLIENT_ID mirrors webapp/js/constants.js / apps-script/Config.js (public, not a secret).
const GOOGLE_CLIENT_ID = "572074800379-jtl1af4cat6v8vk8u4r3o868r7lskfab.apps.googleusercontent.com";

function makeUrlFetchApp() {
  return {
    fetch: (url) => {
      const m = /id_token=([^&]+)/.exec(String(url));
      const idToken = m ? decodeURIComponent(m[1]) : "";
      const devMatch = /^dev:(.+)$/.exec(idToken);
      if (devMatch) {
        const email = devMatch[1];
        const body = JSON.stringify({ aud: GOOGLE_CLIENT_ID, email: email, email_verified: "true" });
        return { getResponseCode: () => 200, getContentText: () => body };
      }
      return { getResponseCode: () => 400, getContentText: () => JSON.stringify({ error: "invalid_token" }) };
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Runtime factory

export function createRuntime(opts) {
  const appsScriptDir = opts.appsScriptDir;
  const state = opts.state || { sheets: {}, properties: {} };
  const onChange = opts.onChange || (() => {});

  const sandbox = {};
  const ss = new MockSpreadsheet(state, onChange);
  sandbox.SpreadsheetApp = { getActive: () => ss, getActiveSpreadsheet: () => ss };
  sandbox.PropertiesService = makePropertiesService(state);
  sandbox.CacheService = makeCacheService();
  sandbox.LockService = makeLockService();
  sandbox.Utilities = makeUtilities(appsScriptDir);
  sandbox.ContentService = makeContentService();
  sandbox.HtmlService = makeHtmlService(appsScriptDir);
  sandbox.UrlFetchApp = makeUrlFetchApp();
  sandbox.Logger = { log: (...args) => { if (process.env.GAS_MOCK_DEBUG) console.error("[GAS]", ...args); } };
  sandbox.Session = { getScriptTimeZone: () => "Asia/Bangkok" };
  sandbox.console = console;

  const context = vm.createContext(sandbox);

  const files = FILE_ORDER.map((name) => {
    const full = path.join(appsScriptDir, name);
    return { name, code: fs.readFileSync(full, "utf8") };
  });
  const combined = files.map((f) => "// ---- " + f.name + " ----\n" + f.code).join("\n\n");
  const script = new vm.Script(combined, { filename: "apps-script-bundle.js" });
  script.runInContext(context);

  function call(fnName, ...args) {
    const fn = sandbox[fnName];
    if (typeof fn !== "function") throw new Error("apps-script has no global function " + fnName);
    return fn(...args);
  }

  return { call, sandbox, state };
}

export function freshState() {
  return { sheets: {}, properties: {} };
}
