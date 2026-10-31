/* Builds a walk from its file + open data: Wikipedia/Wikidata texts and positions, mural matching,
 * walking route and sights along the way. Pure logic, no UI: used on the phone (app.js) and by the
 * GitHub build (build.mjs). Exposes window.Builder. */
(() => {
"use strict";
const U = window.Util, Src = window.Sources;
const { dbg, dist, distToLine, str, norm, sleep } = U;
const { cleanStop } = window.Schema;
const LANG_NAMES = { en: "English", nl: "Nederlands", fr: "Français", de: "Deutsch" };
async function pool(items, n, fn) { const q = items.slice(); await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await fn(q.shift()); })); }
function bboxOf(stops, m = 0.004) {
  const la = stops.map((s) => s.lat), lo = stops.map((s) => s.lon);
  return [Math.min(...la) - m, Math.min(...lo) - m * 1.4, Math.max(...la) + m, Math.max(...lo) + m * 1.4];
}
// W = cleaned walk (Schema.cleanWalk). Returns { stops, line, km, live, online }.
async function buildWalk(W, lang, log = () => {}) {
  let online = false, stops;
  if (W.generator) {
    const g = W.generator;
    try {
      stops = g.type === "wikidata" ? await Src.genWikidata(g, lang, log) : g.type === "osm-art" ? await Src.genOverpassArt(g, log) : await Src.genOds(g, log);
      const ids = new Set(); stops = stops.map((s, i) => cleanStop({ ...s, image: s.img }, i, ids));
      online = true;
    } catch (e) { dbg("generator failed", g.type, String(e)); throw new Error("Couldn't load this walk's data (" + (e.message || e) + "). Check your connection and try again."); }
    if (!stops.length) throw new Error("No places found for this walk.");
    stops = Src.orderStops(stops, W.start || { lat: g.center[0], lon: g.center[1] });
  } else stops = W.stops.map((s) => ({ ...s, links: s.links.slice() }));

  // 1. Wikipedia / Wikidata: text, photo, precise position, links
  const wikiStops = stops.filter((s) => s.wiki.length || s.wikipedia || s.wikidata);
  if (wikiStops.length) log(`Reading Wikipedia (${LANG_NAMES[lang]})…`);
  let done = 0;
  await pool(wikiStops, 4, async (s) => {
    const info = await Src.resolveWiki(s, lang).catch((e) => { dbg("resolveWiki error", s.id, String(e)); return null; });
    log(`Reading Wikipedia… ${++done}/${wikiStops.length}`);
    if (!info) { dbg("no wikipedia article for", s.id); return; }
    online = true;
    s.qid = info.qid || s.wikidata;
    if (!s.text && info.text) { s.text = info.text; s.textLang = info.lang; s.credit = `Text: Wikipedia (${info.lang}), CC BY-SA`; }
    if (info.url) s.links.unshift({ label: "Wikipedia", url: info.url });
    if (!s.img && info.img) s.img = info.img;
    if (!s.fixed && info.lat != null && !W.generator && dist(s, info) < 800) { s.lat = info.lat; s.lon = info.lon; s.src = "wikipedia"; }
    if (!s.title) s.title = info.title;
  });
  const qids = stops.map((s) => s.qid).filter(Boolean);
  if (qids.length) { const h = await Src.heritageLinks(qids); for (const s of stops) if (h[s.qid]) s.links.push(h[s.qid]); }

  // 2. Murals: match with the city's open data and OpenStreetMap
  const bb = bboxOf(stops).map((v) => v.toFixed(5)).join(",");
  let elements = [];
  try {
    log("Checking OpenStreetMap…");
    elements = await Src.overpass(`[out:json][timeout:25];(nwr["tourism"="artwork"](${bb});nwr["wikipedia"](${bb});nwr["wikidata"](${bb}););out center tags;`);
    online = true;
  } catch (e) { dbg("overpass failed", String(e)); }
  const toMatch = stops.filter((s) => s.match.length && !s.fixed);
  if (toMatch.length) {
    let cands = [];
    for (const src of W.matchSources) {
      try {
        log("Loading the city's open data…");
        const link = { label: src.sourceLabel || "City open data", url: `https://${src.host}/explore/dataset/${encodeURIComponent(src.dataset)}/` };
        cands = cands.concat((await Src.odsRecords(src)).map((r) => ({ ...r, link })));
        online = true;
      } catch (e) { dbg("ods match source failed", String(e)); }
    }
    const used = new Set(), sculpt = (t) => ["statue", "sculpture"].includes(t.artwork_type);
    for (const s of toMatch) {
      const keys = s.match.map(norm);
      let best = null, bd = 300;
      for (const c of cands) { if (used.has(c) || !keys.some((k) => c.hay.includes(k))) continue; const d = dist(s, c); if (d < bd) { bd = d; best = c; } }
      if (best) {
        used.add(best); s.lat = best.lat; s.lon = best.lon; s.src = "ods";
        s.img = s.img || best.img; s.artist = s.artist || best.artist; s.year = s.year || best.year; s.links.push(best.link); continue;
      }
      bd = 260;
      for (const a of elements) {
        const t = a.tags; if (t.tourism !== "artwork" || used.has(a.id)) continue;
        const hay = norm([t.name, t["name:fr"], t["name:nl"], t["name:en"], t.subject, t.artist_name, t.description, t.inscription].join(" "));
        if (!keys.some((k) => hay.includes(k))) continue;
        if (s.artworkType === "statue" && t.artwork_type && !sculpt(t)) continue;
        if (s.artworkType === "mural" && sculpt(t)) continue;
        const d = dist(s, a); if (d < bd) { bd = d; best = a; }
      }
      if (best) { used.add(best.id); s.lat = best.lat; s.lon = best.lon; s.src = "osm"; s.img = s.img || Src.commonsFromTags(best.tags); const l = Src.osmLink(best.id); if (l) s.links.push(l); }
    }
  }
  // 3. Geocode what's still unplaced (Nominatim, max 1 request per second)
  const todo = online && W.geocodeSuffix && !W.generator ? stops.filter((s) => !s.fixed && !s.src && s.address) : [];
  for (const s of todo) {
    log(`Locating ${s.title}…`);
    try { const p = await Src.geocode(s.address.split(/[\/(]/)[0].trim() + ", " + W.geocodeSuffix); if (p && dist(s, p) < 400) { s.lat = p.lat; s.lon = p.lon; s.src = "geocode"; } }
    catch (e) { dbg("geocode failed", s.id, String(e)); }
    await sleep(1100);
  }
  dbg("placed:", ["wikipedia", "ods", "osm", "geocode"].map((k) => k + "=" + stops.filter((s) => s.src === k).length).join(" "),
    "unplaced:", W.generator ? "-" : stops.filter((s) => !s.src && !s.fixed).map((s) => s.id).join(","));

  // 4. Walking route
  let line = null, km = null;
  if (online) try { log("Calculating the walking route…"); ({ line, km } = await Src.walkingRoute(stops)); dbg("route", km.toFixed(2), "km"); } catch (e) { dbg("route failed", String(e)); }
  line = line || stops.map((s) => ({ lat: s.lat, lon: s.lon }));

  // 5. Other sights along the way (OpenStreetMap objects linked to Wikipedia/Wikidata)
  const live = [], seen = new Set(stops.map((s) => s.qid).filter(Boolean));
  for (const e of elements) {
    const t = e.tags;
    if (t.tourism === "artwork" && !t.wikipedia && !t.wikidata) continue;
    if (t.highway || t.route || t.boundary || t.type === "route" || t.public_transport || t.railway || t.waterway || t.place) continue;
    if (!(t.historic || t.tourism || t.amenity || t.building || t.leisure || t.man_made || t.memorial || t.shop)) continue;
    const name = str(t["name:" + lang] || t["name:en"] || t.name, 120); if (!name) continue;
    const key = t.wikidata || t.wikipedia; if (seen.has(key)) continue;
    if (distToLine(e, line) > 45) continue;
    if (W.sights.some((c) => dist(c, e) < 40) || stops.some((c) => dist(c, e) < 25)) continue;
    seen.add(key);
    live.push({ title: name, lat: e.lat, lon: e.lon, wp: /^[a-z-]{2,12}:.{1,200}$/.test(t.wikipedia || "") ? t.wikipedia : null, wd: /^Q\d{1,12}$/.test(t.wikidata || "") ? t.wikidata : null });
  }
  return { stops, line, km, live: live.slice(0, 80), online };
}
// Short Wikipedia text for a sight along the way
async function sightText(s, lang) {
  if (s.text) return { text: s.text, url: s.url || null };
  if (!s.wd && !s.wp) return { text: "" };
  try {
    const info = await Src.resolveWiki({ wikidata: s.wd, wikipedia: s.wp, wiki: [], lat: s.lat, lon: s.lon }, lang);
    if (!info) return { text: "" };
    let text = info.text; if (text.length > 420) text = text.slice(0, 400).replace(/\s+\S*$/, "") + "…";
    return { text, url: info.url, lang: info.lang };
  } catch (e) { dbg("sight info failed", s.title, String(e)); return { text: "" }; }
}
window.Builder = { buildWalk, sightText, LANG_NAMES };
})();
