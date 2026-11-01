/* City Walks – phone guide for walks in Belgian cities, built from open data.
 * Content: cities.json + walk-*.json in this repository, enriched at runtime from Wikipedia, Wikidata,
 * OpenStreetMap and city open data portals (see sources.js).
 * Security: no secrets; everything external is inserted as text; links/images only from allow-listed hosts;
 * the CSP in index.html blocks everything else. */
(() => {
"use strict";
const U = window.Util, Src = window.Sources;
const { LS, LOG, LOGK, dbg, dist, bearing, distToLine, str, num, okLat, okLon, norm, sleep, hash, fetchJSON, safeUrl, safeImg } = U;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids.filter((k) => k != null)); return n; };
dbg("=== page load", navigator.userAgent, "standalone:", !!(navigator.standalone || matchMedia("(display-mode: standalone)").matches));

// ---------- state & settings ----------
const S = {
  catalog: null, city: null, entry: null, walk: null, rawHash: "", key: "",
  stops: [], sights: [], line: null, km: null,
  visited: new Set(), announced: new Set(), target: 0, focus: 0,
  pos: null, acc: 50, heading: null, headingSrc: null, follow: true,
  opts: Object.assign({ voice: true, sights: true, lang: "auto", speakNav: false, sound: true }, LS.get("bd:opts", {})), demo: null, started: false,
  mode: "nav", legs: null, nav: null, offWalk: false, cued: null,
};
const LANG_NAMES = { auto: "Automatic", en: "English", nl: "Nederlands", fr: "Français", de: "Deutsch" };
function contentLang() {
  if (S.opts.lang !== "auto" && Src.LANGS.includes(S.opts.lang)) return S.opts.lang;
  const l = (navigator.language || "en").slice(0, 2).toLowerCase();
  return Src.LANGS.includes(l) ? l : "en";
}
const saveOpts = () => LS.set("bd:opts", S.opts);

const { cleanId, strList, okPoint, cleanStop, cleanSource, cleanWalk, validFile } = window.Schema;

// ---------- map ----------
const map = L.map("map", { zoomControl: false }).setView([50.85, 4.35], 13);
map.attributionControl.setPrefix(false);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, crossOrigin: true, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
}).addTo(map);
map.on("dragstart", () => setFollow(false));
const routeLayer = L.polyline([], { color: "#111", weight: 5, opacity: .55, dashArray: "1 9", lineCap: "round" }).addTo(map);
const legLayer = L.polyline([], { color: "#1a73e8", weight: 5, opacity: .8 }).addTo(map);
const stopLayer = L.layerGroup().addTo(map), sightLayer = L.layerGroup().addTo(map);
let meMarker = null, accCircle = null;

