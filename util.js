/* Shared helpers. Loaded first; exposes window.Util. */
(() => {
"use strict";
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { if (k !== "bd:log") console.warn("storage", e); } },
};
// Debug log: stays on the device; the user can copy it from the menu.
const LOGK = "bd:log", LOG = LS.get(LOGK, []).slice(-500);
let logSave = null;
function dbg(...a) {
  const line = new Date().toISOString().slice(11, 19) + " " + a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ");
  LOG.push(line); if (LOG.length > 800) LOG.splice(0, LOG.length - 800);
  clearTimeout(logSave); logSave = setTimeout(() => LS.set(LOGK, LOG), 500);
}
window.addEventListener("error", (e) => dbg("ERROR", e.message, (e.filename || "").split("/").pop() + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => dbg("REJECTION", String(e.reason && (e.reason.message || e.reason))));
document.addEventListener("securitypolicyviolation", (e) => dbg("CSP blocked", e.violatedDirective, e.blockedURI));

const R = 6371000, rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
function dist(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
function distToLine(p, line) {
  const kx = Math.cos(rad(p.lat)) * 111320, ky = 110540; let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i].lon - p.lon) * kx, ay = (line[i].lat - p.lat) * ky, bx = (line[i + 1].lon - p.lon) * kx, by = (line[i + 1].lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? -(ax * dx + ay * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
const str = (v, max = 2000) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);
const num = (v) => typeof v === "number" && isFinite(v) ? v : NaN;
const okLat = (v) => typeof v === "number" && v >= -90 && v <= 90, okLon = (v) => typeof v === "number" && v >= -180 && v <= 180;
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’']/g, "'");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
async function fetchJSON(url, opts = {}, ms = 20000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: ac.signal, credentials: "omit" }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
  catch (e) { if (e.name === "AbortError") throw new Error("timeout"); throw e; }
  finally { clearTimeout(t); }
}
// Allow-lists: only these may become clickable links or images.
const LINK_RE = [
  /^https:\/\/[a-z-]+\.(m\.)?wikipedia\.org\/wiki\/[^\s"'<>]+$/,
  /^https:\/\/www\.wikidata\.org\/wiki\/Q\d+$/,
  /^https:\/\/commons\.wikimedia\.org\/wiki\/[^\s"'<>]+$/,
  /^https:\/\/www\.openstreetmap\.org\/(node|way|relation)\/\d+$/,
  /^https:\/\/inventaris\.onroerenderfgoed\.be\/[a-z]+\/\d+$/,
  /^https:\/\/(opendata\.brussels\.be|opendata\.bruxelles\.be|data\.stad\.gent)\/explore\/dataset\/[a-z0-9_@%-]+\/$/i,
];
const safeUrl = (u) => { if (typeof u !== "string") return null; u = u.replace(/'/g, "%27"); return LINK_RE.some((re) => re.test(u)) ? u : null; };
function safeImg(u) {
  if (typeof u !== "string") return null;
  u = u.replace(/'/g, "%27");
  if (/^https:\/\/(upload|commons)\.wikimedia\.org\/[^\s"'<>]+$/.test(u)) return u;
  if (/^https:\/\/(opendata\.brussels\.be|opendata\.bruxelles\.be|data\.stad\.gent)\/[^\s"'<>]+$/.test(u)) return u;
  if (/^[a-z0-9][a-z0-9._-]*\.(jpe?g|png|webp)$/i.test(u)) return u; // image file in this repository
  return null;
}
window.Util = { LS, LOG, LOGK, dbg, dist, bearing, distToLine, str, num, okLat, okLon, norm, sleep, esc, hash, fetchJSON, safeUrl, safeImg };
})();
