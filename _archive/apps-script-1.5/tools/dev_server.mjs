#!/usr/bin/env node
// dev_server.mjs [port] [--reset] [--state <path>] — local dev server, no Google account needed.
//
// Serves webapp/ as static files and runs the REAL apps-script/*.js backend (via gas_mock.mjs) for
// POST/GET /api. State (sheets + Script Properties) persists to tools/.devstate.json (or --state)
// between runs; pass --state <path> to run two servers on different ports against separate state
// (matching the gitignore pattern tools/.devstate*.json). Use --reset to wipe state and re-run
// setup() from scratch.
//
// Usage: node tools/dev_server.mjs [port=8770] [--reset] [--state tools/.devstate.b.json]

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createRuntime, freshState } from "./gas_mock.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP_DIR = path.resolve(__dirname, "..");
const APPS_SCRIPT_DIR = path.join(WEBAPP_DIR, "apps-script");

function parseArgs(argv) {
  const out = { port: 8770, reset: false, statePath: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reset") out.reset = true;
    else if (a === "--state") { out.statePath = argv[++i]; }
    else rest.push(a);
  }
  if (rest.length && /^\d+$/.test(rest[0])) out.port = Number(rest[0]);
  return out;
}

const args = parseArgs(process.argv.slice(2));
const statePath = path.resolve(WEBAPP_DIR, args.statePath || path.join("tools", ".devstate.json"));

if (args.reset && fs.existsSync(statePath)) {
  fs.unlinkSync(statePath);
  console.log("[dev_server] --reset: deleted " + statePath);
}

let state;
let needsSetup = false;
if (fs.existsSync(statePath)) {
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (err) {
    console.error("[dev_server] failed to parse " + statePath + ", starting fresh:", err.message);
    state = freshState();
    needsSetup = true;
  }
} else {
  state = freshState();
  needsSetup = true;
}

function persist() {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state));
}

const runtime = createRuntime({ appsScriptDir: APPS_SCRIPT_DIR, state });

if (needsSetup) {
  console.log("[dev_server] no state file — running setup()...");
  runtime.call("setup");
  persist();
  console.log("[dev_server] setup() complete, state written to " + statePath);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};

function contentTypeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleApi(req, res) {
  let outputText;
  try {
    if (req.method === "POST") {
      const body = await readBody(req);
      const e = { postData: { contents: body, type: "text/plain" }, parameter: {} };
      outputText = runtime.call("doPost", e).getContent();
    } else {
      outputText = runtime.call("doGet", { parameter: {} }).getContent();
    }
  } catch (err) {
    outputText = JSON.stringify({ ok: false, error: { code: "SERVER_ERROR", message: String((err && err.message) || err) } });
  }
  persist(); // spec: persist the whole mock state after every write request (unconditional here — cheap and simple)
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(outputText);
}

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const full = path.normalize(path.join(WEBAPP_DIR, rel));
  if (!full.startsWith(WEBAPP_DIR)) return null; // path traversal guard
  return full;
}

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = req.url.split("?")[0];
    if (urlPath === "/api") {
      await handleApi(req, res);
      return;
    }
    const filePath = safeStaticPath(urlPath);
    if (!filePath) { res.writeHead(400); res.end("bad path"); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found: " + urlPath);
        return;
      }
      res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
      res.end(data);
    });
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Server error: " + (err && err.message));
  }
});

server.listen(args.port, () => {
  console.log(`[dev_server] serving ${WEBAPP_DIR} on http://localhost:${args.port} (state: ${statePath})`);
});