function drawStops() {
  stopLayer.clearLayers();
  S.stops.forEach((s, i) => {
    const cls = S.visited.has(s.id) ? "seen" : i === S.target ? "cur" : "";
    const icon = L.divIcon({ className: "", html: `<div class="pin ${cls}"><span>${i + 1}</span></div>`, iconSize: [28, 28], iconAnchor: [14, 28] });
    L.marker([s.lat, s.lon], { icon, zIndexOffset: i === S.target ? 1000 : 0, title: s.title }).on("click", () => { S.focus = i; render(true); }).addTo(stopLayer);
  });
}
function drawSights() {
  sightLayer.clearLayers();
  S.sights.forEach((s) => {
    const icon = L.divIcon({ className: "", html: `<div class="sight ${s.curated ? "" : "live"}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });
    const m = L.marker([s.lat, s.lon], { icon, title: s.title }).addTo(sightLayer);
    const box = el("div", {}, el("b", { textContent: s.title }), el("br"), el("span", { className: "small", textContent: "Loading…" }));
    m.bindPopup(box, { maxWidth: 260 });
    m.on("popupopen", async () => {
      const info = await sightInfo(s);
      box.replaceChildren(el("b", { textContent: s.title }), el("br"), document.createTextNode(info.text || "No description available."));
      const u = safeUrl(info.url); if (u) box.append(el("br"), el("a", { href: u, target: "_blank", rel: "noopener noreferrer", textContent: "Wikipedia ›" }));
    });
  });
}
function drawLine() { routeLayer.setLatLngs((S.line || []).map((p) => [p.lat, p.lon])); }
function fitWalk() { if (S.stops.length) map.fitBounds(L.latLngBounds(S.stops.map((s) => [s.lat, s.lon])), { padding: [30, 30], maxZoom: 17 }); }

// ---------- load a walk: local cache → ready-made data from the GitHub build → build on the phone ----------
const CACHE_VER = 8;
const BUILT_FILE = /^[a-z0-9-]+\.[a-z]{2}\.json$/;
let builtIndex = null, builtIndexAt = 0;
async function getBuiltIndex(fresh) {
  if (!fresh && builtIndex && Date.now() - builtIndexAt < 5 * 60e3) return builtIndex;
  try { builtIndex = await fetchJSON("built/index.json", { cache: "no-cache" }, 10000); builtIndexAt = Date.now(); }
  catch (e) { dbg("no built index", String(e)); builtIndex = null; }
  return builtIndex;
}
async function loadPrebuilt(lang, fresh) {
  const idx = await getBuiltIndex(fresh);
  const entry = idx && idx.walks && idx.walks[S.city.id + "/" + S.walk.id];
  if (!entry) { dbg("prebuilt: none for", S.key); return null; }
  if (entry.hash !== S.rawHash) { dbg("prebuilt: outdated (walk changed, new build pending)"); return null; }
  const file = entry.files && entry.files[lang];
  if (!BUILT_FILE.test(file || "")) { dbg("prebuilt: no", lang, "version"); return null; }
  try {
    const raw = await fetchJSON("built/" + file, { cache: "no-cache" }, 15000);
    const b = Schema.cleanBuilt(raw);
    if (!b || b.hash !== S.rawHash || b.lang !== lang) { dbg("prebuilt: rejected", file); return null; }
    dbg("prebuilt: using", file, "built", b.builtAt);
    return b;
  } catch (e) { dbg("prebuilt failed", file, String(e)); return null; }
}
// hand-written sights from the walk file, in the chosen language when available
function curatedSights() {
  const lang = contentLang();
  return S.walk.sights.map((s) => {
    const p = s.texts ? Schema.pickText(s.texts, lang, S.walk.lang) : null, t = s.titles ? Schema.pickText(s.titles, lang, S.walk.lang) : null;
    return { ...s, text: p ? p.text : s.text, title: t ? t.text : s.title };
  });
}
function useBuilt(b) {
  S.stops = b.stops; S.line = b.line; S.km = b.km; S.legs = Schema.cleanLegs(b.legs, b.stops.length); S.nav = null;
  S.sights = curatedSights().concat(b.live || []);
}
async function build(force = false, log = () => {}) {
  const lang = contentLang(), ck = S.key + ":build";
  const cached = LS.get(ck, null);
  const okCache = cached && cached.v === CACHE_VER && cached.hash === S.rawHash && cached.lang === lang && Array.isArray(cached.stops) && cached.stops.length;
  if (okCache && !force && cached.origin === "prebuilt") { useBuilt(Schema.cleanBuilt(cached) || cached); dbg("walk from cache (prebuilt)", new Date(cached.ts).toISOString()); return; }
  log("Loading walk…");
  const pre = await loadPrebuilt(lang, force);
  if (pre) { useBuilt(pre); LS.set(ck, { ...pre, v: CACHE_VER, origin: "prebuilt", ts: Date.now() }); return; }
  if (okCache && !force) { useBuilt(cached); dbg("walk from cache (device)", new Date(cached.ts).toISOString()); return; }
  // Fallback: build on the phone, straight from the open data services
  dbg("building on the device");
  let r;
  try { r = await Builder.buildWalk(S.walk, lang, log); }
  catch (e) { dbg("build failed", String(e)); throw new Error("Couldn't load this walk's data (" + (e.message || e) + "). Check your connection and try again."); }
  const b = { hash: S.rawHash, lang, stops: r.stops, line: r.line, km: r.km, legs: r.legs, live: r.live };
  useBuilt(b);
  if (r.online) LS.set(ck, { ...b, v: CACHE_VER, origin: "device", ts: Date.now() });
  dbg("built on device", r.stops.length, "stops,", r.live.length, "sights");
}
const sightInfo = (s) => Builder.sightText(s, contentLang());

// ---------- UI ----------
function render(expand) {
  if (!S.stops.length) return;
  const f = S.stops[S.focus], arrived = S.mode === "arrived";
  $("progress").textContent = `${S.visited.size} / ${S.stops.length}`;
  $("dMeta").textContent = (arrived && S.focus === S.target ? "You're here · " : S.focus === S.target ? "Up next · " : "") + `${S.focus + 1}. ${f.title}` + (f.artist ? ` · ${f.artist}` : "") + (f.year ? ` · ${f.year}` : "") + (f.address ? ` · ${f.address}` : "");
  $("dText").textContent = f.text || "No description available yet.";
  const links = $("dLinks"); links.replaceChildren();
  if (f.textLang && f.textLang !== contentLang() && f.text) links.append(el("span", { className: "langnote", textContent: `Not available in ${LANG_NAMES[contentLang()]}; shown in ${LANG_NAMES[f.textLang] || f.textLang}` }));
  if (f.credit) links.append(el("span", { textContent: f.credit }));
  for (const l of f.links || []) { const u = safeUrl(l.url); if (u) links.append(el("a", { href: u, target: "_blank", rel: "noopener noreferrer", textContent: l.label + " ›" })); }
  $("btnSeen").textContent = S.visited.has(f.id) ? "↺ Unsee" : "✓ Seen";
  const img = $("dImg"), src = safeImg(f.img);
  if (src) { img.onerror = () => img.classList.add("hidden"); img.src = src; img.alt = f.title; img.classList.remove("hidden"); } else { img.removeAttribute("src"); img.classList.add("hidden"); }
  // arrival: stay on this stop until the walker taps Continue
  const next = nextAfter(S.target);
  $("btnContinue").classList.toggle("hidden", !(arrived && S.focus === S.target));
  $("btnContinue").textContent = next == null ? "Finish the walk ✓" : `Continue to ${next + 1}. ${S.stops[next].title} ›`;
  $("btnGo").classList.toggle("hidden", S.focus === S.target || !S.started);
  $("btnGo").textContent = `Walk to ${S.focus + 1}. ${f.title} ›`;
  $("sheet").classList.toggle("arrived", arrived);
  if (expand) $("sheet").classList.remove("collapsed");
  drawStops(); updateNav(); renderList();
}
function renderList() {
  const ol = $("stopList"); ol.replaceChildren();
  S.stops.forEach((s, i) => {
    const li = el("li", { textContent: s.title + (s.artist ? ` — ${s.artist}` : "") });
    if (S.visited.has(s.id)) li.classList.add("seen"); if (i === S.target) li.classList.add("cur");
    li.onclick = () => { $("menu").classList.add("hidden"); goTo(i); map.setView([s.lat, s.lon], 17); setFollow(false); };
    ol.appendChild(li);
  });
}
// ---------- turn-by-turn navigation ----------
// The walk's legs (stop i-1 → stop i) come ready-made from the build; from elsewhere (start, off route, a stop
// chosen out of order) a route is requested live, at most every 20 s.
const legSource = () => (S.legs && S.target > 0 && S.legs[S.target - 1] && !S.offWalk) ? "walk" : "live";
function ensureLeg() {
  const want = legSource() + ":" + S.target;
  if (S.nav && S.nav.key === want) return S.nav;
  if (want.startsWith("walk")) { S.nav = { key: want, P: Nav.prepare(S.legs[S.target - 1]), hint: 0, offCount: 0 }; dbg("nav: walk leg to", S.stops[S.target].id); return S.nav; }
  S.nav = null; requestLiveLeg(); return null;
}
async function requestLiveLeg(force) {
  const now = Date.now(), t = S.stops[S.target], target = S.target;
  if (!S.pos || S.liveBusy || (S.liveAt && now - S.liveAt < (force ? 5000 : 20000))) return;
  S.liveBusy = true; S.liveAt = now;
  try {
    const r = await Src.walkingRoute([S.pos, t]);
    if (S.target !== target || !r.legs || !r.legs[0]) return;
    S.nav = { key: "live:" + target, P: Nav.prepare(r.legs[0]), hint: 0, offCount: 0 };
    dbg("nav: live route to", t.id, Math.round(r.km * 1000) + "m");
    updateNav();
  } catch (e) { dbg("nav: live route failed", String(e)); }
  finally { S.liveBusy = false; }
}
function setNavIcon(glyph, rot, cls) {
  const a = $("arrow"); a.textContent = glyph; a.style.transform = `rotate(${rot}deg)`;
  $("arrowWrap").className = cls || "";
}
function updateNav() {
  if (!S.stops.length) return;
  const t = S.stops[S.target], lang = contentLang(), W = Nav.words(lang);
  if (S.mode === "arrived") {
    setNavIcon("⚑", 0, "here");
    $("navLabel").textContent = "You've arrived";
    $("navTitle").textContent = `${S.target + 1}. ${t.title}`;
    $("navDist").textContent = "Take your time: the story is below. Tap Continue when you're ready.";
    legLayer.setLatLngs([]); return;
  }
  if (!S.pos) { setNavIcon("➤", -90, ""); $("navLabel").textContent = "Next stop"; $("navTitle").textContent = `${S.target + 1}. ${t.title}`; $("navDist").textContent = "Waiting for GPS…"; legLayer.setLatLngs([]); return; }
  const dStop = dist(S.pos, t), stopLine = `${S.target + 1}. ${t.title} · ${Nav.fmt(dStop)} · ~${Math.max(1, Math.round(dStop * 1.3 / 80))} min`;
  const nav = ensureLeg();
  if (nav) {
    const loc = Nav.locate(nav.P, S.pos, nav.hint);
    const tol = Math.max(35, Math.min(60, S.acc * 1.2));
    const off = loc.off > tol;
    if (off) { nav.offCount++; if (nav.offCount >= 3) { if (nav.offCount === 3) dbg("nav: off route", Math.round(loc.off) + "m"); S.offWalk = true; requestLiveLeg(loc.off > 150); } }
    else { nav.offCount = 0; nav.hint = loc.seg; }
    if (!off || nav.offCount < 3) { // on the route (or only briefly off it): turn-by-turn
      const up = Nav.upcoming(nav.P, loc.along);
      const ic = Nav.icon(up.step);
      setNavIcon(ic.glyph, ic.rot, up.dist < 30 ? "soon" : "");
      $("navLabel").textContent = up.step.t === "arrive" ? W.in(Nav.fmt(up.dist)) : up.dist < 30 ? W.now : W.in(Nav.fmt(up.dist));
      $("navTitle").textContent = Nav.text(up.step, lang, t.title);
      $("navDist").textContent = "Next stop: " + stopLine;
      // remaining part of this leg in blue
      const rest = [[S.pos.lat, S.pos.lon]].concat(nav.P.pts.slice(loc.seg + 1).map((p) => [p.lat, p.lon]));
      legLayer.setLatLngs(rest);
      announce(up, t, lang);
      return;
    }
  }
  // fallback: compass arrow straight to the stop
  const b = bearing(S.pos, t), rel = S.heading == null ? b : b - S.heading;
  setNavIcon("➤", rel - 90, dStop < arriveRadius() ? "here" : "");
  $("navLabel").textContent = "Next stop (follow the arrow" + (S.heading == null ? ", north is up)" : ")");
  $("navTitle").textContent = `${S.target + 1}. ${t.title}`;
  $("navDist").textContent = `${Nav.fmt(dStop)} · ~${Math.max(1, Math.round(dStop * 1.3 / 80))} min walk`;
  legLayer.setLatLngs([[S.pos.lat, S.pos.lon], [t.lat, t.lon]]);
}
// Cue once per manoeuvre, ~25 m before it: buzz/haptic + chime, and spoken if enabled
function announce(up, t, lang) {
  if (up.step.t === "arrive" || up.dist > 28) return;
  const k = S.nav.key + ":" + up.step.along.toFixed(0);
  if (S.cued === k) return;
  S.cued = k;
  cue("turn");
  const line = Nav.text(up.step, lang, t.title);
  dbg("nav: cue", line);
  if (S.opts.speakNav && synth && !synth.speaking) speakNow(line, lang);
}
const arriveRadius = () => Math.max(25, Math.min(45, S.acc * 0.8));

let toastTimer = null;
function toast(parts, ms = 9000, onclick = null) {
  const box = $("toast"); box.replaceChildren();
  for (const [kind, text] of parts) box.append(kind === "br" ? el("br") : el(kind === "b" ? "b" : "span", { className: kind === "more" ? "tmore" : "", textContent: text }));
  box.classList.remove("hidden");
  box.onclick = () => { box.classList.add("hidden"); onclick && onclick(); };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.add("hidden"), ms);
}
const msg = (text, ms) => toast([["t", text]], ms);

// ---------- speech (iOS: first speak() inside a tap, no speak() right after cancel(), silent switch mutes it) ----------
const synth = window.speechSynthesis || null;
let voices = [], speakingNow = false;
function loadVoices() { if (synth) { voices = synth.getVoices(); dbg("voices:", voices.length); } }
if (synth) { loadVoices(); synth.addEventListener?.("voiceschanged", loadVoices); }
function pickVoice(lang) {
  const re = new RegExp("^" + lang, "i"), list = voices.filter((v) => re.test(v.lang));
  const pref = { en: /en[-_]GB/i, nl: /nl[-_]BE/i, fr: /fr[-_]BE/i }[lang];
  return (pref && (list.find((v) => pref.test(v.lang) && v.localService) || list.find((v) => pref.test(v.lang)))) || list.find((v) => v.localService) || list[0] || null;
}
function setSpeakBtn() { $("btnSpeak").textContent = speakingNow ? "■ Stop" : "🔊 Read"; }
function stopSpeech() { if (synth) synth.cancel(); speakingNow = false; setSpeakBtn(); }
function speakNow(text, lang = "en") {
  if (!synth) { dbg("speech: not supported"); msg("Read aloud isn't supported in this browser."); return; }
  const parts = text.match(/[^.!?]+[.!?]+["')]*\s*|[^.!?]+$/g) || [text];
  const v = pickVoice(lang); let started = false;
  dbg("speech: speak", parts.length, "parts, lang", lang, "voice:", v ? v.name + "/" + v.lang : "default", { speaking: synth.speaking, pending: synth.pending, paused: synth.paused });
  try { synth.resume(); } catch {}
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p.trim());
    if (v) u.voice = v; u.lang = v ? v.lang : lang; u.rate = 1; u.volume = 1;
    u.onstart = () => { if (!started) dbg("speech: started"); started = true; speakingNow = true; setSpeakBtn(); };
    u.onerror = (e) => {
      dbg("speech: error", e.error); speakingNow = false; setSpeakBtn();
      if (i === 0 && e.error !== "interrupted" && e.error !== "canceled") { started = true; msg("Read aloud failed (" + e.error + "). Tap Read to try again.", 8000); }
    };
    if (i === parts.length - 1) u.onend = () => { dbg("speech: ended"); speakingNow = false; setSpeakBtn(); };
    synth.speak(u);
  });
  speakingNow = true; setSpeakBtn();
  setTimeout(() => { if (!started) { dbg("speech: did not start after 2.5s"); speakingNow = false; setSpeakBtn(); msg("No sound? On iPhone, turn off the silent switch and turn up the volume, then tap Read again.", 9000); } }, 2500);
}
const stopSpeechText = (s) => `${s.title}. ${s.text || ""}`;
const stopLang = (s) => s.textLang || (S.walk && S.walk.lang) || "en";
function speak(s) {
  if (!S.opts.voice || !synth) return;
  if (synth.speaking || synth.pending) { synth.cancel(); setTimeout(() => speakNow(stopSpeechText(s), stopLang(s)), 300); } else speakNow(stopSpeechText(s), stopLang(s));
}
// ---------- cues: vibration (Android), haptic tick (iPhone, iOS 18+) and a short chime ----------
// iPhones don't support navigator.vibrate in any browser. Two workarounds: a sound, and the haptic tick iOS 18+
// gives when a switch control is toggled (best effort; Apple may change this).
let audioCtx = null, hapticLabel = null;
function unlockCues() { // must run inside a tap
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === "suspended") audioCtx.resume(); } catch (e) { dbg("audio unavailable", String(e)); }
  if (!hapticLabel) {
    const inp = el("input", { type: "checkbox", id: "hapticSwitch", tabIndex: -1 }); inp.setAttribute("switch", "");
    hapticLabel = el("label", { htmlFor: "hapticSwitch", className: "offscreen", ariaHidden: "true" }, inp);
    document.body.append(hapticLabel);
  }
  dbg("cues: vibrate", "vibrate" in navigator ? "supported" : "not supported (iPhone)", "· audio", audioCtx ? audioCtx.state : "none");
}
function chime(kind) {
  if (!audioCtx || !S.opts.sound) return;
  try {
    if (audioCtx.state === "suspended") audioCtx.resume();
    const notes = kind === "arrive" ? [660, 880, 1320] : kind === "sight" ? [990] : [880, 1175];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t0 = audioCtx.currentTime + i * 0.13;
      o.type = "sine"; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
      o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.27);
    });
  } catch (e) { dbg("chime failed", String(e)); }
}
function cue(kind) {
  const pattern = kind === "arrive" ? [250, 120, 250, 120, 400] : kind === "sight" ? [80] : [150, 80, 150];
  let ok = false;
  try { if (navigator.vibrate) ok = navigator.vibrate(pattern); } catch {}
  if (!ok && hapticLabel) { try { const n = kind === "arrive" ? 3 : kind === "sight" ? 1 : 2; for (let i = 0; i < n; i++) setTimeout(() => hapticLabel.click(), i * 160); } catch {} }
  chime(kind);
}
const buzz = () => cue("sight");
function setFollow(on) { S.follow = on; $("btnLocate").classList.toggle("on", on); if (on && S.pos) map.panTo([S.pos.lat, S.pos.lon]); }

// ---------- position ----------
function onPos(lat, lon, acc, gpsHeading, speed) {
  if (!okLat(lat) || !okLon(lon)) return;
  S.pos = { lat, lon }; S.acc = acc || 30;
  const ll = [lat, lon];
  if (!meMarker) {
    meMarker = L.marker(ll, { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 2000, keyboard: false }).addTo(map);
    accCircle = L.circle(ll, { radius: S.acc, color: "#1a73e8", weight: 1, fillOpacity: .08 }).addTo(map);
  } else { meMarker.setLatLng(ll); accCircle.setLatLng(ll).setRadius(S.acc); }
  if (!S.started || !S.stops.length) return;
  const now = Date.now();
  if (!S.demo && (!S.lastLog || now - S.lastLog > 20000)) { S.lastLog = now; dbg("gps", lat.toFixed(5), lon.toFixed(5), "acc", Math.round(acc), "heading", S.heading == null ? "-" : Math.round(S.heading) + "(" + S.headingSrc + ")", "target", S.stops[S.target].id, Math.round(dist(S.pos, S.stops[S.target])) + "m"); }
  if (S.headingSrc !== "compass" && gpsHeading != null && !isNaN(gpsHeading) && speed > 0.7) { S.heading = gpsHeading; S.headingSrc = "gps"; }
  if (S.follow) map.panTo(ll, { animate: true });
  checkArrival(); checkSights(); updateNav();
}
function nextAfter(i) {
  for (let k = 1; k < S.stops.length; k++) { const j = i + k; if (j >= S.stops.length) break; if (!S.visited.has(S.stops[j].id)) return j; }
  for (let j = 0; j < i; j++) if (!S.visited.has(S.stops[j].id)) return j;
  return null;
}
function checkArrival() {
  if (S.mode === "arrived") return;
  const i = S.target, t = S.stops[i];
  if (dist(S.pos, t) > arriveRadius()) return;
  S.visited.add(t.id); LS.set(S.key + ":visited", [...S.visited]);
  dbg("arrived", t.id, "dist", Math.round(dist(S.pos, t)), "radius", Math.round(arriveRadius()));
  S.mode = "arrived"; S.focus = i; S.offWalk = false;
  cue("arrive");
  speak(t); render(true);
  $("sheet").scrollTop = 0;
}
function continueWalk() {
  stopSpeech();
  const next = nextAfter(S.target);
  if (next == null) { S.mode = "done"; toast([["b", "🎉 Walk finished! "], ["t", "Well walked."]], 8000); dbg("walk finished"); render(false); $("sheet").classList.add("collapsed"); return; }
  S.mode = "nav"; S.target = S.focus = next; S.nav = null; S.offWalk = false; S.cued = null;
  $("sheet").classList.add("collapsed");
  render(false); setFollow(true);
  if (S.pos) map.setView([S.pos.lat, S.pos.lon], Math.max(map.getZoom(), 18));
}
function checkSights() {
  if (!S.opts.sights) return;
  for (const s of S.sights) {
    const k = s.title + s.lat;
    if (S.announced.has(k) || dist(S.pos, s) > 35) continue;
    S.announced.add(k);
    sightInfo(s).then((info) => {
      if (!info.text) return;
      const url = safeUrl(info.url); buzz();
      toast([["b", "On your way: "], ["t", s.title], ["br"], ["t", info.text]].concat(url ? [["more", "Tap to open on Wikipedia"]] : []), 14000,
        url ? () => window.open(url, "_blank", "noopener,noreferrer") : null);
    });
    break;
  }
}
function firstUnvisited(from) {
  for (let k = 0; k < S.stops.length; k++) { const i = (from + k) % S.stops.length; if (!S.visited.has(S.stops[i].id)) return i; }
  return S.stops.length - 1;
}
let gpsOn = false;
function startGPS() {
  if (gpsOn) return; gpsOn = true;
  if (!("geolocation" in navigator)) { msg("This browser has no GPS access."); return; }
  navigator.geolocation.watchPosition(
    (p) => { if (!S.demo) onPos(p.coords.latitude, p.coords.longitude, p.coords.accuracy, p.coords.heading, p.coords.speed); },
    (e) => { dbg("gps error", e.code, e.message); msg(e.code === 1 ? "Location permission denied. Enable it for this site in your browser settings." : "Can't get your location right now…", 8000); },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
}
let compassOn = false;
function startCompass() {
  if (compassOn) return; compassOn = true;
  const handler = (e) => {
    let h = null;
    if (e.webkitCompassHeading != null) h = e.webkitCompassHeading; else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
    if (h == null) return;
    const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    if (S.headingSrc !== "compass") dbg("compass active", e.webkitCompassHeading != null ? "ios" : "absolute");
    S.heading = (h + so + 360) % 360; S.headingSrc = "compass"; updateNav();
  };
  const go = () => window.addEventListener("ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation", handler, true);
  if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission().then((r) => { dbg("compass permission", r); r === "granted" && go(); }).catch((e) => dbg("compass permission error", String(e)));
  } else go();
}
async function keepAwake() { try { await navigator.wakeLock?.request("screen"); } catch {} }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.started) keepAwake(); });

function startDemo() {
  const pts = S.line && S.line.length > 1 ? S.line : S.stops.map((s) => ({ lat: s.lat, lon: s.lon }));
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  let d = 0, seg = 0;
  S.demo = setInterval(() => {
    d += 6;
    if (d >= cum[cum.length - 1]) { clearInterval(S.demo); S.demo = null; return; }
    while (cum[seg + 1] < d) seg++;
    const A = pts[seg], B = pts[seg + 1], f = (d - cum[seg]) / ((cum[seg + 1] - cum[seg]) || 1);
    S.heading = bearing(A, B); S.headingSrc = "demo";
    onPos(A.lat + (B.lat - A.lat) * f, A.lon + (B.lon - A.lon) * f, 8, null, 0);
  }, 400);
}

// ---------- start screen: cities and walks ----------
const KIND = { comics: "Comic strips", "street-art": "Street art", heritage: "Heritage", highlights: "Highlights" };
// text in the chosen language from a multilingual value (string or { en, nl, … })
function tl(v, fallbackLang) {
  if (v && typeof v === "object") { const p = Schema.pickText(v, contentLang(), fallbackLang || "en"); return p ? p.text : ""; }
  return v || "";
}
function showWalkTexts() {
  if (!S.walk) return;
  const i = S.walk.i18n || {};
  $("brand").textContent = (i.title ? tl(i.title, S.walk.lang) : S.walk.title) || "City Walk";
  $("walkDesc").textContent = i.description ? tl(i.description, S.walk.lang) : S.walk.description;
}
async function loadCatalog() {
  let c = null;
  try { c = await fetchJSON("cities.json", { cache: "no-cache" }, 15000); } catch (e) { dbg("cities.json failed", String(e)); }
  const cities = (c && Array.isArray(c.cities) ? c.cities : []).map((x) => ({
    id: cleanId(x.id, "city"), name: Schema.cleanTexts(x.name, 60) || str(x.name, 60), lat: x.lat, lon: x.lon,
    walks: (Array.isArray(x.walks) ? x.walks : []).filter((w) => w && validFile(w.file)).map((w) => ({
      id: cleanId(w.id, "walk"), file: w.file, title: Schema.cleanTexts(w.title, 120) || str(w.title, 120), subtitle: Schema.cleanTexts(w.subtitle, 160) || str(w.subtitle, 160), kind: KIND[w.kind] ? w.kind : null,
      distanceKm: num(w.distanceKm), stops: num(w.stops), generated: !!w.generated,
    })),
  })).filter((x) => x.walks.length);
  S.catalog = cities;
  if (c?.title) { $("siteTitle").textContent = str(c.title, 80); document.title = str(c.title, 80); }
  if (!cities.length) { $("walkList").replaceChildren(el("p", { textContent: "Couldn't load the list of walks. Check your connection and reload." })); return; }
  const chips = $("cityList"); chips.replaceChildren();
  for (const city of cities) { const b = el("button", { className: "chip", textContent: tl(city.name) }); b.dataset.id = city.id; b.onclick = () => selectCity(city); chips.append(b); }
  const [hc, hw] = location.hash.slice(1).split("--");
  const city = cities.find((x) => x.id === hc) || cities.find((x) => x.id === LS.get("bd:lastCity", "")) || cities[0];
  selectCity(city, hw || LS.get("bd:lastWalk:" + city.id, ""));
}
function selectCity(city, walkId) {
  S.city = city; LS.set("bd:lastCity", city.id);
  document.querySelectorAll("#cityList .chip").forEach((b) => b.classList.toggle("sel", b.dataset.id === city.id));
  const list = $("walkList"); list.replaceChildren();
  for (const w of city.walks) {
    const info = [w.kind && KIND[w.kind], isFinite(w.stops) ? `${w.stops} stops` : w.generated ? "built live from open data" : "", isFinite(w.distanceKm) ? `~${w.distanceKm} km` : ""].filter(Boolean).join(" · ");
    const b = el("button", { className: "walk" }, el("b", { textContent: tl(w.title) }), el("span", { textContent: [tl(w.subtitle), info].filter(Boolean).join(" · ") }));
    b.dataset.id = w.id; b.onclick = () => selectWalk(w); list.append(b);
  }
  if (okLat(city.lat) && okLon(city.lon)) map.setView([city.lat, city.lon], 14);
  selectWalk(city.walks.find((w) => w.id === walkId) || city.walks[0]);
}
async function selectWalk(w) {
  S.entry = w;
  document.querySelectorAll(".walk").forEach((b) => b.classList.toggle("sel", b.dataset.id === w.id));
  $("btnStart").disabled = $("btnDemo").disabled = true; $("walkDesc").textContent = ""; $("prep").textContent = "";
  stopLayer.clearLayers(); sightLayer.clearLayers(); routeLayer.setLatLngs([]);
  try {
    const raw = await fetchJSON(w.file, { cache: "no-cache" }, 15000);
    if (S.entry !== w) return;
    const walk = cleanWalk(raw);
    S.walk = walk; S.rawHash = hash(JSON.stringify(raw)); S.key = "bd:" + S.city.id + ":" + walk.id;
    S.stops = walk.stops.map((s) => ({ ...s })); S.sights = walk.sights.map((s) => ({ ...s })); S.line = null;
    S.visited = new Set(LS.get(S.key + ":visited", [])); S.announced = new Set(); S.target = S.focus = 0;
    showWalkTexts();
    $("btnStart").disabled = $("btnDemo").disabled = false;
    LS.set("bd:lastWalk:" + S.city.id, w.id);
    history.replaceState(null, "", "#" + S.city.id + "--" + w.id);
    if (S.stops.length) { drawStops(); fitWalk(); } else if (walk.generator) map.setView(walk.generator.center, 15);
    dbg("walk selected", S.key, S.stops.length, "stops", walk.generator ? "generator " + walk.generator.type : "");
  } catch (e) { dbg("walk load failed", w.file, String(e)); $("walkDesc").textContent = "This walk couldn't be loaded (" + e.message + ")."; }
}

async function begin(demo) {
  S.opts.voice = $("optVoice").checked; S.opts.lang = $("optLang").value; saveOpts();
  dbg("start", S.key, demo ? "demo" : "gps", "voice:", S.opts.voice, "lang:", contentLang());
  if (synth) { try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; synth.speak(u); } catch (e) { dbg("speech unlock failed", String(e)); } }
  unlockCues();
  if (!demo) { startCompass(); startGPS(); keepAwake(); }
  $("btnStart").disabled = $("btnDemo").disabled = true;
  try { await build(false, (m) => ($("prep").textContent = m)); }
  catch (e) { dbg("build error", String(e)); $("prep").textContent = e.message; $("btnStart").disabled = $("btnDemo").disabled = false; return; }
  $("prep").textContent = "";
  S.visited = new Set([...S.visited].filter((id) => S.stops.some((s) => s.id === id)));
  S.target = S.focus = firstUnvisited(0); S.started = true; S.mode = "nav"; S.nav = null; S.offWalk = false; S.cued = null;
  $("start").classList.add("hidden"); $("sheet").classList.remove("hidden"); $("progress").classList.remove("hidden");
  drawLine(); drawSights(); render(false); fitWalk();
  if (S.pos) { checkArrival(); updateNav(); }
  if (demo) { setFollow(true); startDemo(); msg("Demo: you're walking the route virtually. Reload the page to stop.", 6000); }
}

// ---------- wiring ----------
function fillLang(sel) { sel.replaceChildren(...Object.entries(LANG_NAMES).map(([v, t]) => el("option", { value: v, textContent: v === "auto" ? `${t} (${LANG_NAMES[contentLang()] || "English"})` : t }))); sel.value = S.opts.lang; }
fillLang($("optLang"));
$("optLang").onchange = () => {
  S.opts.lang = $("optLang").value; saveOpts();
  document.querySelectorAll("#cityList .chip").forEach((b) => { const c = S.catalog.find((x) => x.id === b.dataset.id); if (c) b.textContent = tl(c.name); });
  if (S.city) selectCity(S.city, S.entry && S.entry.id);
};
$("btnStart").onclick = () => begin(false);
$("btnDemo").onclick = () => begin(true);
$("optVoice").checked = S.opts.voice;
$("btnLocate").onclick = () => setFollow(true);
$("grab").onclick = $("nav").onclick = () => $("sheet").classList.toggle("collapsed");
$("btnPrev").onclick = () => { S.focus = (S.focus - 1 + S.stops.length) % S.stops.length; render(true); };
$("btnNext").onclick = () => { S.focus = (S.focus + 1) % S.stops.length; render(true); };
$("btnSpeak").onclick = (e) => {
  e.stopPropagation();
  if (speakingNow || (synth && synth.speaking)) { dbg("speech: stop by user"); stopSpeech(); return; }
  const f = S.stops[S.focus]; speakNow(stopSpeechText(f), stopLang(f)); // no cancel()/await first: keeps iOS happy
};
function goTo(i) {
  stopSpeech(); S.target = S.focus = i; S.mode = "nav"; S.nav = null; S.offWalk = false; S.cued = null;
  dbg("nav: walking to", S.stops[i].id); render(true);
}
$("btnContinue").onclick = (e) => { e.stopPropagation(); continueWalk(); };
$("btnGo").onclick = (e) => { e.stopPropagation(); goTo(S.focus); $("sheet").classList.add("collapsed"); setFollow(true); };
$("btnSeen").onclick = () => {
  const f = S.stops[S.focus];
  if (S.visited.has(f.id)) S.visited.delete(f.id); else S.visited.add(f.id);
  LS.set(S.key + ":visited", [...S.visited]);
  if (S.visited.has(S.stops[S.target].id)) S.target = firstUnvisited(S.target);
  render(true);
};
$("btnMenu").onclick = () => {
  $("optVoice2").checked = S.opts.voice; $("optSights").checked = S.opts.sights; $("optSpeakNav").checked = S.opts.speakNav; $("optSound").checked = S.opts.sound; fillLang($("optLang2"));
  renderList(); $("menu").classList.remove("hidden");
};
async function rebuild(force) {
  try { await build(force, (m) => ($("btnRefresh").textContent = m)); } catch (e) { msg(e.message, 8000); }
  $("btnRefresh").textContent = "Refresh walk data";
  S.target = Math.min(S.target, S.stops.length - 1); S.focus = Math.min(S.focus, S.stops.length - 1);
  drawLine(); drawSights(); render(false);
}
$("btnClose").onclick = async () => {
  S.opts.voice = $("optVoice2").checked; S.opts.sights = $("optSights").checked; S.opts.speakNav = $("optSpeakNav").checked; S.opts.sound = $("optSound").checked;
  const langChanged = $("optLang2").value !== S.opts.lang; S.opts.lang = $("optLang2").value; saveOpts();
  $("menu").classList.add("hidden");
  if (langChanged) showWalkTexts();
  if (langChanged && S.started) { msg("Loading texts in " + LANG_NAMES[contentLang()] + "…", 4000); await rebuild(false); }
};
$("btnOtherWalk").onclick = () => {
  if (S.demo) { clearInterval(S.demo); S.demo = null; }
  stopSpeech(); S.started = false; S.mode = "nav"; S.nav = null;
  $("menu").classList.add("hidden"); $("sheet").classList.add("hidden"); $("progress").classList.add("hidden"); $("start").classList.remove("hidden");
  legLayer.setLatLngs([]); fillLang($("optLang"));
  if (S.city) selectCity(S.city, S.entry && S.entry.id);
};
$("btnDebug").onclick = () => {
  dbg("debug view opened", { walk: S.key, visited: S.visited.size, heading: S.headingSrc || "none", speech: !!synth, voices: voices.length, sw: !!navigator.serviceWorker?.controller, lang: contentLang() });
  LS.set(LOGK, LOG); $("logText").value = LOG.join("\n");
  $("menu").classList.add("hidden"); $("debug").classList.remove("hidden"); $("logText").scrollTop = 1e9;
};
$("btnCopyLog").onclick = async () => {
  const ta = $("logText");
  try { await navigator.clipboard.writeText(ta.value); $("btnCopyLog").textContent = "Copied ✓"; }
  catch { ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length); try { document.execCommand("copy"); $("btnCopyLog").textContent = "Copied ✓"; } catch { $("btnCopyLog").textContent = "Select & copy manually"; } }
  setTimeout(() => ($("btnCopyLog").textContent = "Copy log"), 2500);
};
$("btnTestCues").onclick = () => { unlockCues(); cue("turn"); setTimeout(() => cue("arrive"), 900); };
$("btnTestSpeech").onclick = () => {
  stopSpeech(); const l = contentLang();
  speakNow({ nl: "Hallo. Dit is een test van de voorleesfunctie.", fr: "Bonjour. Ceci est un test de la lecture à voix haute.", de: "Hallo. Dies ist ein Test der Vorlesefunktion." }[l] || "Hello. This is a speech test.", l);
};
$("btnTestSources").onclick = async () => {
  const b = $("btnTestSources"); b.disabled = true; b.textContent = "Testing…";
  const out = (line) => { dbg("selftest", line); $("logText").value = LOG.join("\n"); $("logText").scrollTop = 1e9; };
  out("start"); await Src.selfTest(out); out("done");
  b.disabled = false; b.textContent = "Test data sources";
};
$("btnClearLog").onclick = () => { LOG.length = 0; LS.set(LOGK, LOG); $("logText").value = ""; };
$("btnCloseDebug").onclick = () => $("debug").classList.add("hidden");
$("btnReset").onclick = () => { S.visited.clear(); LS.set(S.key + ":visited", []); S.announced.clear(); goTo(0); };
$("btnRefresh").onclick = () => { $("btnRefresh").textContent = "Refreshing…"; rebuild(true); };

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").then(() => dbg("service worker registered")).catch((e) => dbg("sw failed", String(e)));
}
loadCatalog();
window.__bd = { S, onPos, build };
})();
