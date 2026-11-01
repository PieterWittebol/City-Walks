/* City Walks editor. Edits cities.json and walk-*.json in the GitHub repository through the GitHub API.
 * Security:
 * - Only fine-grained personal access tokens (github_pat_…) are accepted; classic tokens are refused.
 * - The token is kept in memory + sessionStorage (cleared when the tab closes) unless the user opts in to remember it.
 * - The token is only ever sent to api.github.com (also enforced by the CSP in admin.html).
 * - Only cities.json and walk-*.json can be read or written; the app's code can't be changed from here.
 * - Everything is validated with the same rules the app uses (schema.js) before it is saved.
 * - All content is rendered as text, never as HTML. The page refuses to run inside a frame. */
(() => {
"use strict";
if (window.top !== window.self) { document.documentElement.replaceChildren(); return; } // no clickjacking
document.body.classList.remove("locked");

const U = window.Util, Src = window.Sources, SC = window.Schema;
const { str, okLat, okLon, norm, fetchJSON } = U;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids.filter((k) => k != null)); return n; };
const PATH_OK = (p) => /^(cities\.json|walk-[a-z0-9-]+\.json)$/.test(p);
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const TOKEN_RE = /^github_pat_[A-Za-z0-9_]{20,255}$/;
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

let toastT = null;
function toast(text, ms = 4000) { const t = $("toast"); t.textContent = text; t.classList.remove("hidden"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add("hidden"), ms); }

// ---------- dialogs (built from DOM nodes, never HTML strings) ----------
function dialog(title, body, buttons) {
  return new Promise((resolve) => {
    $("dlgTitle").textContent = title; $("dlgMsg").textContent = "";
    $("dlgBody").replaceChildren(...(Array.isArray(body) ? body : [body]).map((b) => typeof b === "string" ? el("p", { textContent: b }) : b));
    $("dlgButtons").replaceChildren(...buttons.map((b) => {
      const n = el("button", { textContent: b.label, className: b.cls || "" });
      n.onclick = async () => {
        if (b.check) { const m = await b.check(); if (m) { $("dlgMsg").textContent = m; return; } }
        $("dlg").classList.add("hidden"); resolve(b.value);
      };
      return n;
    }));
    $("dlg").classList.remove("hidden");
  });
}
const confirmDlg = (title, text, ok = "OK", cls = "primary") => dialog(title, text, [{ label: "Cancel", value: false }, { label: ok, value: true, cls }]);

// ---------- authentication ----------
const TK = "cw:auth";
let auth = null, remember = false, lastActive = Date.now();
function loadAuth() {
  try { const s = sessionStorage.getItem(TK); if (s) return JSON.parse(s); const l = localStorage.getItem(TK); if (l) { remember = true; return JSON.parse(l); } } catch {}
  return null;
}
function storeAuth() {
  try { sessionStorage.removeItem(TK); localStorage.removeItem(TK); (remember ? localStorage : sessionStorage).setItem(TK, JSON.stringify(auth)); } catch {}
}
function signOut(reason) {
  auth = null; try { sessionStorage.removeItem(TK); localStorage.removeItem(TK); } catch {}
  if (reason) try { sessionStorage.setItem("cw:msg", reason); } catch {}
  location.replace(location.pathname);
}
// Sign out after 60 minutes without activity (unless the user chose to be remembered).
["pointerdown", "keydown"].forEach((ev) => addEventListener(ev, () => (lastActive = Date.now()), true));
setInterval(() => { if (auth && !remember && Date.now() - lastActive > 60 * 60e3) signOut("Signed out after 60 minutes without activity."); }, 60e3);

function guessRepo() {
  const m = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  if (!m) return "";
  const seg = location.pathname.split("/").filter(Boolean)[0];
  return m[1] + "/" + (seg && !/\.html$/.test(seg) ? seg : m[1] + ".github.io");
}

