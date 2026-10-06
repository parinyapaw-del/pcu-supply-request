// js/admin/requests.js — loads the requests of a month together with their lines (adminGetRequest per
// submitted/issued request), cached by (pcu, month) + updated_at so repeated tab visits / the 30 s
// auto-refresh only fetch what changed. Used by the "ยอดรวม" and "งบ" tabs.
import { poolMap } from "./util.js";
import { isUsableStatus } from "./compute.js";

const cache = new Map(); // "pcu|month" -> { stamp, request, form }

// 2c: issue amounts change without touching updated_at, so the stamp also covers the IssueInfo summary
// that adminRequests returns (done units + issued line counts).
function issueStamp(issue) {
  if (!issue || !issue.units) return "";
  return Object.entries(issue.units).map(([u, x]) => `${u}:${x.done ? 1 : 0}/${x.issued_lines || 0}/${x.done_at || ""}`).join(",");
}
function stampOf(r) { return `${r.status}|${r.updated_at}|${r.submitted_at}|${issueStamp(r.issue)}`; }

export function clearRequestCache() { cache.clear(); }

// meta: one element of adminRequests().requests. Returns {pcu, request (with lines), form}.
async function loadOne(ctx, meta) {
  const key = `${meta.pcu}|${meta.month}`;
  const stamp = stampOf(meta);
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return hit;
  const data = await ctx.adminCall("adminGetRequest", { pcu: meta.pcu, month: meta.month });
  const entry = { stamp, pcu: meta.pcu, request: data.request, form: data.form };
  cache.set(key, entry);
  return entry;
}

// Returns { requests: [meta...], rounds, entries: [{pcu, request, form}] (usable ones only), server_time }
export async function loadMonth(ctx, month, onProgress) {
  const data = await ctx.adminCall("adminRequests", { month });
  const usable = data.requests.filter((r) => isUsableStatus(r.status));
  let done = 0;
  const entries = await poolMap(usable, 5, async (meta) => {
    const e = await loadOne(ctx, meta);
    done += 1;
    if (onProgress) onProgress(done, usable.length);
    return e;
  });
  return { requests: data.requests, rounds: data.rounds, server_time: data.server_time, entries };
}