// ---------- GitHub API ----------
function ghMsg(status, data) {
  if (status === 401) return "GitHub says the token is invalid or has expired.";
  if (status === 403) return "The token isn't allowed to do this. It needs 'Contents: Read and write' on this repository." + (data?.message && /rate limit/i.test(data.message) ? " (GitHub rate limit reached, try again later.)" : "");
  if (status === 404) return "Not found. Check the repository name and that the token has access to it.";
  if (status === 409 || status === 422) return "This file was changed somewhere else in the meantime. Reload and try again.";
  return "GitHub error " + status + (data?.message ? ": " + str(data.message, 200) : "");
}
async function gh(method, path, body) {
  const r = await fetch(`https://api.github.com/repos/${auth.repo}${path}`, {
    method, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
    headers: { Authorization: "Bearer " + auth.token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(ghMsg(r.status, data)); e.status = r.status; throw e; }
  return { data, headers: r.headers };
}
const b64enc = (text) => { const b = new TextEncoder().encode(text); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const b64dec = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
async function readFile(path) {
  if (!PATH_OK(path)) throw new Error("Not allowed: " + path);
  try {
    const { data } = await gh("GET", `/contents/${path}?ref=${encodeURIComponent(auth.branch)}`);
    if (data.size > 1e6) throw new Error(path + " is too large.");
    return { sha: data.sha, text: b64dec(data.content) };
  } catch (e) { if (e.status === 404) return null; throw e; }
}
const commitMsg = (m) => str(m, 200).replace(/[\u0000-\u001f\u007f]/g, " ").trim() || "Update via City Walks editor";
async function writeFile(path, text, sha, message) {
  if (!PATH_OK(path)) throw new Error("Not allowed: " + path);
  if (text.length > 500e3) throw new Error("File too large.");
  const { data } = await gh("PUT", `/contents/${path}`, { message: commitMsg(message), content: b64enc(text), branch: auth.branch, ...(sha ? { sha } : {}) });
  return data.content.sha;
}
async function deleteFile(path, sha, message) {
  if (!PATH_OK(path)) throw new Error("Not allowed: " + path);
  await gh("DELETE", `/contents/${path}`, { message: commitMsg(message), sha, branch: auth.branch });
}

// ---------- sign in ----------
$("inRepo").value = guessRepo();
$("inRemember").onchange = () => $("rememberWarn").classList.toggle("hidden", !$("inRemember").checked);
try { const m = sessionStorage.getItem("cw:msg"); if (m) { $("loginMsg").textContent = m; sessionStorage.removeItem("cw:msg"); } } catch {}
async function connect(a) {
  auth = a;
  const { data, headers } = await gh("GET", "");
  auth.branch = /^[A-Za-z0-9._\/-]{1,100}$/.test(data.default_branch || "") ? data.default_branch : "main";
  if (data.permissions && data.permissions.push === false) throw new Error("Your GitHub account can't write to this repository.");
  auth.exp = headers.get("github-authentication-token-expiration") || "";
  await loadCities();
  storeAuth();
  showTokenInfo();
  show("vHome");
}
$("btnLogin").onclick = async () => {
  const token = $("inToken").value.trim(), repo = $("inRepo").value.trim();
  const msg = $("loginMsg"); msg.className = "msg"; msg.textContent = "";
  if (/^(ghp|gho|ghu|ghs|ghr)_/.test(token)) { msg.textContent = "That's a classic token, which can usually reach all your repositories. For safety this editor only accepts fine-grained tokens (they start with github_pat_). See 'How to create the token' below."; return; }
  if (!TOKEN_RE.test(token)) { msg.textContent = "This doesn't look like a fine-grained token (github_pat_…)."; return; }
  if (!REPO_RE.test(repo)) { msg.textContent = "Repository must look like owner/name."; return; }
  remember = $("inRemember").checked;
  $("btnLogin").disabled = true; msg.textContent = "Checking…"; msg.className = "msg ok";
  try { await connect({ token, repo }); $("inToken").value = ""; }
  catch (e) { auth = null; msg.className = "msg"; msg.textContent = e.message; }
  finally { $("btnLogin").disabled = false; }
};
$("inToken").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnLogin").click(); });
$("btnSignOut").onclick = async () => { if (await leaveOk()) signOut(); };

function showTokenInfo() {
  const n = $("tokenInfo"); let text = `Signed in to ${auth.repo} (branch ${auth.branch}).`, bad = false;
  if (!auth.exp) { text += "\n⚠ This token never expires. Safer: create one that expires within 30–90 days."; bad = true; }
  else {
    const d = new Date(auth.exp.replace(" UTC", "Z").replace(" ", "T"));
    const days = Math.round((d - Date.now()) / 864e5);
    if (isFinite(days)) { text += ` Token expires in ${days} day${days === 1 ? "" : "s"}.`; if (days > 90) { text += "\n⚠ That's a long time; consider a shorter expiry."; bad = true; } }
  }
  if (remember) text += "\nThe token is remembered on this device. Sign out to remove it.";
  n.textContent = text; n.classList.toggle("bad", bad);
  const l = $("lnkBuilds"); l.href = "https://github.com/" + auth.repo + "/actions"; l.classList.remove("hidden");
}

// ---------- navigation ----------
let view = "vLogin";
function show(v) {
  for (const id of ["vLogin", "vHome", "vWalk"]) $(id).classList.toggle("hidden", id !== v);
  view = v;
  $("btnBack").classList.toggle("hidden", v !== "vWalk");
  $("btnSignOut").classList.toggle("hidden", v === "vLogin");
  $("barTitle").textContent = v === "vWalk" && cur ? (disp(cur.model.title, cur.model.lang) || "Walk") : "City Walks · Editor";
  if (v === "vHome") renderHome();
  if (v === "vWalk") setTimeout(() => map && map.invalidateSize(), 50);
  updateDirty(); scrollTo(0, 0);
}
function updateDirty() { $("dirty").classList.toggle("hidden", !(citiesDirty || (cur && cur.dirty))); $("btnSaveCities").disabled = !citiesDirty; }
async function leaveOk() { return !(citiesDirty || (cur && cur.dirty)) || confirmDlg("Unsaved changes", "You have changes that aren't saved yet. Discard them?", "Discard", "danger"); }
addEventListener("beforeunload", (e) => { if (citiesDirty || (cur && cur.dirty)) { e.preventDefault(); e.returnValue = ""; } });
$("btnBack").onclick = async () => {
  if (cur && cur.dirty && !(await leaveOk())) return;
  if (cur && cur.dirty) await loadCities(); // discard: reload the list too, in case it was touched
  cur = null; show("vHome");
};

// ---------- cities ----------
let cities = null, citiesSha = null, citiesDirty = false;
async function loadCities() {
  const f = await readFile("cities.json");
  if (!f) throw new Error("cities.json wasn't found in this repository. Upload the City Walks files first.");
  try { cities = JSON.parse(f.text); } catch { throw new Error("cities.json isn't valid JSON. Fix it on github.com first."); }
  if (!Array.isArray(cities.cities)) cities.cities = [];
  citiesSha = f.sha; citiesDirty = false;
}
const cityDirty = () => { citiesDirty = true; updateDirty(); renderHome(); };
const move = (arr, i, d) => { const j = i + d; if (j < 0 || j >= arr.length) return false; [arr[i], arr[j]] = [arr[j], arr[i]]; return true; };
const LNAME = { en: "English", nl: "Nederlands", fr: "Français", de: "Deutsch" };
// Multilingual values are a plain string (main language) or { en, nl, fr, de }.
const disp = (v, lang = "en") => v && typeof v === "object" ? (v[lang] || v.en || Object.values(v).find(Boolean) || "") : (v || "");
// Input for a multilingual value: the main language, plus "Translations" for the others.
function mlField({ label, value, main, multiline = false, max = 120, rows = 4, onInput }) {
  const vals = value && typeof value === "object" ? value : { [main]: value || "" };
  const count = el("span", { className: "small" });
  const mk = (l, isMain) => {
    const inp = el(multiline ? "textarea" : "input", { maxLength: max, value: vals[l] || "" });
    if (multiline) inp.rows = isMain ? rows : 3;
    inp.dataset.lang = l; inp.oninput = () => { const v = get(); onInput && onInput(v); };
    return inp;
  };
  const mainInp = mk(main, true);
  const det = el("details", { className: "trans" }, el("summary", {}, "Translations ", count),
    ...Src.LANGS.filter((l) => l !== main).map((l) => el("label", {}, LNAME[l] || l, mk(l, false))));
  const root = el("div", { className: "mlfield" }, el("label", {}, label + " ", el("span", { className: "small", textContent: "(" + (LNAME[main] || main) + ")" }), mainInp), det);
  function get() {
    const t = {}; root.querySelectorAll("[data-lang]").forEach((x) => { const v = x.value.trim(); if (v) t[x.dataset.lang] = v; });
    const k = Object.keys(t), n = k.filter((l) => l !== main).length; count.textContent = n ? `(${n})` : "";
    if (!k.length) return ""; if (k.length === 1 && k[0] === main) return t[main]; return t;
  }
  get(); root.get = get;
  return root;
}
const KIND_NAMES = { comics: "Comic strips", "street-art": "Street art", heritage: "Heritage", highlights: "Highlights" };
function renderHome() {
  const box = $("cities"); box.replaceChildren();
  if (!cities) return;
  cities.cities.forEach((c, ci) => {
    const head = el("div", { className: "cityHead" }, el("b", { textContent: disp(c.name) || c.id }));
    const up = el("button", { className: "mini", textContent: "↑", title: "Move up" }); up.onclick = () => move(cities.cities, ci, -1) && cityDirty();
    const dn = el("button", { className: "mini", textContent: "↓", title: "Move down" }); dn.onclick = () => move(cities.cities, ci, 1) && cityDirty();
    const ed = el("button", { className: "mini", textContent: "✎", title: "Edit city" }); ed.onclick = () => editCity(c);
    head.append(up, dn, ed);
    const div = el("div", { className: "city" }, head);
    (c.walks || []).forEach((w, wi) => {
      const t = el("div", { className: "t" }, el("b", { textContent: disp(w.title) || w.file }),
        el("span", { textContent: [KIND_NAMES[w.kind], w.generated ? "generated" : (isFinite(w.stops) ? w.stops + " stops" : ""), w.file].filter(Boolean).join(" · ") }));
      const wu = el("button", { className: "mini", textContent: "↑" }); wu.onclick = () => move(c.walks, wi, -1) && cityDirty();
      const wd = el("button", { className: "mini", textContent: "↓" }); wd.onclick = () => move(c.walks, wi, 1) && cityDirty();
      const op = el("button", { className: "mini primary", textContent: "Edit" }); op.onclick = () => openWalk(c, w);
      div.append(el("div", { className: "walkItem" }, t, wu, wd, op));
    });
    const add = el("button", { textContent: "＋ Walk in " + (disp(c.name) || c.id) }); add.onclick = () => newWalk(c);
    div.append(el("div", { className: "row" }, add));
    box.append(div);
  });
}
async function editCity(c) {
  const isNew = !c;
  const nameF = mlField({ label: "Name", value: c?.name || "", main: "en", max: 60 });
  const name = { get value() { return disp(nameF.get()); } };
  const lat = el("input", { type: "number", step: "0.0001", value: c?.lat ?? "" }), lon = el("input", { type: "number", step: "0.0001", value: c?.lon ?? "" });
  const find = el("button", { textContent: "Look up centre by name" });
  find.onclick = async () => {
    try { const r = await fetchJSON("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + encodeURIComponent(name.value + ", Belgium"), {}, 10000);
      if (r[0]) { lat.value = round6(+r[0].lat); lon.value = round6(+r[0].lon); } else $("dlgMsg").textContent = "Not found."; }
    catch (e) { $("dlgMsg").textContent = "Lookup failed: " + e.message; }
  };
  const body = [nameF, el("div", { className: "two" }, el("label", {}, "Centre latitude", lat), el("label", {}, "Centre longitude", lon)), find];
  const btns = [{ label: "Cancel", value: null }];
  if (!isNew) btns.unshift({ label: "Delete", value: "delete", cls: "danger", check: () => (c.walks || []).length ? "Delete or move its walks first." : "" });
  btns.push({ label: "OK", value: "ok", cls: "primary", check: () => !name.value.trim() ? "Enter a name." : (!okLat(+lat.value) || !okLon(+lon.value) || lat.value === "") ? "Enter a valid centre (or look it up)." : "" });
  const r = await dialog(isNew ? "New city" : "Edit city", body, btns);
  if (r === "delete") { cities.cities.splice(cities.cities.indexOf(c), 1); cityDirty(); return; }
  if (r !== "ok") return;
  if (isNew) {
    let id = slug(name.value); while (cities.cities.some((x) => x.id === id)) id += "-2";
    cities.cities.push({ id, name: nameF.get(), lat: round6(+lat.value), lon: round6(+lon.value), walks: [] });
  } else Object.assign(c, { name: nameF.get(), lat: round6(+lat.value), lon: round6(+lon.value) });
  cityDirty();
}
$("btnAddCity").onclick = () => editCity(null);
async function saveCities(message) {
  const errs = SC.checkCities(cities);
  if (errs.length) throw new Error(errs.join("\n"));
  citiesSha = await writeFile("cities.json", JSON.stringify(cities, null, 2) + "\n", citiesSha, message);
  citiesDirty = false; updateDirty();
}
$("btnSaveCities").onclick = async () => {
  const msg = el("input", { value: "Update list of walks", maxLength: 200 });
  if (!(await dialog("Save list", [el("label", {}, "Change description", msg)], [{ label: "Cancel", value: false }, { label: "Save", value: true, cls: "primary" }]))) return;
  try { await saveCities(msg.value); toast("Saved ✓ The app shows the change in a few minutes."); renderHome(); }
  catch (e) { await dialog("Not saved", e.message, [{ label: "OK", value: 1 }]); if (e.status === 409 || e.status === 422) { await loadCities(); renderHome(); } }
};

// ---------- walks ----------
let cur = null; // { city, entry, path, sha, model, dirty, isNew }
const markDirty = () => { if (cur) { cur.dirty = true; updateDirty(); } };
async function openWalk(city, entry) {
  if (!(await leaveOk())) return;
  try {
    const f = await readFile(entry.file);
    if (!f) throw new Error(entry.file + " doesn't exist in the repository.");
    let model; try { model = JSON.parse(f.text); } catch { throw new Error(entry.file + " isn't valid JSON. Fix it on github.com first."); }
    if (!model || typeof model !== "object") throw new Error("Unexpected file content.");
    if (!Array.isArray(model.stops)) model.stops = [];
    cur = { city, entry, path: entry.file, sha: f.sha, model, dirty: false, isNew: false };
    openEditor();
  } catch (e) { dialog("Couldn't open walk", e.message, [{ label: "OK", value: 1 }]); }
}
async function newWalk(city) {
  if (!(await leaveOk())) return;
  const title = el("input", { maxLength: 120, placeholder: "e.g. Art Nouveau in Ixelles" });
  const type = el("select", {}, ...[["", "Hand-picked stops"], ["wikidata", "Generated: highlights from Wikidata"], ["osm-art", "Generated: street art from OpenStreetMap"], ["ods", "Generated: city open data portal"]].map(([v, t]) => el("option", { value: v, textContent: t })));
  const ok = await dialog("New walk in " + disp(city.name), [el("label", {}, "Title", title), el("label", {}, "Type", type)],
    [{ label: "Cancel", value: false }, { label: "Create", value: true, cls: "primary", check: () => title.value.trim() ? "" : "Enter a title." }]);
  if (!ok) return;
  const all = cities.cities.flatMap((c) => c.walks || []);
  let id = slug(title.value), file = `walk-${city.id}-${id}.json`.replace(/[^a-z0-9.-]/g, "-");
  while (all.some((w) => w.file === file) || (city.walks || []).some((w) => w.id === id)) { id += "-2"; file = `walk-${city.id}-${id}.json`; }
  const model = { schema: 2, id, title: title.value.trim(), subtitle: "", description: "", lang: "en", stops: [] };
  if (type.value) model.generator = defaultGen(type.value, [city.lat, city.lon]);
  const entry = { id, file, title: model.title, subtitle: "", kind: type.value === "osm-art" ? "street-art" : type.value === "wikidata" ? "highlights" : type.value === "ods" ? "comics" : "heritage" };
  if (type.value) entry.generated = true;
  cur = { city, entry, path: file, sha: null, model, dirty: true, isNew: true };
  openEditor();
}
function defaultGen(type, center) {
  if (type === "wikidata") return { type, center, radiusKm: 1, limit: 15, minSitelinks: 5 };
  if (type === "osm-art") return { type, center, radiusKm: 1.5, limit: 20, artworkTypes: ["mural", "graffiti"] };
  return { type: "ods", host: Src.ODS_HOSTS[0], dataset: "", center, radiusKm: 1.3, limit: 40 };
}

// ---------- walk editor: map ----------
let map = null, pinLayer = null, lineLayer = null, centreMarker = null, radiusCircle = null, selected = -1, addMode = false;
function ensureMap() {
  if (map) return;
  map = L.map("map", { zoomControl: true }).setView([50.85, 4.35], 14);
  map.attributionControl.setPrefix(false);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(map);
  lineLayer = L.polyline([], { color: "#111", weight: 3, opacity: .5, dashArray: "4 6" }).addTo(map);
  pinLayer = L.layerGroup().addTo(map);
  map.on("click", (e) => {
    if (!addMode || !cur) return;
    addMode = false; $("btnAddTap").textContent = "＋ Tap on map";
    addStop({ title: "New stop", lat: round6(e.latlng.lat), lon: round6(e.latlng.lng), fixed: true }, true);
  });
}
function drawMap(fit) {
  const m = cur.model, g = m.generator;
  pinLayer.clearLayers(); if (centreMarker) { centreMarker.remove(); centreMarker = null; } if (radiusCircle) { radiusCircle.remove(); radiusCircle = null; }
  m.stops.forEach((s, i) => {
    if (!okLat(s.lat) || !okLon(s.lon)) return;
    const icon = L.divIcon({ className: "", html: `<div class="pin${i === selected ? " sel" : ""}${s.fixed ? " fixed" : ""}"><span>${i + 1}</span></div>`, iconSize: [26, 26], iconAnchor: [13, 26] });
    const mk = L.marker([s.lat, s.lon], { icon, draggable: true, title: str(disp(s.title, cur.model.lang), 120) }).addTo(pinLayer);
    mk.on("click", () => { selected = i; renderStops(); drawMap(false); });
    mk.on("dragend", () => { const p = mk.getLatLng(); s.lat = round6(p.lat); s.lon = round6(p.lng); s.fixed = true; selected = i; markDirty(); renderStops(); drawMap(false); });
  });
  lineLayer.setLatLngs(m.stops.filter((s) => okLat(s.lat) && okLon(s.lon)).map((s) => [s.lat, s.lon]));
  if (g && Array.isArray(g.center) && okLat(g.center[0]) && okLon(g.center[1])) {
    centreMarker = L.marker(g.center, { draggable: true, icon: L.divIcon({ className: "", html: '<div class="centre"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), title: "Centre" }).addTo(map);
    radiusCircle = L.circle(g.center, { radius: (+g.radiusKm || 1) * 1000, color: "#1a73e8", weight: 1, fillOpacity: .06 }).addTo(map);
    centreMarker.on("drag", () => radiusCircle.setLatLng(centreMarker.getLatLng()));
    centreMarker.on("dragend", () => { const p = centreMarker.getLatLng(); g.center = [round6(p.lat), round6(p.lng)]; markDirty(); });
  }
  if (fit) {
    const pts = m.stops.filter((s) => okLat(s.lat) && okLon(s.lon)).map((s) => [s.lat, s.lon]);
    if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 17 });
    else if (radiusCircle) map.fitBounds(radiusCircle.getBounds());
    else if (okLat(cur.city.lat)) map.setView([cur.city.lat, cur.city.lon], 15);
  }
}

// ---------- walk editor: panels ----------
function openEditor() {
  ensureMap(); selected = -1; addMode = false;
  show("vWalk"); tab("tStops");
  fillDetails(); fillGen(); renderStops();
  setTimeout(() => { map.invalidateSize(); drawMap(true); }, 60);
}
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => tab(b.dataset.tab)));
function tab(id) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("sel", b.dataset.tab === id));
  for (const t of ["tStops", "tGen", "tDetails"]) $(t).classList.toggle("hidden", t !== id);
}
function renderStops() {
  const ol = $("stopList"); ol.replaceChildren();
  const m = cur.model;
  if (m.generator) ol.append(el("li", {}, el("div", { className: "t" }, el("b", { textContent: "This is a generated walk" }), el("span", { textContent: "Stops are picked automatically from open data. Change it under 'Generator'." }))));
  m.stops.forEach((s, i) => {
    const sub = [s.fixed ? "exact position" : "", (s.wiki || []).length ? "Wikipedia: " + s.wiki.join(", ") : "", s.text ? (typeof s.text === "object" ? "own text (" + Object.keys(s.text).join("/") + ")" : "own text") : ""].filter(Boolean).join(" · ");
    const t = el("div", { className: "t" }, el("b", { textContent: disp(s.title, cur.model.lang) || "(no title)" }), el("span", { textContent: sub }));
    t.onclick = () => { selected = i; renderStops(); drawMap(false); if (okLat(s.lat)) map.panTo([s.lat, s.lon]); };
    const up = el("button", { className: "mini", textContent: "↑" }); up.onclick = () => { if (move(m.stops, i, -1)) { selected = i - 1; markDirty(); renderStops(); drawMap(false); } };
    const dn = el("button", { className: "mini", textContent: "↓" }); dn.onclick = () => { if (move(m.stops, i, 1)) { selected = i + 1; markDirty(); renderStops(); drawMap(false); } };
    const ed = el("button", { className: "mini", textContent: "✎" }); ed.onclick = () => editStop(i);
    const li = el("li", { className: i === selected ? "sel" : "" }, el("span", { className: "n", textContent: String(i + 1) }), t, up, dn, ed);
    ol.append(li);
  });
  $("lnkView").href = "./#" + encodeURIComponent(cur.city.id) + "--" + encodeURIComponent(cur.entry.id);
  $("barTitle").textContent = disp(cur.model.title, cur.model.lang) || "Walk";
}
function uniqueStopId(base) { let id = slug(base), n = 2; const ids = new Set(cur.model.stops.map((s) => s.id)); while (ids.has(id)) id = slug(base) + "-" + n++; return id; }
function addStop(s, edit) {
  s.id = uniqueStopId(disp(s.title) || "stop");
  cur.model.stops.push(s); selected = cur.model.stops.length - 1;
  markDirty(); renderStops(); drawMap(false);
  if (edit) editStop(selected); else toast("Added: " + disp(s.title));
}

// stop form
let editing = -1, stopTitleF = null, stopTextF = null;
function editStop(i) {
  editing = i; const s = cur.model.stops[i];
  $("sfHead").textContent = "Stop " + (i + 1);
  const main = cur.model.lang || "en";
  stopTitleF = mlField({ label: "Title", value: s.title || "", main, max: 120 }); $("sTitleBox").replaceChildren(stopTitleF);
  stopTextF = mlField({ label: "Text", value: s.text || "", main, multiline: true, max: 3000, rows: 6 }); $("sTextBox").replaceChildren(stopTextF);
  $("sLat").value = s.lat ?? ""; $("sLon").value = s.lon ?? ""; $("sFixed").checked = !!s.fixed;
  $("sWiki").value = (s.wiki || []).join(", "); $("sArtist").value = s.artist || ""; $("sYear").value = s.year || "";
  $("sAddress").value = s.address || ""; $("sMatch").value = (s.match || []).join(", "); $("sType").value = s.artworkType || ""; $("sId").value = s.id || ""; $("sImage").value = s.image || "";
  $("sfMsg").textContent = ""; $("stopForm").classList.remove("hidden");
}
$("sfCancel").onclick = () => $("stopForm").classList.add("hidden");
$("sfDelete").onclick = async () => {
  if (!(await confirmDlg("Delete stop", "Delete '" + (disp(cur.model.stops[editing].title) || "this stop") + "'?", "Delete", "danger"))) return;
  cur.model.stops.splice(editing, 1); selected = -1; $("stopForm").classList.add("hidden"); markDirty(); renderStops(); drawMap(false);
};
$("sfOk").onclick = () => {
  const s = cur.model.stops[editing], lat = parseFloat($("sLat").value), lon = parseFloat($("sLon").value);
  const id = $("sId").value.trim();
  const titleV = stopTitleF.get();
  if (!titleV) return ($("sfMsg").textContent = "Enter a title.");
  if (!okLat(lat) || !okLon(lon)) return ($("sfMsg").textContent = "Enter a valid position (or drag the pin on the map).");
  if (!/^[a-z0-9_-]{1,60}$/i.test(id)) return ($("sfMsg").textContent = "Id: letters, digits, - or _ only.");
  if (cur.model.stops.some((x, j) => j !== editing && x.id === id)) return ($("sfMsg").textContent = "Another stop already uses this id.");
  const img = $("sImage").value.trim();
  if (img && !U.safeImg(img)) return ($("sfMsg").textContent = "Image must be a file in the repository (e.g. photo.jpg) or an upload.wikimedia.org link.");
  const set = (k, v) => { if (v === "" || v === false || (Array.isArray(v) && !v.length)) delete s[k]; else s[k] = v; };
  s.title = titleV; s.lat = round6(lat); s.lon = round6(lon); s.id = id;
  set("fixed", $("sFixed").checked); set("wiki", list($("sWiki").value).map((w) => w.toLowerCase())); { const tv = stopTextF.get(); if (tv) s.text = tv; else delete s.text; }
  set("artist", $("sArtist").value.trim()); set("year", $("sYear").value.trim()); set("address", $("sAddress").value.trim());
  set("match", list($("sMatch").value).map((w) => w.toLowerCase())); set("artworkType", $("sType").value); set("image", img);
  $("stopForm").classList.add("hidden"); markDirty(); renderStops(); drawMap(false);
};

$("btnAddTap").onclick = () => { addMode = !addMode; $("btnAddTap").textContent = addMode ? "Tap the map… (cancel)" : "＋ Tap on map"; if (addMode) toast("Tap the map where the new stop is."); };
$("btnAddWiki").onclick = async () => {
  const c = map.getCenter(), lang = el("select", {}, ...Src.LANGS.map((l) => el("option", { value: l, textContent: l })));
  lang.value = cur.model.lang || "en";
  const res = el("div", {}, el("p", { className: "small", textContent: "Searching around the centre of the map…" }));
  const load = async () => {
    res.replaceChildren(el("p", { className: "small", textContent: "Searching…" }));
    try {
      const hits = await Src.geosearch(lang.value, round6(c.lat), round6(c.lng), 1000);
      const have = new Set(cur.model.stops.flatMap((s) => s.wiki || []));
      res.replaceChildren(...hits.slice(0, 60).map((h) => {
        const b = el("button", { className: "pick" }, document.createTextNode(h.title), el("span", { textContent: Math.round(U.dist({ lat: c.lat, lon: c.lng }, h)) + " m" + (have.has(h.title.toLowerCase()) ? " · already in this walk" : "") }));
        b.onclick = () => { addStop({ title: h.title, lat: round6(h.lat), lon: round6(h.lon), wiki: [h.title.toLowerCase()] }, false); b.disabled = true; };
        return b;
      }));
      if (!hits.length) res.replaceChildren(el("p", { textContent: "Nothing found here." }));
    } catch (e) { res.replaceChildren(el("p", { textContent: "Search failed: " + e.message })); }
  };
  lang.onchange = load; load();
  await dialog("Nearby Wikipedia articles", [el("label", {}, "Wikipedia language", lang), el("p", { className: "small", textContent: "Tap to add as a stop. Text, photo and exact position come from the article." }), res], [{ label: "Done", value: 1, cls: "primary" }]);
};
$("btnAddSearch").onclick = async () => {
  const q = el("input", { placeholder: "Place or address", maxLength: 120 }), go = el("button", { textContent: "Search" }), res = el("div");
  go.onclick = async () => {
    const b = map.getBounds();
    try {
      const r = await fetchJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=10&q=${encodeURIComponent(q.value)}&viewbox=${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}&bounded=0`, {}, 10000);
      res.replaceChildren(...r.filter((x) => okLat(+x.lat) && okLon(+x.lon)).map((x) => {
        const name = str(x.name || String(x.display_name).split(",")[0], 120);
        const pb = el("button", { className: "pick" }, document.createTextNode(name), el("span", { textContent: str(x.display_name, 160) }));
        pb.onclick = () => { addStop({ title: name, lat: round6(+x.lat), lon: round6(+x.lon), address: str(String(x.display_name).split(",").slice(0, 2).join(","), 160) }, false); pb.disabled = true; };
        return pb;
      }));
      if (!r.length) res.replaceChildren(el("p", { textContent: "Nothing found." }));
    } catch (e) { res.replaceChildren(el("p", { textContent: "Search failed: " + e.message })); }
  };
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
  await dialog("Search a place", [el("div", { className: "two" }, q, go), el("p", { className: "small", textContent: "Search by OpenStreetMap Nominatim. Tap a result to add it." }), res], [{ label: "Done", value: 1, cls: "primary" }]);
};

// details tab
function fillDetails() {
  const m = cur.model;
  const main = Src.LANGS.includes(m.lang) ? m.lang : "en";
  $("wTitleBox").replaceChildren(mlField({ label: "Title", value: m.title, main, onInput: (v) => { m.title = v; markDirty(); $("barTitle").textContent = disp(v, main) || "Walk"; } }));
  $("wSubtitleBox").replaceChildren(mlField({ label: "Subtitle", value: m.subtitle, main, onInput: (v) => { m.subtitle = v; markDirty(); } }));
  $("wDescBox").replaceChildren(mlField({ label: "Description", value: m.description, main, multiline: true, max: 1000, onInput: (v) => { m.description = v; markDirty(); } }));
  $("wKind").value = cur.entry.kind || ""; $("wLang").value = Src.LANGS.includes(m.lang) ? m.lang : "en"; $("wFile").textContent = cur.path;
}

$("wKind").onchange = () => { cur.entry.kind = $("wKind").value || undefined; markDirty(); };
$("wLang").onchange = () => { cur.model.lang = $("wLang").value; markDirty(); fillDetails(); };

// generator tab
$("gHost").replaceChildren(...Src.ODS_HOSTS.map((h) => el("option", { value: h, textContent: h })));
function fillGen() {
  const g = cur.model.generator;
  $("gType").value = g ? g.type : "";
  $("gFields").classList.toggle("hidden", !g);
  if (!g) return;
  $("gRadius").value = g.radiusKm ?? ""; $("gLimit").value = g.limit ?? ""; $("gMin").value = g.minSitelinks ?? ""; $("gExclude").value = (g.exclude || []).join(", ");
  $("gArt").value = (g.artworkTypes || []).join(", "); $("gHost").value = g.host || Src.ODS_HOSTS[0]; $("gDataset").value = g.dataset || "";
  document.querySelectorAll(".gw").forEach((n) => n.classList.toggle("hidden", g.type !== "wikidata"));
  document.querySelectorAll(".go").forEach((n) => n.classList.toggle("hidden", g.type !== "osm-art"));
  document.querySelectorAll(".gd").forEach((n) => n.classList.toggle("hidden", g.type !== "ods"));
}
$("gType").onchange = async () => {
  const t = $("gType").value, m = cur.model;
  if (!t) { delete m.generator; cur.entry.generated = undefined; }
  else {
    if (m.stops.length && !(await confirmDlg("Generated walk", "A generated walk ignores the hand-picked stops (they're kept in the file but not shown in the app). Continue?"))) { $("gType").value = m.generator ? m.generator.type : ""; return; }
    const c = map.getCenter(); m.generator = { ...defaultGen(t, [round6(c.lat), round6(c.lng)]), ...(m.generator && m.generator.type === t ? m.generator : {}) };
    cur.entry.generated = true;
  }
  markDirty(); fillGen(); renderStops(); drawMap(false);
};
const gNum = (id, k) => ($(id).oninput = () => { const v = parseFloat($(id).value); if (isFinite(v)) cur.model.generator[k] = v; else delete cur.model.generator[k]; markDirty(); if (k === "radiusKm") drawMap(false); });
gNum("gRadius", "radiusKm"); gNum("gLimit", "limit"); gNum("gMin", "minSitelinks");
$("gExclude").oninput = () => { cur.model.generator.exclude = list($("gExclude").value).filter((q) => /^Q\d+$/.test(q)); markDirty(); };
$("gArt").oninput = () => { cur.model.generator.artworkTypes = list($("gArt").value).map((x) => x.toLowerCase()).filter((x) => /^[a-z_]+$/.test(x)); markDirty(); };
$("gHost").onchange = () => { cur.model.generator.host = $("gHost").value; markDirty(); };
$("gDataset").oninput = () => { cur.model.generator.dataset = $("gDataset").value.trim(); markDirty(); };

// ---------- save / delete a walk ----------
function canonical(m) { // stable key order, no empty values
  const keep = (o, keys) => { const r = {}; for (const k of keys) { const v = o[k]; if (v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && !v.length)) continue; r[k] = v; } return r; };
  const out = keep(m, ["schema", "id", "title", "subtitle", "description", "lang", "geocodeSuffix", "start", "generator", "matchSources"]);
  out.schema = 2;
  out.stops = (m.stops || []).map((s) => keep(s, ["id", "title", "artist", "year", "address", "lat", "lon", "fixed", "wiki", "wikipedia", "wikidata", "match", "artworkType", "image", "text", "textLang"]));
  if (Array.isArray(m.sights) && m.sights.length) out.sights = m.sights;
  for (const k of Object.keys(m)) if (!(k in out) && !["stops", "sights"].includes(k)) out[k] = m[k]; // keep fields this editor doesn't know about
  return out;
}
$("btnSaveWalk").onclick = async () => {
  const out = canonical(cur.model);
  const errs = SC.checkWalk(out);
  if (errs.length) return dialog("Please fix first", el("p", { className: "msg", textContent: errs.join("\n") }), [{ label: "OK", value: 1 }]);
  const e = cur.entry;
  const same = (a, b) => JSON.stringify(a || "") === JSON.stringify(b || "");
  const entryChanged = cur.isNew || !same(e.title, out.title) || !same(e.subtitle, out.subtitle) || (!out.generator && e.stops !== out.stops.length) || !!e.generated !== !!out.generator || cur.kindTouched;
  const msg = el("input", { value: (cur.isNew ? "Add walk " : "Update walk ") + disp(out.title, out.lang), maxLength: 200 });
  const ok = await dialog("Save walk", [el("label", {}, "Change description", msg), el("p", { className: "small", textContent: `Saves ${cur.path}${entryChanged || citiesDirty ? " and cities.json" : ""} to ${auth.repo}. The app shows the change a few minutes later, once GitHub has rebuilt the walk data.` })],
    [{ label: "Cancel", value: false }, { label: "Save", value: true, cls: "primary" }]);
  if (!ok) return;
  $("btnSaveWalk").disabled = true;
  try {
    cur.sha = await writeFile(cur.path, JSON.stringify(out, null, 2) + "\n", cur.sha, msg.value);
    cur.model = out; cur.dirty = false;
    e.title = out.title; e.subtitle = out.subtitle || "";
    if (out.generator) { e.generated = true; delete e.stops; delete e.distanceKm; } else { delete e.generated; if (e.stops !== out.stops.length) { e.stops = out.stops.length; delete e.distanceKm; } }
    if (!e.kind) delete e.kind;
    if (cur.isNew) { cur.city.walks = cur.city.walks || []; cur.city.walks.push(e); cur.isNew = false; }
    if (entryChanged || citiesDirty) await saveCities(msg.value);
    updateDirty(); renderStops(); toast("Saved ✓ GitHub now rebuilds the walk data; the app shows the change in a few minutes.", 6000);
  } catch (err) {
    await dialog("Not saved", err.message, [{ label: "OK", value: 1 }]);
  } finally { $("btnSaveWalk").disabled = false; }
};
$("wKind").addEventListener("change", () => { if (cur) cur.kindTouched = true; });
$("btnDeleteWalk").onclick = async () => {
  if (cur.isNew) { cur = null; show("vHome"); return; }
  if (!(await confirmDlg("Delete walk", `Delete '${disp(cur.model.title)}' (${cur.path}) from the repository? It's still in GitHub's history if you need it back.`, "Delete", "danger"))) return;
  try {
    const ws = cur.city.walks; ws.splice(ws.indexOf(cur.entry), 1);
    await saveCities("Remove walk " + disp(cur.model.title));   // first unlist it, so the app never points at a missing file
    await deleteFile(cur.path, cur.sha, "Delete walk " + disp(cur.model.title));
    cur = null; toast("Deleted."); show("vHome");
  } catch (e) { await dialog("Not deleted", e.message, [{ label: "OK", value: 1 }]); await loadCities(); }
};

// ---------- start ----------
(async () => {
  const a = loadAuth();
  if (a && TOKEN_RE.test(a.token || "") && REPO_RE.test(a.repo || "")) {
    $("loginMsg").textContent = "Signing in…"; $("loginMsg").className = "msg ok";
    try { await connect({ token: a.token, repo: a.repo }); return; }
    catch (e) { auth = null; try { sessionStorage.removeItem(TK); localStorage.removeItem(TK); } catch {} $("loginMsg").className = "msg"; $("loginMsg").textContent = e.message; }
  }
  show("vLogin");
})();
window.__admin = { get cur() { return cur; }, get cities() { return cities; } };
})();
